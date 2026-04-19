// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── fix_issue ────────────────────────────────
// Agentless-style localization brief. Given an error message (and
// optionally a file/line), this tool:
//   1. Classifies the error via the shared coding-error classifier
//   2. Extracts the file:line:col if not already provided
//   3. Reads ±N lines of surrounding code
//   4. Runs LSP workspaceSymbol on nearby identifiers for related
//      definitions (best-effort; skipped if LSP unavailable)
//   5. Returns a structured "fix briefing" the agent can read in a
//      single tool call before calling `edit` + `test_run` to repair.
//
// The tool itself does NOT generate candidate edits — it just localizes
// and hands off context. Repair and validation are the agent's normal
// Edit + test_run loop.

import fs from "node:fs";
import path from "node:path";
import { type CodeErrorLocation, classifyError, ErrorCategory, extractCodeLocation } from "../../agents/error-types.js";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import type { ToolDefinition } from "../get-current-time.js";

const SURROUND_LINES_DEFAULT = 12;
const MAX_SURROUND = 60;
const MAX_IDENTIFIERS = 3;

const METHOD_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const FN_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const STOPWORDS = new Set([
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "return",
    "throw",
    "new",
    "delete",
    "typeof",
    "instanceof",
    "await",
    "async",
    "yield",
    "function",
    "class",
    "const",
    "let",
    "var",
    "import",
    "export",
    "from",
    "of",
    "as",
    "do",
    "try",
    "catch",
    "finally",
    "break",
    "continue",
    "default",
    "this",
    "super",
    "void",
    "null",
    "true",
    "false",
    "undefined",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Promise",
    "Error",
    "Math",
    "JSON",
    "console",
    "process",
]);

function pickIdentifiers(snippet: string, max = MAX_IDENTIFIERS): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of snippet.matchAll(METHOD_RE)) {
        const name = m[2];
        if (STOPWORDS.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= max) return out;
    }
    for (const m of snippet.matchAll(FN_CALL_RE)) {
        const name = m[1];
        if (STOPWORDS.has(name) || seen.has(name)) continue;
        if (/^[A-Z]/.test(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= max) return out;
    }
    return out;
}

