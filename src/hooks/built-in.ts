// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Built-in Hooks ────────────────────────────
// Ship-with-the-agent hooks that fire in-process (no subprocess
// spawn). Registered ahead of user/project hooks in registry.ts so
// user overrides still win.
//
// Currently shipping: lspHoverBeforeEdit — augments Edit calls with
// LSP workspaceSymbol lookups for identifiers referenced in
// `old_string`, surfacing a short signature hint in the tool result
// when LSP can confirm where a symbol is defined. Helps the model
// catch signature drift before writing stale edits.

import path from "node:path";
import type { HookDefinition, HookHandlerResult } from "./registry.js";

type HookMap = Partial<
    Record<"PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "Stop", HookDefinition[]>
>;

// ── Identifier Extraction ────────────────────

const METHOD_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]+)\s*\(/g;
const FUNCTION_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]+)\s*\(/g;
const KEYWORDS = new Set([
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
    "in",
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

function extractIdentifiers(text: string, max = 4): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    // Method calls first — they're the highest-signal signature-drift case
    for (const m of text.matchAll(METHOD_CALL_RE)) {
        const name = m[2];
        if (KEYWORDS.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= max) return out;
    }
    for (const m of text.matchAll(FUNCTION_CALL_RE)) {
        const name = m[1];
        if (KEYWORDS.has(name) || seen.has(name)) continue;
        // Skip PascalCase (likely a type/class constructor — less useful signal)
        if (/^[A-Z]/.test(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= max) return out;
    }
    return out;
}

// ── LSP hover handler ───────────────────────

const MAX_HOVER_BYTES = 600;

// File extensions whose edits benefit from an LSP symbol lookup.
// Everything else (markdown, JSON, YAML, plain text, SQL, lock files, etc.)
// skips the hook — pattern-matching on identifiers-in-docs is noise and
// the LSP roundtrips waste latency.
const LSP_WORTHY_EXTS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".pyi", ".rs", ".go", ".java", ".kt",
    ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp",
    ".swift", ".m", ".mm", ".cs", ".php", ".rb",
    ".scala", ".lua",
]);

async function lspHoverBeforeEdit(payload: unknown): Promise<HookHandlerResult | null> {
    const p = payload as { tool?: string; input?: Record<string, unknown> } | null;
    if (!p || p.tool !== "edit" || !p.input) return null;
    const input = p.input;
    const oldString = input.old_string as string | undefined;
    const filePath = input.file_path as string | undefined;
    if (!oldString || !filePath || oldString.length > 4000) return null;

    // Short-circuit non-code file edits — avoids useless LSP calls on
    // markdown / JSON / YAML changes.
    const ext = path.extname(filePath).toLowerCase();
    if (!LSP_WORTHY_EXTS.has(ext)) return null;

    const identifiers = extractIdentifiers(oldString);
    if (identifiers.length === 0) return null;

    try {
        const { lsp } = await import("../tools/coding/lsp.js");
        const absFile = path.resolve(filePath);
        const notes: string[] = [];
        let bytesUsed = 0;

        for (const ident of identifiers) {
            if (bytesUsed >= MAX_HOVER_BYTES) break;
            try {
                const raw = await lsp.handler({
                    operation: "workspaceSymbol",
                    filePath: absFile,
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
                if (!parsed?.success || !parsed.symbols || parsed.symbols.length === 0) continue;
                const top = parsed.symbols.slice(0, 2);
                for (const s of top) {
                    const uri = s.location?.uri ?? "";
                    const locPath = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
                    const line = s.location?.range?.start?.line;
                    const linePart = typeof line === "number" ? `:${line + 1}` : "";
                    const container = s.containerName ? ` in ${s.containerName}` : "";
                    const kind = s.kind ?? "symbol";
                    const line1 = `${ident}: ${kind}${container} — ${locPath || "?"}${linePart}`;
                    if (bytesUsed + line1.length > MAX_HOVER_BYTES) break;
                    notes.push(line1);
                    bytesUsed += line1.length + 1;
                }
            } catch {
                // per-ident failure is silent; keep going
            }
        }

        if (notes.length === 0) return null;
        const hint = `LSP pre-edit reference check:\n${notes.join("\n")}`;
        return {
            modifiedInput: {
                ...input,
                _lsp_preedit_hint: hint.slice(0, MAX_HOVER_BYTES),
            },
        };
    } catch {
        return null;
    }
}

// ── Export ────────────────────────────────────

// Snapshot the target dir into the shadow-git checkpoint store before a file
// mutation. Returns null (passthrough) — never blocks or modifies input; the
// snapshot is a pure side effect. Fail-open inside ensureCheckpoint.
async function autoCheckpointBeforeMutation(payload: unknown): Promise<HookHandlerResult | null> {
    const p = payload as { tool?: string; input?: { file_path?: string } } | null;
    const fp = p?.input?.file_path;
    if (typeof fp !== "string" || !fp) return null;
    try {
        const { ensureCheckpoint } = await import("../tools/coding/checkpoint-manager.js");
        await ensureCheckpoint(path.dirname(path.resolve(fp)), `pre-${p?.tool ?? "mutation"}`);
    } catch {
        /* fail-open */
    }
    return null;
}

export const BUILTIN_HOOKS: HookMap = {
    PreToolUse: [
        {
            name: "builtin:lsp-hover-before-edit",
            matcher: "^edit$",
            handler: lspHoverBeforeEdit,
            timeout: 8000,
        },
        {
            name: "builtin:auto-checkpoint",
            matcher: "^(edit|write|append_file)$",
            handler: autoCheckpointBeforeMutation,
            timeout: 6000,
        },
    ],
};
