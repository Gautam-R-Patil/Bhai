// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Parse Dispatcher ──────────────────────────
// Single entry point: parseFile(lang, path, content) → ParseResult.
// Handles size caps, encoding fallbacks, LFS pointer detection, and
// per-file error isolation. Never throws.

import { countLoc, extractCalls, extractImports, extractSymbols } from "./regex-extractors.js";
import {
    extractCallsTS,
    extractImportsTS,
    extractSymbolsTS,
    treeSitterSupports,
} from "./tree-sitter-extractors.js";
import type { Language, ParseResult } from "./types.js";

export const MAX_FILE_BYTES = 500_000; // 500 KB per file
// Raised from 100 KB in 4L.3: real hand-written files commonly exceed
// 100 KB (agent.ts, generated schemas, long routers). Tree-sitter parses
// 500 KB files in ~50ms; regex is still bounded by its per-line scan.
export const LFS_PREFIX = "version https://git-lfs";

export * from "./types.js";
export { parseFile };

// ── Parser selection ──────────────────────────
// Tree-sitter is the default for supported languages (currently TS + JS).
// Set ATLAS_CODE_PARSER=regex to force the legacy regex extractors for
// every file — useful if the tree-sitter binding fails to load on a
// platform or a specific grammar produces bad results and you need a
// quick fallback. Individual failures inside tree-sitter already fall
// back automatically; this switch is for global opt-out.
function useTreeSitterFor(lang: Language): boolean {
    if (process.env.ATLAS_CODE_PARSER === "regex") return false;
    return treeSitterSupports(lang);
}

/**
 * Parse a single file. Returns a best-effort result; on any failure the
 * returned object has the error set and empty arrays.
 *
 * @param lang       Detected language (or "file-only" if unknown)
 * @param filePath   Absolute path (used for error messages only)
 * @param content    Pre-read file contents (caller handles UTF-8/latin-1)
 * Never throws — callers must inspect `error` on the returned ParseResult.
 */
async function parseFile(lang: Language, filePath: string, content: string): Promise<ParseResult> {
    try {
        // LFS pointer → treat as file-only
        if (content.startsWith(LFS_PREFIX) && content.length < 200) {
            return { symbols: [], imports: [], calls: [], loc: 0, truncated: false, error: "lfs-pointer" };
        }
        // Size cap
        let truncated = false;
        if (content.length > MAX_FILE_BYTES) {
            truncated = true;
            return { symbols: [], imports: [], calls: [], loc: countLoc(content, lang), truncated, error: null };
        }
        if (lang === "file-only") {
            return { symbols: [], imports: [], calls: [], loc: countLoc(content, lang), truncated: false, error: null };
        }

        // Prefer tree-sitter for supported languages; empty-symbol return
        // is our signal that the binding failed to load — fall back to regex.
        if (useTreeSitterFor(lang)) {
            const tsSymbols = await extractSymbolsTS(content, lang);
            if (tsSymbols.length > 0) {
                const tsImports = await extractImportsTS(content, lang);
                const tsCalls = await extractCallsTS(content, lang);
                return {
                    symbols: tsSymbols,
                    imports: tsImports,
                    calls: tsCalls,
                    loc: countLoc(content, lang),
                    truncated: false,
                    error: null,
                };
            }
            // fall through to regex
        }

        const symbols = extractSymbols(lang, content);
        const imports = extractImports(lang, content);
        const calls = extractCalls(lang, content, symbols);
        return { symbols, imports, calls, loc: countLoc(content, lang), truncated: false, error: null };
    } catch (err) {
        return {
            symbols: [],
            imports: [],
            calls: [],
            loc: 0,
            truncated: false,
            error: `parse-error ${filePath}: ${(err as Error).message}`,
        };
    }
}