async function lookupSymbols(
    rootFile: string,
    identifiers: string[],
): Promise<{ identifier: string; hits: { file?: string; line?: number; kind?: string; container?: string }[] }[]> {
    if (identifiers.length === 0) return [];
    try {
        const { lsp } = await import("./lsp.js");
        const results: {
            identifier: string;
            hits: { file?: string; line?: number; kind?: string; container?: string }[];
        }[] = [];
        for (const ident of identifiers) {
            try {
                const raw = await lsp.handler({
                    operation: "workspaceSymbol",
                    filePath: rootFile,
                    line: 1,
                    character: 1,
                    query: ident,
                });
                const parsed = JSON.parse(String(raw)) as {
                    success?: boolean;
                    symbols?: {
                        name: string;
                        kind?: string;
                        location?: { uri?: string; range?: { start?: { line?: number } } };
                        containerName?: string;
                    }[];
                };
                if (!parsed?.success || !parsed.symbols) {
                    results.push({ identifier: ident, hits: [] });
                    continue;
                }
                const hits = parsed.symbols.slice(0, 3).map((s) => ({
                    file: s.location?.uri?.replace(/^file:\/\//, "") ?? undefined,
                    line:
                        typeof s.location?.range?.start?.line === "number"
                            ? s.location.range.start.line + 1
                            : undefined,
                    kind: s.kind ?? undefined,
                    container: s.containerName ?? undefined,
                }));
                results.push({ identifier: ident, hits });
            } catch {
                results.push({ identifier: ident, hits: [] });
            }
        }
        return results;
    } catch {
        return [];
    }
}

function categoryHint(category: ErrorCategory): string {
    switch (category) {
        case ErrorCategory.TypeError:
            return "A type mismatch. Read the reported type, then either adjust the call site's argument shape or widen/narrow the declared type — not both.";
        case ErrorCategory.SyntaxError:
            return "A parse error. Likely a missing brace/paren/semicolon near the reported line — fix syntactically, don't rewrite the logic.";
        case ErrorCategory.TestFailure:
            return "A failing test. Read the test's assertion to understand what invariant broke, then edit the implementation (not the test, unless the contract itself changed).";
        case ErrorCategory.LintError:
            return "A style violation. Run the linter's --fix/--write pass first; if it doesn't auto-resolve, make the minimal change to satisfy the rule.";
        case ErrorCategory.BuildError:
            return "A build failure. Check for missing imports, unresolved paths, or misconfigured bundler entries before touching business logic.";
        case ErrorCategory.ImportError:
            return "A module resolution failure. Verify the import path exists, the package is installed, and the exports match what's imported.";
        case ErrorCategory.RuntimeError:
            return "A runtime exception. Read the stack trace bottom-up — the innermost frame is usually where the bad data entered the bad function.";
        default:
            return "Localize to file:line first, read surrounding code, then make a minimal targeted edit. Run test_run to verify before claiming done.";
    }
}

function readSurround(
    file: string,
    line: number | undefined,
    surround: number,
): { snippet: string; startLine: number; endLine: number; totalLines: number } | null {
    try {
        const text = fs.readFileSync(file, "utf-8");
        const lines = text.split(/\r?\n/);
        const total = lines.length;
        if (typeof line !== "number" || line < 1) {
            // no line — return first ~30 lines for shape only
            const endLine = Math.min(total, 30);
            return {
                snippet: lines
                    .slice(0, endLine)
                    .map((l, i) => `${String(i + 1).padStart(5, " ")}\t${l}`)
                    .join("\n"),
                startLine: 1,
                endLine,
                totalLines: total,
            };
        }
        const start = Math.max(1, line - surround);
        const end = Math.min(total, line + surround);
        const snippet = lines
            .slice(start - 1, end)
            .map((l, i) => {
                const n = start + i;
                const mark = n === line ? ">" : " ";
                return `${mark} ${String(n).padStart(5, " ")}\t${l}`;
            })
            .join("\n");
        return { snippet, startLine: start, endLine: end, totalLines: total };
    } catch {
        return null;
    }
}

export const fixIssue: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "fix_issue",
            description:
                "Localize a coding error and return a structured fix briefing (category, file/line, surrounding code, related symbol definitions via LSP, category-specific hint). Use when handed an error message you haven't investigated yet. Does NOT edit files itself — call `edit` and `test_run` to perform and verify the repair after reviewing the briefing.",
            parameters: {
                type: "object",
                properties: {
                    error_message: {
                        type: "string",
                        description: "The error text to localize. Typically pasted from a build/test/run failure.",
                    },
                    file: {
                        type: "string",
                        description:
                            "Optional file path (absolute or relative). If omitted, extracted from error_message when possible.",
                    },
                    line: {
                        type: "number",
                        description: "Optional line number. If omitted, extracted from error_message when possible.",
                    },
                    cwd: {
                        type: "string",
                        description:
                            "Working directory for path resolution. Defaults to the current working directory.",
                    },
                    surround: {
                        type: "number",
                        description: `Lines of context above/below the target line to include (default ${SURROUND_LINES_DEFAULT}, max ${MAX_SURROUND}).`,
                    },
                },
                required: ["error_message"],
            },
        },
    },

    async handler(input) {
        const errorMessage = (input.error_message as string) || "";
        if (!errorMessage.trim()) {
            return JSON.stringify({ error: "error_message is required and must be non-empty" });
        }
        const rawCwd = (input.cwd as string) || process.cwd();
        const cwd = path.resolve(rawCwd);
        const surround = Math.min(MAX_SURROUND, Math.max(1, Number(input.surround) || SURROUND_LINES_DEFAULT));

        // 1. Classify + localize
        const classified = classifyError(errorMessage, "fix_issue");
        const extracted = classified.codeLocation ?? extractCodeLocation(errorMessage);
        const providedFile = input.file as string | undefined;
        const providedLine = typeof input.line === "number" ? (input.line as number) : undefined;

        const loc: CodeErrorLocation = {
            file: providedFile ?? extracted?.file,
            line: providedLine ?? extracted?.line,
            column: extracted?.column,
        };

        let absFile: string | null = null;
        if (loc.file) {
            const resolved = path.isAbsolute(loc.file) ? loc.file : path.resolve(cwd, loc.file);
            if (!isPathAllowed(resolved)) {
                const reason = getPathBlockedReason(resolved) ?? `Path "${resolved}" is not allowed.`;
                return JSON.stringify({ error: reason });
            }
            if (fs.existsSync(resolved)) {
                absFile = resolved;
                loc.file = resolved;
            }
        }

        // 2. Read surrounding code
        let surroundInfo: ReturnType<typeof readSurround> = null;
        if (absFile) {
            surroundInfo = readSurround(absFile, loc.line, surround);
        }

        // 3. LSP lookups on nearby identifiers
        let symbolLookups: {
            identifier: string;
            hits: { file?: string; line?: number; kind?: string; container?: string }[];
        }[] = [];
        if (absFile && surroundInfo) {
            const identifiers = pickIdentifiers(surroundInfo.snippet);
            symbolLookups = await lookupSymbols(absFile, identifiers);
        }

        return JSON.stringify({
            success: true,
            category: classified.category,
            retryable: classified.retryable,
            location: {
                file: loc.file,
                line: loc.line,
                column: loc.column,
            },
            hint: categoryHint(classified.category),
            surrounding_code: surroundInfo
                ? {
                      start_line: surroundInfo.startLine,
                      end_line: surroundInfo.endLine,
                      total_lines: surroundInfo.totalLines,
                      snippet: surroundInfo.snippet,
                  }
                : null,
            related_symbols: symbolLookups.filter((s) => s.hits.length > 0),
            next_steps: [
                absFile
                    ? `Review the marked line (>) in surrounding_code and identify the minimal change.`
                    : `File not resolved — run grep/glob or ask for the exact path before editing.`,
                `Read ${absFile ?? loc.file ?? "the affected file"} in full if ≥12 lines of context is needed, then edit with an exact-string match.`,
                `After the edit, call test_run (optionally scoped with a pattern) to verify the fix.`,
            ],
        });
    },
};
