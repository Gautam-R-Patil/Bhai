// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── demo_project ──────────────────────────────
// After scaffolding / building a project, start the right runtime
// so the walkthrough step has something visual to capture.
//
// Auto-detects project type from its manifest:
//   • package.json + vite          → `npm run dev` → web URL
//   • package.json + next          → `npm run dev` → web URL
//   • package.json + astro         → `npm run dev` → web URL
//   • package.json + static-style  → `npm run dev` → web URL (fallback)
//   • package.json, no web script  → CLI — run `npm start` or `node .`
//   • Cargo.toml                   → `cargo run`
//   • pyproject.toml / requirements → Django `manage.py runserver`,
//                                    `python main.py`, Flask or `uvicorn`
//   • go.mod                       → `go run .`
//   • static HTML index            → serve via `npx http-server`
//
// Returns { kind, command, pid, url?, stop_hint }. Agent uses url for
// browser_verify / os_screenshot, or pid for later shell_kill_process.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import { logToolAction } from "../../utils/debug-log.js";
import type { ToolDefinition } from "../get-current-time.js";

interface Detection {
    kind: "web" | "cli" | "static" | "unknown";
    command: string;
    args: string[];
    urlCandidate?: string; // the URL the runtime is expected to expose
    note: string;
}

const DEFAULT_PORTS: Record<string, number> = {
    vite: 5173,
    next: 3000,
    astro: 4321,
    "http-server": 8080,
    "react-scripts": 3000,
    svelte: 5173,
    nuxt: 3000,
};

function readPkg(dir: string): Record<string, unknown> | null {
    try {
        const p = path.join(dir, "package.json");
        if (!existsSync(p)) return null;
        return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
        return null;
    }
}

/** Exported for tests. */
export function detect(dir: string): Detection {
    const pkg = readPkg(dir);
    if (pkg) {
        const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
        const deps = {
            ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
            ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
        };
        // Framework → URL port mapping
        let port: number | undefined;
        for (const [name, p] of Object.entries(DEFAULT_PORTS)) {
            if (deps[name] || deps[`@${name}`]) {
                port = p;
                break;
            }
        }
        if (scripts.dev) {
            return {
                kind: "web",
                command: "npm",
                args: ["run", "--silent", "dev"],
                urlCandidate: port ? `http://localhost:${port}` : "http://localhost:3000",
                note: `npm run dev (${port ? `port ${port}` : "port autodetect"})`,
            };
        }
        if (scripts.start) {
            return {
                kind: deps.express || deps.fastify || deps.koa ? "web" : "cli",
                command: "npm",
                args: ["start", "--silent"],
                urlCandidate: port ? `http://localhost:${port}` : undefined,
                note: "npm start",
            };
        }
        return {
            kind: "cli",
            command: "node",
            args: ["."],
            note: "node .",
        };
    }
    if (existsSync(path.join(dir, "Cargo.toml"))) {
        return { kind: "cli", command: "cargo", args: ["run", "--quiet"], note: "cargo run" };
    }
    if (existsSync(path.join(dir, "go.mod"))) {
        return { kind: "cli", command: "go", args: ["run", "."], note: "go run ." };
    }
    const pyManifests = ["pyproject.toml", "requirements.txt"].filter((f) => existsSync(path.join(dir, f)));
    if (pyManifests.length > 0) {
        // Best-effort: look for a typical entrypoint
        if (existsSync(path.join(dir, "manage.py"))) {
            return {
                kind: "web",
                command: "python3",
                args: ["manage.py", "runserver", "--noreload", "8000"],
                urlCandidate: "http://localhost:8000",
                note: "django runserver (port 8000)",
            };
        }
        if (existsSync(path.join(dir, "main.py"))) {
            return { kind: "cli", command: "python3", args: ["main.py"], note: "python3 main.py" };
        }
        const pyDeps = pyManifests.map((f) => readFileSync(path.join(dir, f), "utf-8")).join("\n");
        if (existsSync(path.join(dir, "app.py")) && /\bflask\b/i.test(pyDeps)) {
            return {
                kind: "web",
                command: "python3",
                args: ["-m", "flask", "--app", "app", "run", "--port", "8000"],
                urlCandidate: "http://localhost:8000",
                note: "flask run (port 8000)",
            };
        }
        if (existsSync(path.join(dir, "app.py"))) {
            return {
                kind: "web",
                command: "python3",
                args: ["-m", "uvicorn", "app:app", "--port", "8000"],
                urlCandidate: "http://localhost:8000",
                note: "uvicorn app:app (port 8000)",
            };
        }
    }
    if (existsSync(path.join(dir, "index.html"))) {
        return {
            kind: "static",
            command: "npx",
            args: ["--yes", "http-server", ".", "-p", "8080", "-s"],
            urlCandidate: "http://localhost:8080",
            note: "npx http-server (port 8080)",
        };
    }
    return { kind: "unknown", command: "", args: [], note: "no recognizable runtime" };
}

/** The URL a dev server printed ("Local: http://localhost:5174/"); Vite bumps the port when 5173 is taken. */
export function announcedUrl(output: string): string | undefined {
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/.exec(stripVTControlCharacters(output));
    return m ? `http://localhost:${m[1]}` : undefined;
}

