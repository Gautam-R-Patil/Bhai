// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── /doctor preflight diagnostics ────────────────────────────
 * Read-only health probes run concurrently and fail-open: a probe that throws
 * is reported as a failed check, never an exception out of runDoctor(). The
 * only authed network round-trip is gated behind ATLAS_DOCTOR_AUTHED_PROBE
 * (default off); set ATLAS_NO_DOCTOR_NETWORK=true to skip all network probes.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { getKnownCreditBalance } from "../account-guard.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { isNativeRouterLoaded } from "../model-router.js";
import { getSessionTokenSync } from "../session.js";

export interface DoctorCheck {
    check: string;
    status: "ok" | "warn" | "fail";
    detail?: string;
    fix?: string;
}

function networkDisabled(): boolean {
    return process.env.ATLAS_NO_DOCTOR_NETWORK === "true";
}

async function probeConvex(): Promise<DoctorCheck> {
    if (networkDisabled())
        return { check: "Convex reachability", status: "ok", detail: "skipped (network probes off)" };
    try {
        const res = await fetch(`${getConvexSiteUrl()}/api/health`, {
            method: "HEAD",
            signal: AbortSignal.timeout(8000),
        });
        return res.ok || res.status === 404
            ? { check: "Convex reachability", status: "ok" }
            : { check: "Convex reachability", status: "warn", detail: `HTTP ${res.status}` };
    } catch (e) {
        return {
            check: "Convex reachability",
            status: "fail",
            detail: (e as Error).message,
            fix: "check your network connection",
        };
    }
}

function probeSession(): DoctorCheck {
    return getSessionTokenSync()
        ? { check: "Session token", status: "ok", detail: "valid in memory" }
        : {
              check: "Session token",
              status: "warn",
              detail: "no valid token cached",
              fix: "restart the app to re-auth",
          };
}

async function probeAuthed(): Promise<DoctorCheck> {
    if (process.env.ATLAS_DOCTOR_AUTHED_PROBE !== "true") {
        return {
            check: "Authed Convex round-trip",
            status: "ok",
            detail: "skipped (set ATLAS_DOCTOR_AUTHED_PROBE=true)",
        };
    }
    if (networkDisabled())
        return { check: "Authed Convex round-trip", status: "ok", detail: "skipped (network probes off)" };
    const { checkAccountStatus } = await import("../account-guard.js");
    const r = await checkAccountStatus();
    return r.allowed
        ? { check: "Authed Convex round-trip", status: "ok" }
        : { check: "Authed Convex round-trip", status: "warn", detail: r.reason };
}

function probeCredits(): DoctorCheck {
    const bal = getKnownCreditBalance();
    if (bal === null) return { check: "Credit balance", status: "warn", detail: "unknown — run a query first" };
    if (bal <= 0) return { check: "Credit balance", status: "fail", detail: `${bal}`, fix: "ask the TRUSCOR team for more credits" };
    return { check: "Credit balance", status: "ok", detail: `${bal}` };
}

function probeNative(): DoctorCheck {
    return isNativeRouterLoaded()
        ? { check: "Native model router", status: "ok" }
        : {
              check: "Native model router",
              status: "warn",
              detail: "JS fallback in use",
              fix: "run `npm run build:native`",
          };
}

function probeEnvKeys(): DoctorCheck {
    const required = ["ATLAS_OTPLESS_USER_ID", "TELEGRAM_BOT_TOKEN", "ALLOWED_USER_IDS"];
    const missing = required.filter((k) => !process.env[k]);
    return missing.length === 0
        ? { check: "Required env keys", status: "ok" }
        : { check: "Required env keys", status: "warn", detail: `missing: ${missing.join(", ")}` };
}

function probeMemoryDb(): DoctorCheck {
    const dbPath = path.join(process.env.ATLAS_DATA_DIR || path.resolve("data"), "memory.db");
    return existsSync(dbPath)
        ? { check: "Memory DB", status: "ok", detail: dbPath }
        : { check: "Memory DB", status: "warn", detail: "not yet created — created on first memory write" };
}

async function probeOllama(): Promise<DoctorCheck> {
    if (networkDisabled()) return { check: "Ollama (optional)", status: "ok", detail: "skipped (network probes off)" };
    try {
        const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
        return res.ok
            ? { check: "Ollama (optional)", status: "ok", detail: "local zero-cost routing available" }
            : { check: "Ollama (optional)", status: "ok", detail: "not running (optional)" };
    } catch {
        return { check: "Ollama (optional)", status: "ok", detail: "not running (optional)" };
    }
}

export async function runDoctor(): Promise<DoctorCheck[]> {
    const probes: Array<Promise<DoctorCheck> | DoctorCheck> = [
        probeConvex(),
        probeSession(),
        probeAuthed(),
        probeCredits(),
        probeNative(),
        probeEnvKeys(),
        probeMemoryDb(),
        probeOllama(),
    ];
    const settled = await Promise.allSettled(probes.map((p) => Promise.resolve(p)));
    return settled.map((s, i) =>
        s.status === "fulfilled"
            ? s.value
            : { check: `probe ${i}`, status: "fail" as const, detail: String(s.reason).slice(0, 120) },
    );
}

export function formatDoctor(checks: DoctorCheck[]): string {
    const emoji = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
    const lines: string[] = ["🩺 **Doctor**", ""];
    for (const c of checks) {
        lines.push(`${emoji[c.status]} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`);
        if (c.fix) lines.push(`   ↳ fix: ${c.fix}`);
    }
    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    lines.push("", `${checks.length} checks · ${fails} failed · ${warns} warnings`);
    return lines.join("\n");
}
