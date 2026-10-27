// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool-call parser registry ──────────────────
// When an OSS model is served via a non-OpenAI-compatible backend (vLLM
// raw /generate, SGLang without the tool-parser shim, llama.cpp), the model
// emits its native tool-call format as plain text instead of a structured
// `tool_calls` array. Bhai normally talks to OpenRouter-compatible endpoints
// via Convex, so this layer is a fallback middleware: when the LLM response
// has empty `tool_calls` but its `content` contains a known tag, we parse.

import { chatmlXmlParser } from "./chatml-xml.js";
import { qwen3CoderParser } from "./qwen3-coder.js";
import { llama3JsonParser } from "./llama3-json.js";
import { deepseekV31Parser } from "./deepseek-v3-1.js";
import type { ToolCallParser } from "./types.js";

export type { ParseResult, ParsedToolCall, ToolCallParser } from "./types.js";

const REGISTRY: Record<string, ToolCallParser> = {
    chatml_xml: chatmlXmlParser,
    qwen3_coder: qwen3CoderParser,
    llama3_json: llama3JsonParser,
    deepseek_v3_1: deepseekV31Parser,
    deepseek_v31: deepseekV31Parser, // alias
};

export function getParser(name: string): ToolCallParser {
    const parser = REGISTRY[name];
    if (!parser) {
        const available = listParsers().join(", ");
        throw new Error(
            `Unknown parser '${name}'. Available: ${available || "(none)"}`,
        );
    }
    return parser;
}

export function listParsers(): string[] {
    return Object.keys(REGISTRY).sort();
}
