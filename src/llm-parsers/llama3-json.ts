// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Llama 3.x / 4 tool-call format:
//   JSON objects with "name" and "arguments" (or "parameters"), optionally
//   preceded by <|python_tag|>. May contain multiple objects.

import {
    type ParseResult,
    type ParsedToolCall,
    type ToolCallParser,
    rawNotFound,
    shortId,
} from "./types.js";

const BOT_TOKEN = "<|python_tag|>";

// Minimal streaming JSON-object extractor: walks the string, tracks depth,
// honors strings + escapes. Returns `[obj, endIndexExclusive]` on success.
function rawDecodeJson(text: string, start: number): [unknown, number] | null {
    if (text[start] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                const slice = text.slice(start, i + 1);
                try {
                    return [JSON.parse(slice), i + 1];
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

export const llama3JsonParser: ToolCallParser = {
    parse(text: string): ParseResult {
        if (
            typeof text !== "string" ||
            (!text.includes(BOT_TOKEN) && !text.includes("{"))
        ) {
            return rawNotFound(text);
        }

        try {
            const toolCalls: ParsedToolCall[] = [];
            let endIndex = -1;
            for (let i = 0; i < text.length; i++) {
                if (text[i] !== "{") continue;
                if (i <= endIndex) continue;
                const decoded = rawDecodeJson(text, i);
                if (!decoded) continue;
                const [obj, next] = decoded;
                endIndex = next - 1;
                if (
                    obj === null ||
                    typeof obj !== "object" ||
                    Array.isArray(obj)
                ) {
                    continue;
                }
                const o = obj as {
                    name?: unknown;
                    arguments?: unknown;
                    parameters?: unknown;
                };
                const name = typeof o.name === "string" ? o.name : undefined;
                const args = o.arguments !== undefined ? o.arguments : o.parameters;
                if (!name || args === undefined) continue;
                const argsStr =
                    typeof args === "string" ? JSON.stringify(args) : JSON.stringify(args);
                toolCalls.push({
                    id: `call_${shortId(8)}`,
                    type: "function",
                    function: { name, arguments: argsStr },
                });
            }

            if (toolCalls.length === 0) return rawNotFound(text);

            // Content = text before the first tool-call or <|python_tag|>
            let firstIdx = text.indexOf("{");
            if (text.includes(BOT_TOKEN)) {
                firstIdx = text.indexOf(BOT_TOKEN);
            }
            const content =
                firstIdx > 0 ? text.slice(0, firstIdx).trim() : null;
            return {
                content: content && content.length > 0 ? content : null,
                toolCalls,
            };
        } catch {
            return rawNotFound(text);
        }
    },
};
