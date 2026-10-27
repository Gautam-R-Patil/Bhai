// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Common types for tool-call parsers.
// Shape matches the OpenAI `ChatCompletionMessageToolCall` that Bhai's LLM
// client already consumes — a ParsedToolCall is slot-compatible with
// `response.choices[0].message.tool_calls[]`.

export interface ParsedToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        /** JSON-encoded arguments string (always a string, even when empty). */
        arguments: string;
    };
}

export interface ParseResult {
    /** Text content remaining after tool-call markup is stripped, or null when none. */
    content: string | null;
    /** Extracted tool calls, or null when the model output had none. */
    toolCalls: ParsedToolCall[] | null;
}

export interface ToolCallParser {
    parse(text: string): ParseResult;
}

// ── Shared helpers ─────────────────────────────

let __uuidFn: () => string = () => {
    // RFC 4122 v4 (Node 20+ has crypto.randomUUID, but this is hot-path
    // parser code; a local 16-byte hex is fine for id slots.
    // Avoid a node:crypto import here so this module is bundler-friendly.
    const h = (n: number) =>
        Math.floor(Math.random() * 16 ** n)
            .toString(16)
            .padStart(n, "0");
    return `${h(8)}${h(8)}${h(8)}${h(8)}`;
};

// Test seam so unit tests can pin ids if needed. Not currently used.
export function _setRngForTests(fn: () => string): void {
    __uuidFn = fn;
}

export function shortId(hexChars: 8 | 24 = 8): string {
    const buf = __uuidFn();
    return buf.slice(0, hexChars);
}

export function rawNotFound(text: string): ParseResult {
    return { content: text, toolCalls: null };
}
