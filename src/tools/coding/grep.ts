// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── grep ──────────────────────────────────────
// Claude Code–style content search powered by system ripgrep (`rg`).
// Falls back to a minimal in-process scan if `rg` is unavailable.

import { spawn } from "node:child_process";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { sanitizeSecrets } from "../../security/secrets-sanitizer.js";
import { isSensitivePath } from "../../security/sensitive-paths.js";

// Same files read refuses, skipped when grep walks a directory.
const SENSITIVE_GLOBS = [
    "!.env",
    "!.env.*",
    "!*.env",
    "!*.pem",
    "!*private*key*",
    "!.ssh",
    "!.aws",
    "!.gnupg",
    "!.netrc",
    "!.npmrc",
    "!.git-credentials",
    "!*_history",
    "!.bhai",
    "!.atlas", // pre-rename state root (older builds still use it)
    // Bhai's own secrets in its data dir (read refuses them; grep walked straight in).
    "!google-credentials.json",
    "!google-tokens",
    "!chrome-bridge-token.txt",
    "!audit.jsonl",
    "!memories.db*",
    "!*.enc",
    "!*.p12",
    "!id_rsa*",
    "!id_ed25519*",
];
import type { ToolDefinition } from "../get-current-time.js";

const DEFAULT_HEAD_LIMIT = 250;

// ── Helpers ───────────────────────────────────

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

// ── Tool ──────────────────────────────────────

export const grep: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "grep",
            description:
                "Search file contents with regular expressions (ripgrep syntax). " +
                "Use `output_mode` to control result shape: 'files_with_matches' (default) lists paths, " +
                "'content' shows matching lines, 'count' shows hit counts per file. " +
                "Filter with `glob` (e.g., '*.ts') or `type` (e.g., 'ts', 'py'). " +
                "Use context flags (-A/-B/-C) and -i/-n for line numbers. " +
                "Respects .gitignore by default.",
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "Regex pattern to search for (ripgrep syntax)." },
                    path: {
                        type: "string",
                        description: "Directory or file to search in. Defaults to current working directory.",
                    },
                    glob: { type: "string", description: 'Glob filter, e.g. "*.ts" or "**/*.{ts,tsx}".' },
                    type: { type: "string", description: 'Language shortcut, e.g. "ts", "py", "rust".' },
                    output_mode: {
                        type: "string",
                        enum: ["content", "files_with_matches", "count"],
                        description: "What to return. Default: files_with_matches.",
                    },
                    "-i": { type: "boolean", description: "Case-insensitive." },
                    "-n": { type: "boolean", description: "Include line numbers (content mode only)." },
                    "-A": { type: "number", description: "Lines of trailing context (content mode)." },
                    "-B": { type: "number", description: "Lines of leading context (content mode)." },
                    "-C": { type: "number", description: "Lines of context on both sides (content mode)." },
                    multiline: { type: "boolean", description: "Enable multiline matching (pattern spans lines)." },
                    head_limit: {
                        type: "number",
                        description: `Max lines/entries to return (default ${DEFAULT_HEAD_LIMIT}).`,
                    },
                    offset: { type: "number", description: "Skip first N results before applying head_limit." },
                },
                required: ["pattern"],
            },
        },
    },

    async handler(input) {
        const pattern = input.pattern as string;
        if (!pattern) return JSON.stringify({ error: "pattern is required" });

        const searchPath = path.resolve((input.path as string) || process.cwd());
        if (!isPathAllowed(searchPath)) {
            const reason = getPathBlockedReason(searchPath) ?? `Path "${searchPath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }
        const sensitive = isSensitivePath(searchPath);
        if (sensitive.denied) {
            return JSON.stringify({ error: `Refusing to search a sensitive path. ${sensitive.reason ?? ""}` });
        }

        const mode = (input.output_mode as string) || "files_with_matches";
        const headLimit = Math.max(1, Math.floor(Number(input.head_limit) || DEFAULT_HEAD_LIMIT));
        const offset = Math.max(0, Math.floor(Number(input.offset) || 0));

        const rgAvailable = await hasRipgrep();
        if (!rgAvailable) {
            return JSON.stringify({
                error: "ripgrep (rg) is not installed. Install it via `brew install ripgrep` on macOS or `apt install ripgrep` on Linux.",
            });
        }

        // Build args
        const args: string[] = ["--no-heading", "--color=never"];
        if (input["-i"] === true) args.push("-i");
        if (input.multiline === true) args.push("--multiline", "--multiline-dotall");
        if (input.glob) args.push("--glob", String(input.glob));
        // After the caller's glob: ripgrep lets the last matching glob win.
        args.push(...SENSITIVE_GLOBS.flatMap((g) => ["--glob", g]));
        if (input.type) args.push("--type", String(input.type));

        if (mode === "files_with_matches") {
            args.push("-l");
        } else if (mode === "count") {
            args.push("-c");
        } else {
            // content mode
            if (input["-n"] !== false) args.push("-n"); // default on for content
            const ctxBoth = Number(input["-C"]);
            if (Number.isFinite(ctxBoth) && ctxBoth > 0) args.push("-C", String(ctxBoth));
            const ctxA = Number(input["-A"]);
            if (Number.isFinite(ctxA) && ctxA > 0) args.push("-A", String(ctxA));
            const ctxB = Number(input["-B"]);
            if (Number.isFinite(ctxB) && ctxB > 0) args.push("-B", String(ctxB));
        }

        args.push(pattern, searchPath);

        const run = await runCommand("rg", args);
        const { code, stderr } = run;
        const stdout = sanitizeSecrets(run.stdout).sanitized; // a key inside an ordinary file

        // rg exits 1 when no matches — that's not an error from the user's POV
        if (code !== 0 && code !== 1) {
            return JSON.stringify({ error: stderr.trim() || `rg exited with code ${code}` });
        }

        // Every hit's file is checked too (symlinks, names the globs don't cover): a path
        // read would refuse never comes back from grep either.
        const fileOf = (l: string) => (mode === "files_with_matches" ? l : l.slice(0, l.indexOf(":") > 0 ? l.indexOf(":") : l.length));
        const lines = stdout
            ? stdout.split("\n").filter((l) => l.length > 0 && !isSensitivePath(fileOf(l)).denied)
            : [];
        const sliced = lines.slice(offset, offset + headLimit);
        const truncated = lines.length > offset + headLimit;

        if (mode === "files_with_matches") {
            return JSON.stringify({
                success: true,
                output_mode: mode,
                files: sliced,
                total_files: lines.length,
                truncated,
            });
        }

        if (mode === "count") {
            const counts = sliced.map((line) => {
                const idx = line.lastIndexOf(":");
                const file = line.slice(0, idx);
                const count = parseInt(line.slice(idx + 1), 10) || 0;
                return { file, count };
            });
            return JSON.stringify({
                success: true,
                output_mode: mode,
                counts,
                total_files: lines.length,
                truncated,
            });
        }

        // content mode — return as a single text block the model can read
        return JSON.stringify({
            success: true,
            output_mode: mode,
            content: sliced.join("\n"),
            total_lines: lines.length,
            truncated,
        });
    },
};
