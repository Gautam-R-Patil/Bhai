// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export type Source = "user" | "tool" | "reflection" | "consolidation";

export interface GateDecision {
    reject: boolean;
    reason: string;
}

export interface AllowDecision {
    allow: boolean;
    reason: string;
}

const TOOL_RESULT_PREFIX = /^\[tool result\]/;
const WM_SPILL_PREFIX = /^\[WM-Spill\]/;
const MAX_CONTENT_LENGTH = 2000;

export function hardReject(
    content: string,
    source: Source,
    _importance: number,
    _category: string,
): GateDecision {
    if (source === "tool" && TOOL_RESULT_PREFIX.test(content)) {
        return { reject: true, reason: "tool_result_prefix" };
    }
    if (content.includes('"screenshot_base64"') || content.includes('"image_base64"')) {
        return { reject: true, reason: "binary_blob" };
    }
    if (WM_SPILL_PREFIX.test(content)) {
        return { reject: true, reason: "wm_spill_marker" };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
        return { reject: true, reason: "oversize" };
    }
    if (isPureJson(content)) {
        return { reject: true, reason: "pure_json" };
    }
    return { reject: false, reason: "" };
}

function isPureJson(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length < 2) return false;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const looksObj = first === "{" && last === "}";
    const looksArr = first === "[" && last === "]";
    if (!looksObj && !looksArr) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

const CURATED_CATEGORIES = new Set([
    "identity",
    "person",
    "session_summary",
    "knowledge_crystal",
    "recovery_reflection",
    "brand",
    "research",
    "voice",
]);

const HIGH_IMPORTANCE_THRESHOLD = 8;

export function hardAllow(
    _content: string,
    source: Source,
    importance: number,
    category: string,
): AllowDecision {
    if (source === "reflection") return { allow: true, reason: "source_reflection" };
    if (source === "consolidation") return { allow: true, reason: "source_consolidation" };
    if (importance >= HIGH_IMPORTANCE_THRESHOLD) return { allow: true, reason: "high_importance" };
    if (CURATED_CATEGORIES.has(category)) return { allow: true, reason: "curated_category" };
    return { allow: false, reason: "" };
}
