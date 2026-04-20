// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── scaffold_project ─────────────────────────
// Bootstrap a modern web stack with sane defaults. Covers four
// templates:
//   • vite-react-ts — Vite + React + TypeScript + Tailwind
//   • nextjs       — Next.js (App Router) + TypeScript + Tailwind
//   • astro        — Astro + TypeScript + Tailwind
//   • static       — Plain HTML + CSS + JS (no build step)
//
// Optional `features`: tailwind (always for non-static), shadcn,
// framer-motion, react-three-fiber, gsap, lucide-react, iconify-react.
// Installs are executed via shell spawn so the agent stays in control;
// all shell args are hard-coded (no user-provided strings flow into
// the command array).
//
// Returns the project path, package manager used, and a short
// "next steps" list so the agent can immediately `cd` in and start
// editing files.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCodeDir } from "../../config/paths.js";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";

type Template = "vite-react-ts" | "nextjs" | "astro" | "static";
type Feature =
    | "tailwind"
    | "shadcn"
    | "framer-motion"
    | "react-three-fiber"
    | "gsap"
    | "lucide-react"
    | "iconify-react"
    | "lottie-react";
type PackageManager = "npm" | "pnpm" | "yarn";

const ALLOWED_TEMPLATES: Template[] = ["vite-react-ts", "nextjs", "astro", "static"];
const ALLOWED_FEATURES: Feature[] = [
    "tailwind",
    "shadcn",
    "framer-motion",
    "react-three-fiber",
    "gsap",
    "lucide-react",
    "iconify-react",
    "lottie-react",
];

function isValidProjectName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_-]{0,40}$/.test(name);
}

function runCmd(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = spawn(command, args, { cwd, env: process.env });

        const timer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            } catch {
                /* */
            }
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* */
                }
            }, 2000);
            if (!settled) {
                settled = true;
                resolve({ code: -1, stdout, stderr, timedOut: true });
            }
        }, timeoutMs);

        child.stdout?.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
            stderr += d.toString();
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
            }
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                resolve({ code: code ?? 1, stdout, stderr, timedOut: false });
            }
        });
    });
}

// ── Template scaffolders ────────────────────

async function scaffoldViteReact(projectDir: string, pm: PackageManager): Promise<string[]> {
    const logs: string[] = [];
    const parent = path.dirname(projectDir);
    const name = path.basename(projectDir);
    const r = await runCmd(
        pm === "npm" ? "npm" : pm,
        [...(pm === "npm" ? ["create", "vite@latest"] : ["create", "vite"]), name, "--", "--template", "react-ts"],
        parent,
        180_000,
    );
    logs.push(`[vite] exit=${r.code} ${r.timedOut ? "(timed out)" : ""}`);
    if (r.code !== 0) logs.push(r.stderr.slice(-600));
    await runCmd(pm, ["install"], projectDir, 240_000);
    return logs;
}

async function scaffoldNextjs(projectDir: string, pm: PackageManager): Promise<string[]> {
    const logs: string[] = [];
    const parent = path.dirname(projectDir);
    const name = path.basename(projectDir);
    const r = await runCmd(
        "npx",
        [
            "--yes",
            "create-next-app@latest",
            name,
            "--ts",
            "--tailwind",
            "--eslint",
            "--app",
            "--src-dir",
            "--no-turbopack",
            `--use-${pm}`,
            "--import-alias",
            "@/*",
        ],
        parent,
        300_000,
    );
    logs.push(`[next] exit=${r.code} ${r.timedOut ? "(timed out)" : ""}`);
    if (r.code !== 0) logs.push(r.stderr.slice(-600));
    return logs;
}

async function scaffoldAstro(projectDir: string, _pm: PackageManager): Promise<string[]> {
    const logs: string[] = [];
    const parent = path.dirname(projectDir);
    const name = path.basename(projectDir);
    const r = await runCmd(
        "npx",
        [
            "--yes",
            "create-astro@latest",
            name,
            "--template",
            "minimal",
            "--typescript",
            "strict",
            "--install",
            "--no-git",
            "--yes",
        ],
        parent,
        240_000,
    );
    logs.push(`[astro] exit=${r.code} ${r.timedOut ? "(timed out)" : ""}`);
    if (r.code !== 0) logs.push(r.stderr.slice(-600));
    return logs;
}

