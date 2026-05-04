// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getParser } from "./index.js";

const parser = getParser("deepseek_v3_1");

// Unicode token refs (fullwidth angle brackets + block elements)
const CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
const CALL_BEGIN = "<｜tool▁call▁begin｜>";
const SEP = "<｜tool▁sep｜>";
const CALL_END = "<｜tool▁call▁end｜>";
const CALLS_END = "<｜tool▁calls▁end｜>";

describe("deepseek_v3_1 parser", () => {
    it("returns raw text when the opening unicode token is absent", () => {
        const { content, toolCalls } = parser.parse("plain answer");
        expect(content).toBe("plain answer");
        expect(toolCalls).toBeNull();
    });

    it("extracts a single call (name then args, no type field)", () => {
        const raw = `${CALLS_BEGIN}${CALL_BEGIN}read_file${SEP}{"path": "a"}${CALL_END}${CALLS_END}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("read_file");
        expect(toolCalls![0].function.arguments).toBe('{"path": "a"}');
    });

    it("handles multiple calls", () => {
        const raw = `${CALLS_BEGIN}${CALL_BEGIN}a${SEP}{}${CALL_END}${CALL_BEGIN}b${SEP}{"x": 1}${CALL_END}${CALLS_END}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls![0].function.name).toBe("a");
        expect(toolCalls![1].function.name).toBe("b");
        expect(toolCalls![1].function.arguments).toBe('{"x": 1}');
    });

    it("preserves leading narration", () => {
        const raw = `Let me check.\n${CALLS_BEGIN}${CALL_BEGIN}ls${SEP}{}${CALL_END}${CALLS_END}`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe("Let me check.");
        expect(toolCalls).toHaveLength(1);
    });

    it("trims whitespace around name and arguments", () => {
        const raw = `${CALLS_BEGIN}${CALL_BEGIN}  named  ${SEP}  {"x":1}  ${CALL_END}${CALLS_END}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls![0].function.name).toBe("named");
        expect(toolCalls![0].function.arguments).toBe('{"x":1}');
    });

    it("returns raw text when the opening token is present but no matches", () => {
        const raw = `${CALLS_BEGIN} but nothing parseable`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe(raw);
        expect(toolCalls).toBeNull();
    });

    it("id format is call_ + 8 hex", () => {
        const raw = `${CALLS_BEGIN}${CALL_BEGIN}x${SEP}{}${CALL_END}${CALLS_END}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls![0].id).toMatch(/^call_[0-9a-f]{8}$/);
    });
});
