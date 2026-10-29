// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Smart Tool Output Truncation ─────────────
// Tool-specific truncation strategies that preserve the most valuable
// parts of tool output rather than blindly cutting at a char limit.

import { CODE_TOOLS, protect } from "../security/pii-vault.js";

const DEFAULT_MAX_CHARS = 4000;

// ── Tool Category Detection ──────────────────

type TruncationStrategy = "head_tail" | "tail_heavy" | "json_prune" | "keep_ids" | "default";

const TOOL_STRATEGIES: Record<string, TruncationStrategy> = {
    // Shell tools — errors are usually at the end
    shell_exec: "tail_heavy",
    shell_exec_background: "tail_heavy",
    shell_check_process: "tail_heavy",
    shell_wait_process: "tail_heavy",

    // Browser tools — element IDs are critical
    browser_scan: "keep_ids",
    browser_extract: "keep_ids",
    browser_analyze: "keep_ids",

    // Search/memory tools — JSON structure matters
    web_search: "json_prune",
    memory_search: "json_prune",
    memory_list: "json_prune",
    deep_research: "json_prune",

    // File tools — head and tail both matter
    read: "head_tail",
    grep: "head_tail",
    glob: "head_tail",
    list_directory: "head_tail",
};

// ── Strategy Implementations ─────────────────

/**
 * Drop a dangling half of a UTF-16 surrogate pair left behind by a substring
 * cut. A naive `.substring()` can slice between the two code units of an
 * astral char (emoji, some CJK), leaving a lone surrogate that becomes U+FFFD
 * when UTF-8-encoded on transport. Every cut below routes through this.
 */
function trimLoneSurrogates(s: string): string {
    if (s.length === 0) return s;
    let start = 0;
    let end = s.length;
    const first = s.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) start = 1; // leading low surrogate
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1; // trailing high surrogate
    return start === 0 && end === s.length ? s : s.substring(start, end);
}

/** Surrogate-safe substring cut. */
function cut(s: string, start: number, end?: number): string {
    return trimLoneSurrogates(s.substring(start, end));
}

/** Build a head/tail truncation at the given head ratio, honoring maxChars. */
function truncateSplit(output: string, maxChars: number, headRatio: number): string {
    if (output.length <= maxChars) return output;
    const headSize = Math.floor(maxChars * headRatio);
    const tailSize = maxChars - headSize - 60; // room for separator
    // Too small to fit head + tail + marker: plain head cut within the cap.
    if (tailSize < 1) return cut(output, 0, maxChars);
    const head = cut(output, 0, headSize);
    const tail = cut(output, output.length - tailSize);
    const omitted = output.length - head.length - tail.length;
    return `${head}\n\n...[truncated ${omitted} chars]...\n\n${tail}`;
}

/** Keep head + tail of output (head-heavy). Good for files. */
function truncateHeadTail(output: string, maxChars: number): string {
    return truncateSplit(output, maxChars, 0.6);
}

/** Keep more of the tail (errors are at the bottom). Good for shell output. */
function truncateTailHeavy(output: string, maxChars: number): string {
    return truncateSplit(output, maxChars, 0.25);
}

/** Parse JSON, keep structure but truncate long string values. */
function truncateJsonPrune(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;

    try {
        const parsed = JSON.parse(output);
        // Progressively more aggressive pruning to stay within maxChars
        for (const maxVal of [200, 100, 50, 20]) {
            const pruned = pruneJsonValues(parsed, maxVal);
            const result = JSON.stringify(pruned, null, 1);
            if (result.length <= maxChars) return result;
        }
        // Final: prune to minimal values and compact (no indentation)
        const minimal = pruneJsonValues(parsed, 10);
        const compact = JSON.stringify(minimal);
        if (compact.length <= maxChars) return compact;
        // Still too large — return a valid JSON summary instead of cutting mid-object
        return JSON.stringify({ _truncated: true, _originalSize: output.length, _message: "Output too large to include" });
    } catch {
        // Not valid JSON, fall back to head_tail
        return truncateHeadTail(output, maxChars);
    }
}

/** Recursively prune long string values in JSON objects/arrays. */
export function pruneJsonValues(obj: unknown, maxValueLen: number): unknown {
    if (typeof obj === "string") {
        if (obj.length > maxValueLen) {
            return cut(obj, 0, maxValueLen) + "...";
        }
        return obj;
    }
    if (Array.isArray(obj)) {
        // Keep first 10 items, note total count
        const items = obj.slice(0, 10).map(item => pruneJsonValues(item, maxValueLen));
        if (obj.length > 10) {
            items.push(`...(${obj.length - 10} more items)`);
        }
        return items;
    }
    if (obj !== null && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = pruneJsonValues(value, maxValueLen);
        }
        return result;
    }
    return obj;
}

