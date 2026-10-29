// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Robust JSON extraction from mixed text (LLM responses).
 * Handles nested braces, markdown code blocks, and trailing text.
 */

/**
 * Extract the first valid JSON value (object or array) from a string
 * that may contain surrounding prose, markdown, or extra text.
 */
export function extractJSON(text: string): string | null {
    // Tier 1: Direct parse
    const trimmed = text.trim();
    try {
        JSON.parse(trimmed);
        return trimmed;
    } catch { /* continue */ }

    // Tier 2: Markdown code block
    const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
        try {
            JSON.parse(codeBlock[1].trim());
            return codeBlock[1].trim();
        } catch { /* continue */ }
    }

    // Tier 3: Brace-balanced extraction (handles nested objects correctly)
    const objResult = extractBalanced(trimmed, "{", "}");
    if (objResult) return objResult;

    // Tier 4: Bracket-balanced extraction (for arrays)
    const arrResult = extractBalanced(trimmed, "[", "]");
    if (arrResult) return arrResult;

    return null;
}

/**
 * Find the first brace-balanced substring that parses as valid JSON.
 * Tracks nesting depth and respects string literals (won't count braces inside "...").
 */
function extractBalanced(text: string, open: string, close: string): string | null {
    let start = text.indexOf(open);
    while (start !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];

            if (escape) { escape = false; continue; }
            if (ch === "\\" && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;

            if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    const candidate = text.substring(start, i + 1);
                    try {
                        JSON.parse(candidate);
                        return candidate;
                    } catch {
                        // Matched braces but not valid JSON — try next opening brace
                        break;
                    }
                }
            }
        }

        // Find next opening brace after current start
        start = text.indexOf(open, start + 1);
    }
    return null;
}
