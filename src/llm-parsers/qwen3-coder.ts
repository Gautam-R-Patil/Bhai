// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Qwen3-Coder tool-call format (XML-style nested tags):
//   <tool_call>
//   <function=name>
//   <parameter=key>value</parameter>
//   </function>
//   </tool_call>

import {
    type ParseResult,
    type ParsedToolCall,
    type ToolCallParser,
    rawNotFound,
    shortId,
} from "./types.js";

const FUNCTION_PREFIX = "<function=";
const OPEN_TAG = "<tool_call>";

const TOOL_CALL_REGEX = /<tool_call>([\s\S]*?)<\/tool_call>|<tool_call>([\s\S]*?)$/g;
const FUNCTION_REGEX = /<function=([\s\S]*?)<\/function>|<function=([\s\S]*)$/g;
const PARAMETER_REGEX =
    /<parameter=([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/g;

// Decode only `&gt;`, `&lt;`, `&amp;` — these are the ones models emit inside
// param bodies. Full XML entity decoding is out of scope.
function decodeEntities(s: string): string {
    return s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function tryConvertValue(rawInput: string): unknown {
    const s = rawInput.trim();
    if (s.toLowerCase() === "null") return null;
    // Try JSON first (handles objects, arrays, strings, numbers, booleans)
    try {
        return JSON.parse(s);
    } catch {
        /* fall through */
    }
    // String fallback with entity decoding
    return decodeEntities(s);
}

function parseFunctionCall(functionStr: string): ParsedToolCall | null {
    const gtIdx = functionStr.indexOf(">");
    if (gtIdx < 0) return null;
    const funcName = functionStr.slice(0, gtIdx).trim();
    if (!funcName) return null;
    // Reject names that contain markup — a real function name is
    // /[a-zA-Z_][a-zA-Z0-9_]*/. Catch the malformed-block case where an
    // unclosed <function=bad\n<parameter…> would otherwise extract
    // "bad\n<parameter=x" as the name.
    if (/[<>\n\r\t]/.test(funcName)) return null;
    const paramsStr = functionStr.slice(gtIdx + 1);

    const paramDict: Record<string, unknown> = {};
    PARAMETER_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PARAMETER_REGEX.exec(paramsStr)) !== null) {
        const body = match[1] ?? "";
        const eq = body.indexOf(">");
        if (eq < 0) continue;
        const paramName = body.slice(0, eq).trim();
        let paramValue = body.slice(eq + 1);
        if (paramValue.startsWith("\n")) paramValue = paramValue.slice(1);
        if (paramValue.endsWith("\n")) paramValue = paramValue.slice(0, -1);
        paramDict[paramName] = tryConvertValue(paramValue);
    }

    return {
        id: `call_${shortId(24)}`,
        type: "function",
        function: {
            name: funcName,
            arguments: JSON.stringify(paramDict),
        },
    };
}

export const qwen3CoderParser: ToolCallParser = {
    parse(text: string): ParseResult {
        if (typeof text !== "string" || !text.includes(FUNCTION_PREFIX)) {
            return rawNotFound(text);
        }
        try {
            TOOL_CALL_REGEX.lastIndex = 0;
            const rawBlocks: string[] = [];
            let tcMatch: RegExpExecArray | null;
            while ((tcMatch = TOOL_CALL_REGEX.exec(text)) !== null) {
                rawBlocks.push(tcMatch[1] ?? tcMatch[2] ?? "");
            }
            // Fallback: if no <tool_call> wrapper, try the whole text
            if (rawBlocks.length === 0) rawBlocks.push(text);

            const functionStrs: string[] = [];
            for (const block of rawBlocks) {
                FUNCTION_REGEX.lastIndex = 0;
                let fnMatch: RegExpExecArray | null;
                while ((fnMatch = FUNCTION_REGEX.exec(block)) !== null) {
                    functionStrs.push(fnMatch[1] ?? fnMatch[2] ?? "");
                }
            }

            if (functionStrs.length === 0) return rawNotFound(text);

            const toolCalls: ParsedToolCall[] = [];
            for (const fs of functionStrs) {
                const tc = parseFunctionCall(fs);
                if (tc !== null) toolCalls.push(tc);
            }
            if (toolCalls.length === 0) return rawNotFound(text);

            const openIdx = text.indexOf(OPEN_TAG);
            const fnPrefixIdx = text.indexOf(FUNCTION_PREFIX);
            const firstIdx =
                openIdx >= 0
                    ? openIdx
                    : fnPrefixIdx >= 0
                      ? fnPrefixIdx
                      : -1;
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
