// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── edit ──────────────────────────────────────
// Claude Code–style exact-string file editor.
//   • File must have been read in this process (ReadRegistry) — catches
//     hallucinated edits and stale-context drift
//   • `old_string` must occur exactly once (unless `replace_all=true`) —
//     no silent wrong-location edits
//   • Atomic: either the full change applies or nothing changes
//   • Returns a minimal unified-diff preview for the caller to render

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";
import { hashContent, hasRegistryEntry, recordRead, wasRead } from "./read-registry.js";

// ── Diff helper ───────────────────────────────

const DIFF_CONTEXT_LINES = 3;

/**
 * Produce a minimal unified-diff preview for a single-region replacement.
 * We know `before` and `after` differ only where `oldStr` → `newStr`, so
 * locate the span, emit surrounding context, then - old lines, + new lines.
 */
function buildDiffPreview(before: string, after: string, _oldStr: string, _newStr: string): string {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");

    // Find the first differing line from the top
    let top = 0;
    const maxScan = Math.min(beforeLines.length, afterLines.length);
    while (top < maxScan && beforeLines[top] === afterLines[top]) top++;

    // Find the first differing line from the bottom
    let bottom = 0;
    while (
        bottom < maxScan - top &&
        beforeLines[beforeLines.length - 1 - bottom] === afterLines[afterLines.length - 1 - bottom]
    ) {
        bottom++;
    }

    const beforeStart = Math.max(0, top - DIFF_CONTEXT_LINES);
    const afterStart = beforeStart;
    const beforeEnd = beforeLines.length - bottom;
    const afterEnd = afterLines.length - bottom;
    const trailEnd = Math.min(beforeLines.length, beforeEnd + DIFF_CONTEXT_LINES);

    const lines: string[] = [];
    for (let i = beforeStart; i < top; i++) {
        lines.push("  " + beforeLines[i]);
    }
    for (let i = top; i < beforeEnd; i++) {
        lines.push("- " + beforeLines[i]);
    }
    for (let i = top; i < afterEnd; i++) {
        lines.push("+ " + afterLines[i]);
    }
    for (let i = beforeEnd; i < trailEnd; i++) {
        lines.push("  " + beforeLines[i]);
    }

    const headerStart = beforeStart + 1;
    const headerLen = Math.max(1, beforeEnd - beforeStart + (trailEnd - beforeEnd));
    return `@@ -${headerStart},${headerLen} +${afterStart + 1},${Math.max(1, afterEnd - afterStart + (trailEnd - beforeEnd))} @@\n${lines.join("\n")}`;
}

// ── Tool ──────────────────────────────────────

