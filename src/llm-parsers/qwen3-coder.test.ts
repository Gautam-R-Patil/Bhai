// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getParser } from "./index.js";

const parser = getParser("qwen3_coder");

describe("qwen3_coder parser", () => {
    it("returns raw text when no <function= prefix present", () => {
        const { content, toolCalls } = parser.parse("hello world");
        expect(content).toBe("hello world");
        expect(toolCalls).toBeNull();
    });

    it("extracts a single function call with string parameters", () => {
        const raw = `<tool_call>
<function=read_file>
<parameter=path>foo.ts</parameter>
</function>
</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls![0].function.name).toBe("read_file");
        expect(JSON.parse(toolCalls![0].function.arguments)).toEqual({
            path: "foo.ts",
        });
    });

    it("converts JSON-looking parameter values (numbers, booleans, null, arrays)", () => {
        const raw = `<tool_call>
<function=calc>
<parameter=x>42</parameter>
<parameter=y>true</parameter>
<parameter=z>null</parameter>
<parameter=arr>[1, 2, 3]</parameter>
</function>
</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls).toHaveLength(1);
        const args = JSON.parse(toolCalls![0].function.arguments);
        expect(args).toEqual({ x: 42, y: true, z: null, arr: [1, 2, 3] });
    });

    it("keeps unparseable values as strings", () => {
        const raw = `<tool_call>
<function=write>
<parameter=content>hello world</parameter>
</function>
</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        const args = JSON.parse(toolCalls![0].function.arguments);
        expect(args).toEqual({ content: "hello world" });
    });

    it("extracts multiple parameters without splitting on inner >", () => {
        const raw = `<tool_call>
<function=echo>
<parameter=a>1 &gt; 0</parameter>
<parameter=b>x</parameter>
</function>
</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        const args = JSON.parse(toolCalls![0].function.arguments);
        expect(args).toEqual({ a: "1 > 0", b: "x" });
    });

    it("handles narration before the first tool call", () => {
        const raw = `Sure, I'll read that.
<tool_call>
<function=read_file>
<parameter=path>a.txt</parameter>
</function>
</tool_call>`;
        const { content, toolCalls } = parser.parse(raw);
        expect(content).toBe("Sure, I'll read that.");
        expect(toolCalls).toHaveLength(1);
    });

    it("returns raw text on malformed block (no </function>)", () => {
        const raw = `<tool_call>
<function=bad
<parameter=x>y</parameter>
</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        // No usable function name extractable → no tool calls
        expect(toolCalls).toBeNull();
    });

    it("assigns deterministic-shape ids (call_ + 24 hex)", () => {
        const raw = `<tool_call>
<function=noop>
</function>
</tool_call>`;
        const { toolCalls } = parser.parse(raw);
        expect(toolCalls![0].id).toMatch(/^call_[0-9a-f]{24}$/);
    });
});
