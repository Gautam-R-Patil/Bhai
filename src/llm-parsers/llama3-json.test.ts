// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getParser } from "./index.js";

const parser = getParser("llama3_json");

describe("llama3_json parser", () => {
    it("returns raw text when no `{` and no <|python_tag|>", () => {
        const { content, toolCalls } = parser.parse("plain answer");
        expect(content).toBe("plain answer");
        expect(toolCalls).toBeNull();
    });

    it("extracts a JSON object with name + arguments", () => {
        const raw = `{"name": "get_weather", "arguments": {"city": "SF"}}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("get_weather");
        expect(JSON.parse(toolCalls![0].function.arguments)).toEqual({
            city: "SF",
        });
    });

    it("accepts 'parameters' as an alias for 'arguments'", () => {
        const raw = `{"name": "ls", "parameters": {"path": "."}}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(JSON.parse(toolCalls![0].function.arguments)).toEqual({
            path: ".",
        });
    });

    it("strips leading narration", () => {
        const raw = `Here goes: {"name": "ls", "arguments": {}}`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe("Here goes:");
        expect(toolCalls).toHaveLength(1);
    });

    it("extracts multiple JSON objects in sequence", () => {
        const raw = `{"name": "a", "arguments": {}} {"name": "b", "arguments": {"x": 1}}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls![0].function.name).toBe("a");
        expect(toolCalls![1].function.name).toBe("b");
    });

    it("skips JSON objects missing `name` or `arguments`", () => {
        const raw = `{"noname": 1} {"name": "ok", "arguments": {}}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("ok");
    });

    it("handles the <|python_tag|> prefix", () => {
        const raw = `narration\n<|python_tag|>{"name": "run", "arguments": {"code": "x"}}`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe("narration");
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("run");
    });

    it("returns raw text when JSON is malformed", () => {
        const raw = `{not valid json`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe(raw);
        expect(toolCalls).toBeNull();
    });

    it("serializes non-dict arguments as JSON", () => {
        const raw = `{"name": "echo", "arguments": "hello"}`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        // arguments field on the ToolCall is always a JSON-encoded string
        expect(toolCalls![0].function.arguments).toBe('"hello"');
    });
});
