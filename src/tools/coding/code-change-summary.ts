// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── code_change_summary Tool ───────────────────
// Read-only git: recent_commits, hot_files, diff, blame. Never mutates.
// Runs synchronously via execFileSync with a timeout so the agent loop
// doesn't stall. Fail-open: non-git dir → success: false + note.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitAvailable, resolveRepoRoot } from "../../memory/codebase-merkle.js";
import type { ToolDefinition } from "../get-current-time.js";

function isGitRepo(dir: string): boolean {
    try {
        const root = resolveRepoRoot(dir);
        return fs.existsSync(path.join(root, ".git"));
    } catch {
        return false;
    }
}

function runGit(cwd: string, args: string[], timeoutMs = 4000): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
    });
}

export const codeChangeSummaryTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "code_change_summary",
            description: `Read-only git summaries for local repositories. Never mutates anything.
Operations:
- recent_commits(n=10)     → last N commits, oneline format
- hot_files(days=30)       → files touched most often in the window (top 50)
- diff(base, target?)      → diff --stat + unified diff between two refs (default target: HEAD)
- blame(file, line)        → git blame for a single line

All operations are local. Not-a-git-repo → { success: false, note }.`,
            parameters: {
                type: "object",
                properties: {
                    operation: { type: "string", enum: ["recent_commits", "hot_files", "diff", "blame"] },
                    n: { type: "number", description: "Number of commits (recent_commits)" },
                    days: { type: "number", description: "Window length (hot_files)" },
                    base: { type: "string", description: "Diff base ref" },
                    target: { type: "string", description: "Diff target ref (default HEAD)" },
                    file: { type: "string", description: "File path (blame)" },
                    line: { type: "number", description: "Line number (blame)" },
                    path: { type: "string", description: "Repo root (default cwd)" },
                },
                required: ["operation"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const operation = String(input.operation ?? "");
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();

        if (!gitAvailable()) {
            return JSON.stringify({ success: false, note: "git not available on PATH" });
        }
        if (!isGitRepo(root)) {
            return JSON.stringify({ success: false, note: "not a git repo" });
        }

        try {
            if (operation === "recent_commits") {
                const n = typeof input.n === "number" && input.n > 0 ? Math.min(100, input.n) : 10;
                const out = runGit(root, ["log", `--oneline`, `-n`, String(n), "--no-color"]);
                const commits = out
                    .split("\n")
                    .filter(Boolean)
                    .map((l) => {
                        const [sha, ...rest] = l.split(" ");
                        return { sha, message: rest.join(" ") };
                    });
                return JSON.stringify({ success: true, commits });
            }
            if (operation === "hot_files") {
                const days = typeof input.days === "number" && input.days > 0 ? Math.min(365, input.days) : 30;
                const out = runGit(root, ["log", "--name-only", "--pretty=format:", `--since=${days}d`]);
                const counts = new Map<string, number>();
                for (const l of out.split("\n")) {
                    const t = l.trim();
                    if (!t) continue;
                    counts.set(t, (counts.get(t) ?? 0) + 1);
                }
                const files = Array.from(counts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 50)
                    .map(([file, count]) => ({ file, count }));
                return JSON.stringify({ success: true, files });
            }
            if (operation === "diff") {
                const base = typeof input.base === "string" && input.base ? input.base : "HEAD~1";
                const target = typeof input.target === "string" && input.target ? input.target : "HEAD";
                const stat = runGit(root, ["diff", "--stat", `${base}..${target}`]);
                const unified = runGit(root, ["diff", `${base}..${target}`], 6000).slice(0, 20_000);
                return JSON.stringify({ success: true, base, target, stat, diff: unified });
            }
            if (operation === "blame") {
                const file = String(input.file ?? "");
                const line = typeof input.line === "number" ? input.line : 1;
                if (!file) return JSON.stringify({ success: false, error: "file required" });
                const out = runGit(root, ["blame", "-L", `${line},${line}`, file]);
                return JSON.stringify({ success: true, file, line, blame: out.trim() });
            }
            return JSON.stringify({ success: false, error: `unknown operation: ${operation}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `code_change_summary failed: ${(err as Error).message}` });
        }
    },
};
