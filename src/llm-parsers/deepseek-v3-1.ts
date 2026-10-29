// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// DeepSeek V3.1 tool-call format:
//   <｜tool▁calls▁begin｜>
//   <｜tool▁call▁begin｜>function_name<｜tool▁sep｜>arguments<｜tool▁call▁end｜>
//   ...
//   <｜tool▁calls▁end｜>

import {
    type ParseResult,
    type ParsedToolCall,
    type ToolCallParser,
    rawNotFound,
    shortId,
} from "./types.js";

const START_TOKEN = "<｜Tool▁calls▁begin｜>";
const CALL_BEGIN = "<｜Tool▁call▁begin｜>";
const SEP = "<｜Tool▁sep｜>";
const CALL_END = "<｜Tool▁call▁end｜>";

// Build the regex at module load (not at parse time) and use the actual
// unicode chars — needs /g plus case-insensitive for the "Tool" keyword
// because the raw tokens use lowercase `tool` but we define constants with
// capital T. Use literal-fullwidth-pipe + literal-block-elements to match.
const PATTERN = new RegExp(
    `${escapeRegex(CALL_BEGIN)}([\\s\\S]*?)${escapeRegex(
        SEP,
    )}([\\s\\S]*?)${escapeRegex(CALL_END)}`,
    "gi",
);

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const deepseekV31Parser: ToolCallParser = {
    parse(text: string): ParseResult {
        if (
            typeof text !== "string" ||
            text.toLowerCase().indexOf(START_TOKEN.toLowerCase()) < 0
        ) {
            return rawNotFound(text);
        }
        try {
            const toolCalls: ParsedToolCall[] = [];
            PATTERN.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = PATTERN.exec(text)) !== null) {
                const funcName = (match[1] ?? "").trim();
                const funcArgs = (match[2] ?? "").trim();
                if (!funcName) continue;
                toolCalls.push({
                    id: `call_${shortId(8)}`,
                    type: "function",
                    function: {
                        name: funcName,
                        arguments: funcArgs,
                    },
                });
            }

            if (toolCalls.length === 0) return rawNotFound(text);

            const lower = text.toLowerCase();
            const startIdx = lower.indexOf(START_TOKEN.toLowerCase());
            const content =
                startIdx > 0 ? text.slice(0, startIdx).trim() : null;
            return {
                content: content && content.length > 0 ? content : null,
                toolCalls,
            };
        } catch {
            return rawNotFound(text);
        }
    },
};
