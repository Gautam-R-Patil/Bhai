// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ChatCompletion } from "openai/resources/chat/completions";
import { getParser, type ParsedToolCall } from "./llm-parsers/index.js";

// Detection signatures for each registered parser. First match wins.
const DETECTORS: Array<{ name: string; test: (s: string) => boolean }> = [
    { name: "deepseek_v3_1", test: (s) => s.includes("<｜tool▁call▁begin｜>") },
    { name: "qwen3_coder", test: (s) => s.includes("<function=") && s.includes("<parameter=") },
    { name: "chatml_xml", test: (s) => s.includes("<tool_call>") },
    { name: "llama3_json", test: (s) => s.includes("<|python_tag|>") },
];

/**
 * In-place: when the server returned content containing OSS-model tool-call
 * markup but `tool_calls` is empty, parse the content and fill `tool_calls`.
 * No-op on any failure — the raw content is preserved so the caller still
 * sees whatever came back.
 */
export function tryParseOssToolCalls(response: ChatCompletion): void {
    try {
        const choice = response?.choices?.[0];
        if (!choice) return;
        const msg = choice.message as
            | { content?: string | null; tool_calls?: unknown[] }
            | undefined;
        if (!msg) return;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (!content) return;

        const match = DETECTORS.find((d) => d.test(content));
        if (!match) return;

        const parser = getParser(match.name);
        const result = parser.parse(content);
        if (!result.toolCalls || result.toolCalls.length === 0) return;

        msg.tool_calls = result.toolCalls as unknown as ParsedToolCall[];
        msg.content = result.content ?? "";
    } catch {
        /* fail silent — leave response untouched */
    }
}
