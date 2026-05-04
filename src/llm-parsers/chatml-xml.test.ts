// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getParser } from "./index.js";

const parser = getParser("chatml_xml");

describe("chatml_xml parser", () => {
    it("returns the raw text when no <tool_call> tag is present", () => {
        const { content, toolCalls } = parser.parse("just a plain answer");
        expect(content).toBe("just a plain answer");
        expect(toolCalls).toBeNull();
    });

    it("extracts a single closed tool call", () => {
        const raw = `<tool_call>{"name": "read_file", "arguments": {"path": "foo.ts"}}</tool_call>`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBeNull();
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("read_file");
        expect(JSON.parse(toolCalls![0].function.arguments)).toEqual({
            path: "foo.ts",
        });
        expect(toolCalls![0].id).toMatch(/^call_[0-9a-f]{8}$/);
        expect(toolCalls![0].type).toBe("function");
    });

    it("splits the leading narration from the tool call", () => {
        const raw = `Let me check that.\n<tool_call>{"name": "ls", "arguments": {}}</tool_call>`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe("Let me check that.");
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("ls");
    });

    it("extracts multiple tool calls", () => {
        const raw = `<tool_call>{"name": "a", "arguments": {}}</tool_call>\n<tool_call>{"name": "b", "arguments": {"x": 1}}</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls![0].function.name).toBe("a");
        expect(toolCalls![1].function.name).toBe("b");
        expect(JSON.parse(toolCalls![1].function.arguments)).toEqual({ x: 1 });
    });

    it("handles unclosed <tool_call> at end of string (truncated generation)", () => {
        const raw = `<tool_call>{"name": "long", "arguments": {"content": "xxxxx"`;
        const { toolCalls } = parser.parse(raw);
        // The JSON is truncated so parse must fail cleanly, no tool calls
        expect(toolCalls).toBeNull();
    });

    it("handles unclosed <tool_call> with valid JSON inside", () => {
        const raw = `<tool_call>{"name": "short", "arguments": {}}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("short");
    });

    it("skips entries with no `name` field", () => {
        const raw = `<tool_call>{"arguments": {}}</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toBeNull();
    });

    it("defaults to empty-object arguments when missing", () => {
        const raw = `<tool_call>{"name": "noop"}</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(JSON.parse(toolCalls![0].function.arguments)).toEqual({});
    });

    it("gracefully returns raw text on malformed JSON", () => {
        const raw = `<tool_call>not json at all</tool_call>`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe(raw);
        expect(toolCalls).toBeNull();
    });

    it("preserves content whitespace trimming on the leading segment", () => {
        const raw = `   preface   \n<tool_call>{"name":"x","arguments":{}}</tool_call>`;
        const { content } = parser.parse(raw);
        expect(content).toBe("preface");
    });
});