/** Keep element IDs and structured data, truncate descriptions. Good for browser scan output. */
function truncateKeepIds(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;

    // Try to parse as JSON and keep id/type/tag fields, truncate text/description
    try {
        const parsed = JSON.parse(output);
        // Progressively prune fewer items / shorter values so the result stays
        // valid JSON. Never head_tail a JSON string — that cuts it mid-structure
        // into unparseable JSON (mirrors json_prune's valid-summary fallback).
        for (const [maxItems, maxVal] of [[20, 100], [10, 60], [5, 40]] as const) {
            const result = JSON.stringify(pruneKeepingIds(parsed, maxItems, maxVal), null, 1);
            if (result.length <= maxChars) return result;
        }
        const compact = JSON.stringify(pruneKeepingIds(parsed, 3, 20));
        if (compact.length <= maxChars) return compact;
        return JSON.stringify({ _truncated: true, _originalSize: output.length, _message: "Browser output too large to include" });
    } catch {
        // Not JSON, try to keep lines with IDs
        const lines = output.split("\n");
        const important: string[] = [];
        const rest: string[] = [];

        for (const line of lines) {
            // Keep lines containing IDs, tags, or element references
            if (/\b(id|ID|#\d|element|button|input|link|href)\b/i.test(line)) {
                important.push(line);
            } else {
                rest.push(line);
            }
        }

        const importantText = important.join("\n");
        if (importantText.length >= maxChars) {
            // Keep whole ID-bearing lines head-first so complete IDs survive —
            // head_tail would cut the middle out of the very lines we must keep.
            return headCapLines(important, maxChars);
        }

        const remaining = maxChars - importantText.length - 40;
        // No budget left for descriptive lines: return the ID lines alone rather
        // than overflowing the cap with a separator + a negative-length substring.
        if (remaining <= 0) return importantText;
        const restText = cut(rest.join("\n"), 0, remaining);
        return `${importantText}\n\n...[${rest.length} descriptive lines truncated]...\n${restText}`;
    }
}

/**
 * Keep id/type/tag fields in JSON objects, truncate text and description fields.
 * `maxItems`/`maxValueLen` let callers prune progressively harder so the result
 * stays within a char budget while remaining valid JSON. Identifying keys are
 * kept but still bounded by `maxValueLen` so harder passes actually shrink.
 */
function pruneKeepingIds(obj: unknown, maxItems = 20, maxValueLen = 80): unknown {
    if (typeof obj === "string") {
        return obj.length > maxValueLen ? cut(obj, 0, maxValueLen) + "..." : obj;
    }
    if (Array.isArray(obj)) {
        const items = obj.slice(0, maxItems).map(item => pruneKeepingIds(item, maxItems, maxValueLen));
        if (obj.length > maxItems) {
            items.push(`...(${obj.length - maxItems} more elements)`);
        }
        return items;
    }
    if (obj !== null && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            // Keep id, type, tag, role, name, href fields — but bound long string
            // values so progressive prune passes can still shrink the output.
            if (/^(id|type|tag|role|name|href|action|value|checked|selected)$/i.test(key)) {
                result[key] = typeof value === "string" && value.length > maxValueLen
                    ? cut(value, 0, maxValueLen) + "..."
                    : value;
            } else if (typeof value === "string" && value.length > maxValueLen) {
                result[key] = cut(value, 0, maxValueLen) + "...";
            } else {
                result[key] = pruneKeepingIds(value, maxItems, maxValueLen);
            }
        }
        return result;
    }
    return obj;
}

/** Accumulate whole lines head-first until the char budget is hit (keeps complete IDs). */
function headCapLines(lines: string[], maxChars: number): string {
    const kept: string[] = [];
    let len = 0;
    for (const line of lines) {
        const add = (kept.length ? 1 : 0) + line.length; // +1 for the joining newline
        if (len + add > maxChars) break;
        kept.push(line);
        len += add;
    }
    // A single line longer than the whole budget: fall back to a plain cut.
    return kept.length ? kept.join("\n") : cut(lines.join("\n"), 0, maxChars);
}

/** Default truncation: simple head cut (current behavior). */
function truncateDefault(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    return cut(output, 0, maxChars);
}

// ── Public API ───────────────────────────────

/**
 * Smart-truncate tool output based on the tool name.
 * Uses tool-specific strategies to preserve the most valuable parts.
 */
export function smartTruncate(toolName: string, raw: string, maxChars = DEFAULT_MAX_CHARS): string {
    if (raw.length <= maxChars) return raw;
    // Mask before cutting: a cut through "Authorization: Bearer abc…" leaves a
    // fragment no pattern recognises.
    const output = protect(raw, { credentials: !CODE_TOOLS.has(toolName) });
    if (output.length <= maxChars) return output;

    const strategy = TOOL_STRATEGIES[toolName] || "default";

    switch (strategy) {
        case "head_tail":    return truncateHeadTail(output, maxChars);
        case "tail_heavy":   return truncateTailHeavy(output, maxChars);
        case "json_prune":   return truncateJsonPrune(output, maxChars);
        case "keep_ids":     return truncateKeepIds(output, maxChars);
        default:             return truncateDefault(output, maxChars);
    }
}