export const edit: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "edit",
            description:
                "Edit a file by replacing an exact string with a new string. " +
                "REQUIRES a prior successful `read` of the file in this process — else the edit is refused. " +
                "`old_string` must occur exactly once in the file, unless `replace_all=true`. " +
                "This is the primary tool for modifying existing files. Atomic: either the full change applies or nothing changes.",
            parameters: {
                type: "object",
                properties: {
                    file_path: {
                        type: "string",
                        description: "Absolute or relative file path.",
                    },
                    old_string: {
                        type: "string",
                        description:
                            "The exact text to find and replace. Include enough surrounding context so the match is unique.",
                    },
                    new_string: {
                        type: "string",
                        description: "The replacement text. Must differ from `old_string`.",
                    },
                    replace_all: {
                        type: "boolean",
                        description:
                            "If true, replace every occurrence of `old_string`. If false (default), exactly one occurrence is required.",
                    },
                },
                required: ["file_path", "old_string", "new_string"],
            },
        },
    },

    async handler(input) {
        const rawPath = input.file_path as string;
        const oldStr = (input.old_string as string) ?? "";
        const newStr = (input.new_string as string) ?? "";
        const replaceAll = input.replace_all === true;
        // Pre-edit hint from the built-in LSP hook (if fired). Surfaced in
        // the tool result so the model sees "this symbol is defined at X"
        // before deciding whether the edit is still right.
        const lspHint = typeof input._lsp_preedit_hint === "string" ? (input._lsp_preedit_hint as string) : undefined;

        if (!rawPath) {
            return JSON.stringify({ error: "file_path is required" });
        }
        if (oldStr === "") {
            return JSON.stringify({ error: "old_string must not be empty" });
        }
        if (oldStr === newStr) {
            return JSON.stringify({
                error: "old_string and new_string are identical — no edit to perform",
            });
        }

        const filePath = path.resolve(rawPath);
        auditLog("file_edit", { path: filePath, replace_all: replaceAll });

        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(filePath)) {
            return JSON.stringify({
                error: `Editing "${filePath}" is not allowed — this path is part of the bot's own codebase and is write-protected.`,
            });
        }

        let stats;
        try {
            stats = statSync(filePath);
        } catch (err) {
            return JSON.stringify({ error: `File not found: ${filePath} (${(err as Error).message})` });
        }
        if (!stats.isFile()) {
            return JSON.stringify({ error: `Not a file: ${filePath}` });
        }

        // Read-before-edit enforcement
        if (!wasRead(filePath)) {
            const reason = hasRegistryEntry(filePath)
                ? "File has changed on disk since the last read. Call `read` again before editing."
                : "You must call `read` on this file before editing it.";
            return JSON.stringify({ error: reason });
        }

        let before: string;
        try {
            before = readFileSync(filePath, "utf-8");
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }

        // Occurrence check
        const parts = before.split(oldStr);
        const occurrences = parts.length - 1;
        if (occurrences === 0) {
            return JSON.stringify({
                error: "`old_string` was not found in the file. It must match exactly, including whitespace and indentation.",
            });
        }
        if (occurrences > 1 && !replaceAll) {
            return JSON.stringify({
                error: `\`old_string\` appears ${occurrences} times in the file. Pass \`replace_all=true\` to replace every occurrence, or include more surrounding context so the match is unique.`,
            });
        }

        const after = replaceAll ? parts.join(newStr) : before.replace(oldStr, newStr);

        // Write
        try {
            const dir = path.dirname(filePath);
            if (dir) mkdirSync(dir, { recursive: true });
            writeFileSync(filePath, after, "utf-8");
        } catch (err) {
            return JSON.stringify({ error: `Write failed: ${(err as Error).message}` });
        }

        // Update registry so subsequent edits see the new hash
        recordRead(filePath, hashContent(after));

        const preview = buildDiffPreview(before, after, oldStr, newStr);

        // ── Post-edit LSP diagnostics (SOTA Tier-1) ──
        // After the write, ask the LSP server whether this edit broke
        // anything. Surfaces type/parse errors in the tool response so
        // the next iteration sees them immediately — no need for the
        // agent to remember to call `lsp getDiagnostics` itself.
        // Gated by ATLAS_NO_POST_EDIT_DIAGNOSTICS for users who don't
        // want the extra latency.
        let diagnosticsSummary: string | undefined;
        let postEditErrorCount = 0;
        let lspWasReached = false;
        if (process.env.ATLAS_NO_POST_EDIT_DIAGNOSTICS !== "true" && isLspWorthy(filePath)) {
            try {
                const { lsp } = await import("./lsp.js");
                const raw = await lsp.handler({
                    operation: "getDiagnostics",
                    file_path: filePath,
                });
                const parsed = JSON.parse(String(raw)) as {
                    success?: boolean;
                    error_count?: number;
                    warning_count?: number;
                    diagnostics?: Array<{ line: number; severity: string; message: string; source?: string }>;
                };
                if (parsed?.success) {
                    lspWasReached = true;
                    postEditErrorCount = parsed.error_count ?? 0;
                    if (postEditErrorCount > 0) {
                        const top = (parsed.diagnostics ?? [])
                            .filter((d) => d.severity === "error")
                            .slice(0, 5)
                            .map((d) => `  L${d.line}: [${d.source ?? "lsp"}] ${d.message}`);
                        diagnosticsSummary = `⚠️ ${postEditErrorCount} error(s)${parsed.warning_count ? ` + ${parsed.warning_count} warning(s)` : ""} after edit:\n${top.join("\n")}`;
                    }
                }
            } catch {
                /* LSP not installed / language unsupported — silent */
            }
        }

        // ── Confidence score ─────────────────────
        // A single number in [0, 1] summarizing how likely the edit did
        // what the agent intended. Composes: pre-edit LSP hint availability
        // (did we verify the target exists?), post-edit diagnostic errors,
        // match fuzziness (long old_string = surgical context = higher
        // chance of accidental duplicate match). Surfaced so downstream
        // UIs can warn the user and so the agent itself can decide whether
        // to proceed or backtrack on the next iteration.
        let confidence = 1.0;
        if (!lspHint && isLspWorthy(filePath)) confidence -= 0.1;          // pre-edit signal missing
        if (lspWasReached && postEditErrorCount > 0) {
            confidence -= Math.min(0.5, 0.2 + postEditErrorCount * 0.05);  // type/parse errors after edit
        }
        if (!lspWasReached && isLspWorthy(filePath)) confidence -= 0.05;   // couldn't verify
        if (oldStr.length > 1500) confidence -= 0.05;                      // very long context — brittle
        if (replaceAll && occurrences > 3) confidence -= 0.05;             // wide blast radius
        confidence = Math.max(0, Math.min(1, confidence));

        return JSON.stringify({
            success: true,
            path: filePath,
            replacements_made: replaceAll ? occurrences : 1,
            preview,
            confidence: Number(confidence.toFixed(2)),
            ...(lspHint ? { lsp_preedit_hint: lspHint } : {}),
            ...(diagnosticsSummary ? { post_edit_diagnostics: diagnosticsSummary } : {}),
        });
    },
};

// ── LSP-worthy extension allowlist ────────────
const LSP_WORTHY_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go"]);
function isLspWorthy(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return LSP_WORTHY_EXTS.has(ext);
}
