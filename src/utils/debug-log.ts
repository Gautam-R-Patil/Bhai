// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Debug Log Helpers ─────────────────────────
// Structured, file-aware log lines for coding-tool operations. Goal:
// every debug output tells the reader WHAT tool ran, WHICH file + line
// it touched, and a short one-liner of what's happening. That context
// is invaluable when reviewing agent traces or chasing regressions.
//
// Usage:
//   logToolAction({ tool: "edit", filePath: "src/foo.ts", line: 42, action: "replace identifier 'bar' with 'baz'" });
//   → [12:34:56] [edit] src/foo.ts:42 — replace identifier 'bar' with 'baz'
//
// Falls silent when BHAI_TOOL_DEBUG=false — still emits the bare
// "[tool]" prefix when debug is off so the existing trace remains
// readable. BHAI_TOOL_DEBUG=verbose also attaches session / role
// breadcrumbs when the caller supplies them.

import path from "node:path";

export interface ToolActionLog {
    /** The tool invoking this log (e.g. "edit", "write", "test_run"). */
    tool: string;
    /** Absolute or project-relative path the tool is touching, if any. */
    filePath?: string;
    /** 1-based line number — usually the primary edit / error location. */
    line?: number;
    /** Short one-liner describing the operation. Keep under ~100 chars. */
    action?: string;
    /** Optional context: sub-agent role, session id, phase, etc. */
    context?: Record<string, string | number | boolean>;
}

const DEBUG_MODE = (): "off" | "on" | "verbose" => {
    const v = (process.env.BHAI_TOOL_DEBUG || "").toLowerCase();
    if (v === "false" || v === "off" || v === "0") return "off";
    if (v === "verbose" || v === "2") return "verbose";
    return "on";
};

function prettyPath(p?: string): string | undefined {
    if (!p) return undefined;
    // Relative to cwd if it lives under — keeps logs compact on user repos.
    const cwd = process.cwd();
    if (p.startsWith(cwd + path.sep)) return path.relative(cwd, p);
    return p;
}

/**
 * Emit a single structured log line for a tool action. Safe to call
 * liberally — the formatting is cheap and the output respects the
 * BHAI_TOOL_DEBUG env.
 *
 * Format: `🔧 [tool] sub_agent=id role=r | path:line — action`
 * The outer Bhai process logger prepends the ISO timestamp, so we
 * don't add one inside.
 */
export function logToolAction(entry: ToolActionLog): void {
    const mode = DEBUG_MODE();
    if (mode === "off") return;
    const pretty = prettyPath(entry.filePath);
    const loc = pretty ? (entry.line ? `${pretty}:${entry.line}` : pretty) : "";
    const ctx =
        entry.context && Object.keys(entry.context).length > 0
            ? Object.entries(entry.context)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")
            : "";
    // Inline the context between the tool name and the file/action so a
    // reader can see "which agent, which role, which file, what action"
    // at a glance — mirrors the information density of the old
    // "🔧 Sub-agent X (role): toolname" format but adds the file + action.
    const head = ctx ? `🔧 [${entry.tool}] ${ctx}` : `🔧 [${entry.tool}]`;
    const body = [loc, entry.action].filter(Boolean).join(" — ");
    console.log(body ? `${head} | ${body}` : head);
}

/**
 * Pull the most likely "primary path" from a tool-arg object. Used by
 * the sub-agent tool-exec loop to give every tool call a file-aware
 * breadcrumb without the individual tools having to log themselves.
 */
export function extractPrimaryPath(fnArgs: unknown): string | undefined {
    if (!fnArgs || typeof fnArgs !== "object") return undefined;
    const args = fnArgs as Record<string, unknown>;
    for (const key of ["file_path", "path", "notebook_path", "file", "dest_path", "parent_dir"]) {
        const v = args[key];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
}

/**
 * Lifted from several tool sites — short-describe a tool call in a
 * single human line so logToolAction's `action` field is consistent.
 */
export function summarizeToolCall(fnName: string, fnArgs: unknown): string | undefined {
    if (!fnArgs || typeof fnArgs !== "object") return undefined;
    const a = fnArgs as Record<string, unknown>;
    switch (fnName) {
        case "edit":
            return a.replace_all === true
                ? `replace all occurrences of '${String(a.old_string ?? "").slice(0, 60)}…'`
                : `replace '${String(a.old_string ?? "").slice(0, 60)}…'`;
        case "write":
            return `write ${typeof a.content === "string" ? `${a.content.length} bytes` : "content"}`;
        case "read":
            return a.offset ? `read from line ${a.offset}` : "read full file";
        case "append_file":
            return "append to file";
        case "grep":
            return `grep ${String(a.pattern ?? "").slice(0, 60)}${a.glob ? ` in ${a.glob}` : ""}`;
        case "glob":
            return `glob ${String(a.pattern ?? "")}`;
        case "shell_exec":
        case "shell_exec_background":
            return `$ ${String(a.command ?? "").slice(0, 120)}`;
        case "test_run":
            return `run tests${a.pattern ? ` matching ${a.pattern}` : ""}`;
        case "fix_issue":
            return `localize ${String(a.error_message ?? "").slice(0, 80)}`;
        case "git_op":
            return `git ${String(a.operation ?? "?")}${a.branch ? ` (${a.branch})` : ""}`;
        case "codebase_query":
            return `query ${String(a.operation ?? "?")}${a.name ? ` ${a.name}` : ""}`;
        case "scaffold_project":
            return `scaffold ${String(a.template ?? "")} as ${String(a.name ?? "")}`;
        default:
            return undefined;
    }
}