function scaffoldStatic(projectDir: string): string[] {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
        path.join(projectDir, "index.html"),
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>New Site</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>Hello, web.</h1>
      <p>Replace this starter with your content.</p>
    </main>
    <script type="module" src="main.js"></script>
  </body>
</html>
`,
        "utf-8",
    );
    writeFileSync(
        path.join(projectDir, "styles.css"),
        `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.5;
  color: #111;
  background: #fff;
}
main { max-width: 60ch; margin: 4rem auto; padding: 0 1.25rem; }
h1 { font-size: clamp(2rem, 5vw, 3rem); font-weight: 700; letter-spacing: -0.02em; }
`,
        "utf-8",
    );
    writeFileSync(
        path.join(projectDir, "main.js"),
        `// Static site entry. Add interactivity here.
console.log("hello");
`,
        "utf-8",
    );
    return ["[static] wrote index.html + styles.css + main.js"];
}

// ── Feature installers ──────────────────────

const FEATURE_DEPS: Record<Feature, string[]> = {
    tailwind: [], // handled per-template
    shadcn: [], // init + manual component add
    "framer-motion": ["framer-motion"],
    "react-three-fiber": ["three", "@react-three/fiber", "@react-three/drei"],
    gsap: ["gsap"],
    "lucide-react": ["lucide-react"],
    "iconify-react": ["@iconify/react"],
    "lottie-react": ["lottie-react"],
};

async function installFeatures(
    projectDir: string,
    pm: PackageManager,
    template: Template,
    features: Feature[],
): Promise<string[]> {
    const logs: string[] = [];
    const toInstall: string[] = [];
    for (const f of features) {
        if (FEATURE_DEPS[f]?.length > 0) toInstall.push(...FEATURE_DEPS[f]);
    }
    if (toInstall.length > 0) {
        const addCmd = pm === "npm" ? "install" : "add";
        const r = await runCmd(pm, [addCmd, ...toInstall], projectDir, 180_000);
        logs.push(`[deps] installed ${toInstall.join(" ")} (exit ${r.code})`);
        if (r.code !== 0) logs.push(r.stderr.slice(-400));
    }
    if (template === "vite-react-ts" && features.includes("tailwind")) {
        logs.push("[tailwind] run `npx tailwindcss init -p` manually — the Vite starter doesn't preconfigure it.");
    }
    if (features.includes("shadcn")) {
        logs.push(
            "[shadcn] run `npx shadcn@latest init` interactively, then `npx shadcn@latest add button card input` for the components you need.",
        );
    }
    return logs;
}

// ── Tool ─────────────────────────────────────

export const scaffoldProject: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "scaffold_project",
            description:
                "Bootstrap a new web project with modern defaults. Templates: vite-react-ts (SPA, fastest), nextjs (full-stack / SSR / routes), astro (content-heavy, MPA-first), static (vanilla HTML/CSS/JS — no build). Optionally add features: tailwind, shadcn, framer-motion, react-three-fiber, gsap, lucide-react, iconify-react, lottie-react. Returns the project path and next-step hints so you can immediately `cd` in and `edit` files.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Project folder name (lowercase letters, digits, `-`, `_`). Max 40 chars.",
                    },
                    template: {
                        type: "string",
                        enum: ALLOWED_TEMPLATES,
                        description: "Stack choice. Default 'vite-react-ts'.",
                    },
                    parent_dir: {
                        type: "string",
                        description:
                            "Parent directory under which to create the project. Defaults to the user's ATLAS workspace Code folder (A.T.L.A.S Files/Code on fresh installs). Pass an explicit path only when the user asked for a specific location.",
                    },
                    features: {
                        type: "array",
                        items: { type: "string", enum: ALLOWED_FEATURES },
                        description:
                            "Optional extras to install. For UI polish, a solid default is ['tailwind','shadcn','framer-motion','lucide-react']. For 3D/animation add 'react-three-fiber' and/or 'gsap'.",
                    },
                    package_manager: {
                        type: "string",
                        enum: ["npm", "pnpm", "yarn"],
                        description: "Package manager. Default 'npm'.",
                    },
                },
                required: ["name"],
            },
        },
    },

    async handler(input) {
        const name = (input.name as string) || "";
        if (!isValidProjectName(name)) {
            return JSON.stringify({
                error: "name must be lowercase letters/digits with `-` or `_`, max 40 chars (e.g. 'my-site', 'landing_v2').",
            });
        }
        const template = ((input.template as string) || "vite-react-ts") as Template;
        if (!ALLOWED_TEMPLATES.includes(template)) {
            return JSON.stringify({ error: `Unsupported template: ${template}` });
        }
        // Default parent: the user's workspace Code/ directory — `A.T.L.A.S Files/Code`
        // on fresh installs. The installer sets ATLAS_WORKSPACE; fallbacks resolve
        // to Desktop / Documents / ~/ variants. Explicit parent_dir from the user
        // always wins.
        const parentDir = path.resolve((input.parent_dir as string) || getCodeDir());
        if (!isPathAllowed(parentDir)) {
            const reason = getPathBlockedReason(parentDir) ?? `Parent dir not allowed: ${parentDir}`;
            return JSON.stringify({ error: reason });
        }
        if (!existsSync(parentDir)) {
            try { mkdirSync(parentDir, { recursive: true }); } catch {
                return JSON.stringify({ error: `Could not create parent dir: ${parentDir}` });
            }
        }
        const projectDir = path.join(parentDir, name);
        if (existsSync(projectDir)) {
            return JSON.stringify({
                error: `Destination already exists: ${projectDir}. Pick a different name or delete it first.`,
            });
        }
        const featuresRaw = Array.isArray(input.features) ? (input.features as string[]) : [];
        const features: Feature[] = featuresRaw.filter((f): f is Feature => ALLOWED_FEATURES.includes(f as Feature));
        const pm = ((input.package_manager as string) || "npm") as PackageManager;
        if (!["npm", "pnpm", "yarn"].includes(pm)) {
            return JSON.stringify({ error: `Unsupported package manager: ${pm}` });
        }

        auditLog("scaffold_project", { template, projectDir, features });

        const allLogs: string[] = [];
        try {
            if (template === "vite-react-ts") {
                allLogs.push(...(await scaffoldViteReact(projectDir, pm)));
            } else if (template === "nextjs") {
                allLogs.push(...(await scaffoldNextjs(projectDir, pm)));
            } else if (template === "astro") {
                allLogs.push(...(await scaffoldAstro(projectDir, pm)));
            } else {
                allLogs.push(...scaffoldStatic(projectDir));
            }
        } catch (err) {
            return JSON.stringify({ error: `Scaffold failed: ${(err as Error).message}`, logs: allLogs });
        }

        if (template !== "static" && features.length > 0) {
            try {
                allLogs.push(...(await installFeatures(projectDir, pm, template, features)));
            } catch (err) {
                allLogs.push(`[features] install failed: ${(err as Error).message}`);
            }
        }

        const nextSteps: string[] = [];
        if (template !== "static") {
            nextSteps.push(`cd ${projectDir}`);
            if (template === "vite-react-ts") nextSteps.push(`${pm} run dev    # starts on http://localhost:5173`);
            if (template === "nextjs") nextSteps.push(`${pm} run dev    # starts on http://localhost:3000`);
            if (template === "astro") nextSteps.push(`${pm} run dev    # starts on http://localhost:4321`);
        } else {
            nextSteps.push(`Open ${projectDir}/index.html in a browser, or run \`npx serve ${projectDir}\`.`);
        }
        nextSteps.push("After the dev server is running, call `browser_verify` to confirm the page renders cleanly.");

        return JSON.stringify({
            success: true,
            project_dir: projectDir,
            template,
            features,
            package_manager: pm,
            next_steps: nextSteps,
            logs: allLogs.slice(-20),
        });
    },
};
