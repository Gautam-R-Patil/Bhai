// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── glob ──────────────────────────────────────
// Find files by glob pattern (e.g., "src/**/*.ts") using ripgrep's file
// listing + glob engine. Results sorted by mtime, newest first. Respects
// .gitignore unless `include_ignored=true`.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import type { ToolDefinition } from "../get-current-time.js";

const MAX_RESULTS = 1000;

function runCommand(
    cmd: string,
    args: string[],
    cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr.on("data", (d) => {
            stderr += d.toString();
        });
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.on("error", (err) => resolve({ code: 127, stdout: "", stderr: err.message }));
    });
}

async function hasRipgrep(): Promise<boolean> {
    const { code } = await runCommand("rg", ["--version"]);
    return code === 0;
}

export const glob: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "glob",
            description:
                "Find files matching a glob pattern (e.g., 'src/**/*.ts', '**/*.{ts,tsx}'). " +
                "Results are sorted by modification time (newest first). " +
                "Respects .gitignore; skips node_modules/.git/dist by default.",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description: 'Glob pattern, e.g. "src/**/*.ts" or "*.md".',
                    },
                    path: {
                        type: "string",
                        description: "Base directory to search in. Defaults to current working directory.",
                    },
                    include_ignored: {
                        type: "boolean",
                        description: "If true, include files normally ignored via .gitignore. Default false.",
                    },
                },
                required: ["pattern"],
            },
        },
    },

    async handler(input) {
        let pattern = input.pattern as string;
        if (!pattern) return JSON.stringify({ error: "pattern is required" });

        // Models name it folder/dir too: glob({ pattern, folder: "~/Desktop" }) searched Bhai's
        // own working directory and found nothing.
        let given = (input.path ?? input.folder ?? input.dir ?? input.directory ?? input.cwd) as string | undefined;
        // ...or put the folder in the pattern ("~/Downloads/*.pdf"): its fixed start is the base.
        if (!given && /^(~|\/)/.test(pattern)) {
            const parts = pattern.replace(/^~(?=\/|$)/, os.homedir()).split("/");
            const firstWild = parts.findIndex((p) => /[*?[{]/.test(p));
            const cut = firstWild < 0 ? parts.length - 1 : firstWild;
            given = parts.slice(0, cut).join("/") || "/";
            pattern = parts.slice(cut).join("/") || "*";
        }
        const basePath = path.resolve(given || process.cwd());
        if (!isPathAllowed(basePath)) {
            const reason = getPathBlockedReason(basePath) ?? `Path "${basePath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }

        const rgAvailable = await hasRipgrep();
        if (!rgAvailable) {
            return JSON.stringify({
                error: "ripgrep (rg) is not installed. Install via `brew install ripgrep` on macOS or `apt install ripgrep` on Linux.",
            });
        }

        const args = ["--files", "--glob", pattern];
        if (input.include_ignored === true) {
            args.push("--no-ignore");
        } else {
            // Additional default excludes on top of .gitignore
            args.push("--glob", "!node_modules/**", "--glob", "!.git/**", "--glob", "!dist/**");
        }
        args.push(basePath);

        const { code, stdout, stderr } = await runCommand("rg", args);
        if (code !== 0 && code !== 1) {
            return JSON.stringify({ error: stderr.trim() || `rg exited with code ${code}` });
        }

        const paths = stdout ? stdout.split("\n").filter((l) => l.length > 0) : [];

        // Sort by mtime descending
        const withTimes = paths.map((p) => {
            let mtime = 0;
            try {
                mtime = statSync(p).mtimeMs;
            } catch {
                /* ignore */
            }
            return { path: p, mtime };
        });
        withTimes.sort((a, b) => b.mtime - a.mtime);

        const truncated = withTimes.length > MAX_RESULTS;
        const results = withTimes.slice(0, MAX_RESULTS).map((r) => r.path);

        return JSON.stringify({
            success: true,
            pattern,
            base_path: basePath,
            files: results,
            total_matches: withTimes.length,
            truncated,
        });
    },
};
