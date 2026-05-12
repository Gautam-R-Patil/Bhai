// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Pre-flight Validation ───────────────
//
// Cheap precondition checks for common "tool would have failed anyway"
// cases. Running these synchronously before the tool call saves an
// iteration (agent sees a structured hint, not a stack trace) and
// eliminates wasted tool-exec time (~50-500ms per avoidable failure).
//
// Research (AgentSpec arXiv 2503.18666, VerifyLLM 2507.05118) shows
// plan-precondition verification catches 30-40% of avoidable failures
// before they waste a round-trip.
//
// Deliberately conservative: only check things that are cheap to probe
// AND common failure modes. A preflight *pass* is not proof of success —
// the tool still does its own validation. A preflight *fail* is strong
// evidence the call would fail.

import { accessSync, existsSync, constants as fsC } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface PreflightHint {
    /** Why the tool call would fail. Passed back to the LLM as an error hint. */
    reason: string;
    /** Optional hint for what the agent should try instead. */
    suggest?: string;
}

/**
 * Validate a tool call's preconditions. Returns null if the call looks
 * fine to proceed, or a PreflightHint describing why it would fail.
 * Never throws — fail-open on any unexpected error.
 */
export function preflight(toolName: string, args: Record<string, unknown>): PreflightHint | null {
    try {
        // ── File-path-bearing tools ──────────────
        // read / edit / write / append_file / notebook_edit / delete_file
        // all take a `file_path` or `path` and fail if the parent dir is
        // missing (write/append), or the file is missing (read/edit).
        const filePath = pickStringArg(args, ["file_path", "path", "filepath"]);
        if (filePath) {
            // Absolute-path requirement for several tools
            if (REQUIRES_ABSOLUTE_PATH.has(toolName) && !isAbsolute(filePath)) {
                return {
                    reason: `${toolName} requires an absolute path but got a relative one: "${filePath}"`,
                    suggest: "Use an absolute path (starts with / on Unix or a drive letter on Windows).",
                };
            }
            // Read-like tools fail if the file doesn't exist
            if (READS_EXISTING_FILE.has(toolName) && !existsSync(filePath)) {
                return {
                    reason: `File does not exist: ${filePath}`,
                    suggest: "Use the glob or list_directory tool to find the actual path, or check for typos.",
                };
            }
            // Edit fails without a prior read in session — but that's
            // enforced inside the tool itself, so skip here.
            // For write/append: parent dir must exist.
            // Use node:path's dirname so backslash separators on Windows work.
            if (WRITES_FILE.has(toolName)) {
                const parent = dirname(filePath);
                if (parent && parent !== "." && parent !== filePath && !existsSync(parent)) {
                    return {
                        reason: `Parent directory does not exist: ${parent}`,
                        suggest: `Create the directory first (shell_exec mkdir -p "${parent}") or use a valid path.`,
                    };
                }
            }
            // Delete: file must exist (otherwise the user's ask is already done)
            if (toolName === "delete_file" && !existsSync(filePath)) {
                return {
                    reason: `File already absent: ${filePath}`,
                    suggest: "No action needed — the file isn't there.",
                };
            }
        }

        // ── URL-bearing tools ──────────────
        const url = pickStringArg(args, ["url", "link"]);
        if (url && REQUIRES_URL.has(toolName)) {
            if (!/^https?:\/\//i.test(url)) {
                return {
                    reason: `${toolName} requires http(s):// URL but got: "${url}"`,
                    suggest: "Prefix the URL with https://.",
                };
            }
        }

        // ── Shell tools ──────────────
        if (toolName === "shell_exec" || toolName === "shell_exec_background") {
            const cmd = pickStringArg(args, ["command", "cmd"]);
            if (cmd && !cmd.trim()) {
                return { reason: "shell_exec called with empty command" };
            }
            // Accidental rm -rf / catch — not a complete security fence
            // (security has its own layers), just a helpful hint. Alternation
            // includes the -fr flag order typo. Genuine rejection path is
            // in `src/security/sandbox.ts`; this just saves an exec roundtrip.
            if (cmd && /\brm\s+-(?:rf|fr)\s+(?:--no-preserve-root\s+)?\/\s*(\*|$)/.test(cmd)) {
                return {
                    reason: "Refusing to run a catastrophic 'rm -rf /' command. This would wipe the system.",
                    suggest: "If you meant to clear a specific directory, use its full path.",
                };
            }
        }

        // ── LSP / code-action tools — readable file required ──
        if (toolName === "lsp") {
            const fp = pickStringArg(args, ["filePath", "file_path", "path"]);
            if (fp) {
                try {
                    accessSync(fp, fsC.R_OK);
                } catch {
                    return { reason: `LSP file unreadable or missing: ${fp}` };
                }
            }
        }
    } catch {
        // Preflight is strictly best-effort. A crash in the checks must
        // NOT block the tool call — fail open so normal execution proceeds.
        return null;
    }
    return null;
}

// ── Helpers ───────────────────────────────

function pickStringArg(args: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
        const v = args[k];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
}

// Tools that require absolute paths. Extended per-tool schema tightening;
// Read tool requires absolute in particular.
const REQUIRES_ABSOLUTE_PATH: ReadonlySet<string> = new Set([
    "read",
    "edit",
    "write",
    "append_file",
    "notebook_edit",
    "delete_file",
]);

const READS_EXISTING_FILE: ReadonlySet<string> = new Set(["read", "edit", "notebook_edit"]);

const WRITES_FILE: ReadonlySet<string> = new Set(["write", "append_file"]);

const REQUIRES_URL: ReadonlySet<string> = new Set(["browser_navigate", "web_asset_download", "browser_batch_fetch"]);