/**
 * Wait until the server answers, following the URL it announces in its
 * output. The default port is probed only after a 3s grace: when it is
 * taken (the reason Vite bumps), whatever holds it would answer first.
 */
async function waitForUrl(
    fallbackUrl: string,
    processId: string | undefined,
    timeoutMs: number,
): Promise<string | null> {
    const { shellCheckProcess } = await import("../shell-monitor.js");
    const start = Date.now();
    while (Date.now() < start + timeoutMs) {
        let url: string | undefined;
        if (processId) {
            try {
                const out = JSON.parse(
                    String(await shellCheckProcess.handler({ process_id: processId, tail_lines: 50 })),
                );
                url = announcedUrl(String(out.output_tail ?? ""));
            } catch {
                /* keep the default */
            }
        }
        if (!url && (!processId || Date.now() - start > 3000)) url = fallbackUrl;
        if (url) {
            const res = await fetch(url, { signal: AbortSignal.timeout(1500) }).catch(() => null);
            if (res) return url;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

export const demoProjectTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "demo_project",
            description:
                "Start a project's dev/run command in the background so the walkthrough step has " +
                "something live to screenshot or browser_verify. Detects framework (vite/next/astro/" +
                "cargo/go/python) and picks the right command. For web stacks, waits until the URL " +
                "responds before returning. Use at the end of a complex coding task, right before " +
                "the walkthrough step.",
            parameters: {
                type: "object",
                properties: {
                    project_dir: {
                        type: "string",
                        description:
                            "Absolute path to the project root (the dir containing package.json / Cargo.toml / etc.).",
                    },
                    wait_ms: {
                        type: "number",
                        description:
                            "For web runtimes, how long to wait for the URL to become reachable. Default 12000 ms.",
                    },
                },
                required: ["project_dir"],
            },
        },
    },
    async handler(input) {
        const dirRaw = typeof input.project_dir === "string" ? input.project_dir.trim() : "";
        if (!dirRaw) return JSON.stringify({ success: false, error: "project_dir required" });
        const dir = path.resolve(dirRaw);
        if (!existsSync(dir)) return JSON.stringify({ success: false, error: `dir not found: ${dir}` });
        if (!isPathAllowed(dir)) return JSON.stringify({ success: false, error: `project_dir not allowed: ${dir}` });

        const det = detect(dir);
        if (det.kind === "unknown") {
            return JSON.stringify({
                success: false,
                error: "Could not detect how to run this project. Inspect it (list_directory / read package.json) and use shell_exec_background with the appropriate command.",
            });
        }
        const waitMs = Math.max(1000, Math.min(120_000, Number(input.wait_ms) || 12_000));

        auditLog("demo_project", { dir, kind: det.kind, command: det.command, args: det.args });
        logToolAction({ tool: "demo_project", filePath: dir, action: `${det.note} (${det.kind})` });

        // Spawn in background via shell_exec_background — reuses its
        // process-tracking + kill semantics so the agent can later stop
        // the runtime with shell_kill_process.
        let pid: number | string | null = null;
        let processId: string | undefined;
        let launchError: string | undefined;
        try {
            const { shellExecBackground } = await import("../shell-monitor.js");
            const cmdLine = [det.command, ...det.args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
            const raw = await shellExecBackground.handler({
                command: cmdLine,
                cwd: dir,
                name: `demo-${path.basename(dir)}`,
            });
            const parsed = JSON.parse(String(raw)) as {
                success?: boolean;
                pid?: number;
                process_id?: string;
                error?: string;
            };
            if (!parsed.success) launchError = parsed.error ?? "shell_exec_background did not return success";
            pid = parsed.pid ?? parsed.process_id ?? null;
            processId = parsed.process_id;
        } catch (err) {
            launchError = (err as Error).message;
        }
        if (launchError) {
            return JSON.stringify({
                success: false,
                error: `launch failed: ${launchError}`,
                detection: det,
            });
        }

        // If the runtime is web, wait until the URL responds. Non-blocking
        // for CLI runtimes — we just return the pid immediately.
        let readyUrl: string | null = null;
        if (det.urlCandidate && (det.kind === "web" || det.kind === "static")) {
            readyUrl = await waitForUrl(det.urlCandidate, processId, waitMs);
        }
        const urlReady = readyUrl !== null;
        const url = readyUrl ?? det.urlCandidate;

        return JSON.stringify({
            success: true,
            kind: det.kind,
            command: `${det.command} ${det.args.join(" ")}`.trim(),
            cwd: dir,
            pid,
            process_id: processId,
            url,
            url_ready: urlReady,
            note: det.note,
            stop_hint:
                pid != null
                    ? `When you're done with the walkthrough, call shell_kill_process({ process_id: "${processId ?? pid}" }) to stop it.`
                    : "Use shell_check_process / shell_kill_process to manage the background runtime.",
            next_step_hint:
                det.kind === "web" && urlReady
                    ? `Runtime is live at ${url}. Call browser_verify or os_screenshot to capture it for the walkthrough.`
                    : det.kind === "web"
                      ? `Runtime started but ${url} didn't respond within ${waitMs}ms. Check shell_check_process for startup errors before screenshotting.`
                      : `Runtime started as a CLI process. Run a smoke command and capture its terminal output for the walkthrough.`,
        });
    },
};
