// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ChatML-XML tool-call format:
//   <tool_call>{"name": "func", "arguments": {...}}</tool_call>
// Also handles unclosed <tool_call> at end-of-string (truncated generation).

import {
    type ParseResult,
    type ParsedToolCall,
    type ToolCallParser,
    rawNotFound,
    shortId,
} from "./types.js";

const OPEN_TAG = "<tool_call>";

// Captures both closed and unclosed forms. Group 1 = closed, Group 2 = unclosed.
const PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|<tool_call>\s*([\s\S]*)/g;

export const chatmlXmlParser: ToolCallParser = {
    parse(text: string): ParseResult {
        if (typeof text !== "string" || !text.includes(OPEN_TAG)) {
            return rawNotFound(text);
        }
        try {
            const toolCalls: ParsedToolCall[] = [];
            PATTERN.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = PATTERN.exec(text)) !== null) {
                const rawJson = (match[1] ?? match[2] ?? "").trim();
                if (!rawJson) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(rawJson);
                } catch {
                    continue;
                }
                if (
                    parsed === null ||
                    typeof parsed !== "object" ||
                    Array.isArray(parsed)
                ) {
                    continue;
                }
                const obj = parsed as { name?: unknown; arguments?: unknown };
                if (typeof obj.name !== "string") continue;
                const args = obj.arguments === undefined ? {} : obj.arguments;
                toolCalls.push({
                    id: `call_${shortId(8)}`,
                    type: "function",
                    function: {
                        name: obj.name,
                        arguments: JSON.stringify(args),
                    },
                });
            }

            if (toolCalls.length === 0) return rawNotFound(text);

            const firstTagIdx = text.indexOf(OPEN_TAG);
            const prefix = text.slice(0, firstTagIdx).trim();
            return {
                content: prefix.length > 0 ? prefix : null,
                toolCalls,
            };
        } catch {
            return rawNotFound(text);
        }
    },
};
