// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Smart Tool Output Truncation ─────────────
// Tool-specific truncation strategies that preserve the most valuable
// parts of tool output rather than blindly cutting at a char limit.

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

/** Keep head + tail of output (head-heavy). Good for files. */
function truncateHeadTail(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    const headSize = Math.floor(maxChars * 0.6);
    const tailSize = maxChars - headSize - 60; // room for separator
    const head = output.substring(0, headSize);
    const tail = output.substring(output.length - tailSize);
    const omitted = output.length - headSize - tailSize;
    return `${head}\n\n...[truncated ${omitted} chars]...\n\n${tail}`;
}

/** Keep more of the tail (errors are at the bottom). Good for shell output. */
function truncateTailHeavy(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    const headSize = Math.floor(maxChars * 0.25);
    const tailSize = maxChars - headSize - 60;
    const head = output.substring(0, headSize);
    const tail = output.substring(output.length - tailSize);
    const omitted = output.length - headSize - tailSize;
    return `${head}\n\n...[truncated ${omitted} chars]...\n\n${tail}`;
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
            return obj.substring(0, maxValueLen) + "...";
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
        const pruned = pruneKeepingIds(parsed);
        const result = JSON.stringify(pruned, null, 1);
        if (result.length <= maxChars) return result;
        return truncateHeadTail(result, maxChars);
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
            return truncateHeadTail(importantText, maxChars);
        }

        const remaining = maxChars - importantText.length - 40;
        const restText = rest.join("\n").substring(0, remaining);
        return `${importantText}\n\n...[${rest.length} descriptive lines truncated]...\n${restText}`;
    }
}

/** Keep id/type/tag fields in JSON objects, truncate text and description fields. */
function pruneKeepingIds(obj: unknown): unknown {
    if (typeof obj === "string") {
        return obj.length > 100 ? obj.substring(0, 100) + "..." : obj;
    }
    if (Array.isArray(obj)) {
        const items = obj.slice(0, 20).map(item => pruneKeepingIds(item));
        if (obj.length > 20) {
            items.push(`...(${obj.length - 20} more elements)`);
        }
        return items;
    }
    if (obj !== null && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            // Keep id, type, tag, role, name, href fields intact
            if (/^(id|type|tag|role|name|href|action|value|checked|selected)$/i.test(key)) {
                result[key] = value;
            } else if (typeof value === "string" && value.length > 80) {
                result[key] = value.substring(0, 80) + "...";
            } else {
                result[key] = pruneKeepingIds(value);
            }
        }
        return result;
    }
    return obj;
}

/** Default truncation: simple head cut (current behavior). */
function truncateDefault(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    return output.substring(0, maxChars);
}

// ── Public API ───────────────────────────────

/**
 * Smart-truncate tool output based on the tool name.
 * Uses tool-specific strategies to preserve the most valuable parts.
 */
export function smartTruncate(toolName: string, output: string, maxChars = DEFAULT_MAX_CHARS): string {
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
