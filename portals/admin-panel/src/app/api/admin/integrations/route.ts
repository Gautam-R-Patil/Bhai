// Rotate Convex prod env vars from the admin panel UI.
// ⚠ This route shell-spawns `npx convex env set NAME VALUE` with the prod
//   deploy key. Strict guarantees enforced server-side:
//   - super_admin role required
//   - env var name must be in INTEGRATION_KEYS (no arbitrary names)
//   - value passed as a separate argv element to spawn (NO shell interpolation)
//   - never echoes the value back to the client
//
// GET: lists which integration keys are CURRENTLY SET on the Convex deployment
//      (response includes `name` and `present: boolean` only; values are never
//       returned to the browser).
// POST: { name, value } — sets/rotates the named env var.

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { guard } from "@/lib/route-guards";

// Allowlist of env vars manageable from the panel. Keep in sync with the
// rows rendered on settings/page.tsx::Server-side integrations.
const INTEGRATION_KEYS = new Set([
  "OPENROUTER_API_KEY",
  "HCAPTCHA_SECRET",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "WAITLIST_NOTIFY_EMAIL",
  "WAITLIST_NOTIFY_FROM",
  "ADMIN_API_KEY",
  "OTPLESS_CLIENT_ID",
  "OTPLESS_CLIENT_SECRET",
  "OTPLESS_APP_ID",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "HF_TOKEN",
  "NOPECHA_API_KEY",
  "CAPTCHA_API_KEY",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "GH_TOKEN",
]);

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Resolve the repo root from this file so we always run `npx convex` against
// the same convex/ directory regardless of where Next.js was started.
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

function deployKey(): string | null {
  return process.env.CONVEX_PROD_DEPLOY_KEY?.trim() || null;
}

interface RunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runConvex(args: string[], extraEnv?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["convex", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(extraEnv ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
      });
    });
    child.on("error", (err) => {
      resolve({ ok: false, exitCode: -1, stdout: "", stderr: err.message });
    });
  });
}

export async function GET(request: NextRequest) {
  // F12: route every state-checking endpoint through guard() so origin
  // allowlist + body-size cap (and future hardening) is enforced uniformly.
  // Permission check stays inline because guard()'s `permission` is role-based
  // via hasPermission(); the super_admin role check is a different axis.
  const g = await guard(request, { allowAnyBodySize: true });
  if (!g.ok) return g.response;
  const session = g.session;
  if (session.role !== "super_admin") {
    return NextResponse.json(
      { error: "Forbidden: super_admin role required to view integrations" },
      { status: 403 },
    );
  }

  const key = deployKey();
  if (!key) {
    return NextResponse.json(
      { error: "CONVEX_PROD_DEPLOY_KEY not configured on the admin server" },
      { status: 500 },
    );
  }

  // `convex env list` prints `NAME=value` lines. We only return whether each
  // allowlisted key is present (truthy) — never its value.
  const res = await runConvex(["env", "list"], { CONVEX_DEPLOY_KEY: key });
  if (!res.ok) {
    return NextResponse.json(
      { error: "Failed to list env", stderr: res.stderr.slice(0, 500) },
      { status: 500 },
    );
  }

  const present = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (INTEGRATION_KEYS.has(name) && value.length > 0) present.add(name);
  }

  const integrations = Array.from(INTEGRATION_KEYS).map((name) => ({
    name,
    present: present.has(name),
  }));

  return NextResponse.json({ integrations });
}

export async function POST(request: NextRequest) {
  // F12: see GET — guard() enforces origin allowlist + body cap.
  const g = await guard(request);
  if (!g.ok) return g.response;
  const session = g.session;
  if (session.role !== "super_admin") {
    return NextResponse.json(
      { error: "Forbidden: super_admin role required to rotate integrations" },
      { status: 403 },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";

  if (!ENV_NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid env var name" }, { status: 400 });
  }
  if (!INTEGRATION_KEYS.has(name)) {
    return NextResponse.json({ error: "Env var not in allowlist" }, { status: 403 });
  }
  // No length-zero values — use the explicit "remove" action instead. Also
  // cap to a sensible size so a typo can't push 10MB into env state.
  if (value.length === 0) {
    return NextResponse.json(
      { error: "Empty values are not allowed (use the remove action)" },
      { status: 400 },
    );
  }
  if (value.length > 4096) {
    return NextResponse.json({ error: "Value too long (max 4096 chars)" }, { status: 400 });
  }
  // NUL bytes get truncated by execvp on the child side, so the saved env
  // var wouldn't be what the admin typed. Reject explicitly so the failure
  // mode is "400 on submit" rather than "silently saved the wrong value".
  if (value.includes("\0")) {
    return NextResponse.json({ error: "Value contains NUL byte" }, { status: 400 });
  }

  const key = deployKey();
  if (!key) {
    return NextResponse.json(
      { error: "CONVEX_PROD_DEPLOY_KEY not configured on the admin server" },
      { status: 500 },
    );
  }

  // spawn() with argv array — `value` is NEVER interpolated into a shell string.
  const res = await runConvex(["env", "set", name, value], { CONVEX_DEPLOY_KEY: key });
  if (!res.ok) {
    // Log full stderr server-side for debugging, but never echo it (or any
    // substring that might contain the value) back to the browser.
    console.error(
      `[integrations] convex env set ${name} failed (exit=${res.exitCode}):`,
      res.stderr.slice(0, 1000).replaceAll(value, "***"),
    );
    return NextResponse.json(
      { error: "Convex CLI failed — check admin server logs" },
      { status: 500 },
    );
  }

  console.log(`[integrations] ${session.email} rotated ${name} (${value.length} chars) on Convex prod`);
  return NextResponse.json({ ok: true, name });
}

export async function DELETE(request: NextRequest) {
  // F12: see GET — guard() enforces origin allowlist + body cap.
  const g = await guard(request);
  if (!g.ok) return g.response;
  const session = g.session;
  if (session.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden: super_admin role required" }, { status: 403 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!ENV_NAME_RE.test(name) || !INTEGRATION_KEYS.has(name)) {
    return NextResponse.json({ error: "Env var not in allowlist" }, { status: 403 });
  }

  const key = deployKey();
  if (!key) {
    return NextResponse.json(
      { error: "CONVEX_PROD_DEPLOY_KEY not configured on the admin server" },
      { status: 500 },
    );
  }

  const res = await runConvex(["env", "remove", name], { CONVEX_DEPLOY_KEY: key });
  if (!res.ok) {
    // Same disclosure policy as POST — stderr stays server-side. Convex's
    // `env remove` does echo "removed FOO=value" on the success path of
    // some CLI versions, so even error paths are not safe to surface.
    console.error(
      `[integrations] convex env remove ${name} failed (exit=${res.exitCode}):`,
      res.stderr.slice(0, 1000),
    );
    return NextResponse.json(
      { error: "Convex CLI failed — check admin server logs" },
      { status: 500 },
    );
  }

  console.log(`[integrations] ${session.email} removed ${name} on Convex prod`);
  return NextResponse.json({ ok: true, name });
}
