// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Shared tool-result helpers ─────────────────
// Replaces the ~420-site pattern of `return JSON.stringify({ error: ... })`
// scattered across `src/tools/*`. Every tool handler must return a JSON string;
// these helpers keep the shape consistent and prevent drift (e.g. callers
// relying on `typeof parsed.error === "string"`).

function coerceErrorMessage(message: unknown): string {
    if (typeof message === "string") return message;
    if (message instanceof Error) return message.message;
    return String(message);
}

/**
 * Build an error-shaped tool result. The `error` field is always a string,
 * preserved even if `extra` accidentally contains an `error` key.
 */
export function toolError(message: unknown, extra?: Record<string, unknown>): string {
    const payload: Record<string, unknown> = { ...(extra ?? {}) };
    payload.error = coerceErrorMessage(message);
    return JSON.stringify(payload);
}

/**
 * Build a success-shaped tool result. Object payloads are serialized directly.
 * Primitives and arrays are wrapped under `{ result: <value> }` so the result
 * is always a JSON object (callers can assume `typeof parsed === "object"`).
 */
export function toolSuccess(data: unknown): string {
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        return JSON.stringify(data);
    }
    return JSON.stringify({ result: data });
}

/**
 * Variant-typed dispatcher for handlers that track ok/fail internally.
 */
export type ToolResultVariant =
    | { ok: true; data: unknown }
    | { ok: false; error: unknown; extra?: Record<string, unknown> };

export function toolResult(variant: ToolResultVariant): string {
    return variant.ok ? toolSuccess(variant.data) : toolError(variant.error, variant.extra);
}

/**
 * Detect whether a serialized tool result is an error. Used by downstream
 * retry/fallback logic that needs to distinguish thrown exceptions from
 * returned-error-strings.
 */
export function isErrorResultString(raw: unknown): boolean {
    if (typeof raw !== "string" || !raw) return false;
    try {
        const parsed = JSON.parse(raw);
        return (
            parsed !== null && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        );
    } catch {
        return false;
    }
}

/**
 * Normalize an arbitrary handler return into a tool-result JSON string.
 * Strings pass through (already serialized). `null`/`undefined` become JSON
 * `"null"`. Objects are `JSON.stringify`d.
 */
export function ensureToolResult(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "null";
    return JSON.stringify(value);
}
