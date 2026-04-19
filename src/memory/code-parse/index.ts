// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Parse Dispatcher ──────────────────────────
// Single entry point: parseFile(lang, path, content) → ParseResult.
// Handles size caps, encoding fallbacks, LFS pointer detection, and
// per-file error isolation. Never throws.

import { countLoc, extractCalls, extractImports, extractSymbols } from "./regex-extractors.js";
import type { Language, ParseResult } from "./types.js";

export const MAX_FILE_BYTES = 100_000; // 100 KB per file
export const LFS_PREFIX = "version https://git-lfs";

export * from "./types.js";
export { parseFile };

/**
 * Parse a single file. Returns a best-effort result; on any failure the
 * returned object has the error set and empty arrays.
 *
 * @param lang       Detected language (or "file-only" if unknown)
 * @param filePath   Absolute path (used for error messages only)
 * @param content    Pre-read file contents (caller handles UTF-8/latin-1)
 * Never throws — callers must inspect `error` on the returned ParseResult.
 */
function parseFile(lang: Language, filePath: string, content: string): ParseResult {
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
