// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { extractJSON } from "./json-extract.js";

describe("extractJSON", () => {
    describe("tier 1 — direct parse", () => {
        it("returns the trimmed string when it's already valid JSON", () => {
            const input = '{"foo":"bar"}';
            expect(extractJSON(input)).toEqual('{"foo":"bar"}');
        });

        it("handles surrounding whitespace", () => {
            expect(extractJSON('   {"a":1}\n\n  ')).toEqual('{"a":1}');
        });

        it("accepts array-root JSON", () => {
            expect(extractJSON("[1, 2, 3]")).toEqual("[1, 2, 3]");
        });

        it("accepts nested objects", () => {
            const nested = '{"a":{"b":{"c":[1,2,3]}}}';
            expect(extractJSON(nested)).toEqual(nested);
        });
    });

    describe("tier 2 — markdown code blocks", () => {
        it("extracts JSON from ```json``` fenced block", () => {
            const text = 'Here is the data:\n```json\n{"key":"value"}\n```\nThank you.';
            expect(extractJSON(text)).toEqual('{"key":"value"}');
        });

        it("extracts JSON from unlabeled ``` block", () => {
            const text = "```\n[1,2,3]\n```";
            expect(extractJSON(text)).toEqual("[1,2,3]");
        });

        it("handles multi-line JSON inside a code block", () => {
            const text = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
            const result = extractJSON(text);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ a: 1, b: 2 });
        });

        it("picks JSON code block even when there's surrounding prose", () => {
            const text =
                "I'll respond with JSON below:\n```json\n{\"answer\":42}\n```\nIs this helpful?";
            expect(extractJSON(text)).toEqual('{"answer":42}');
        });
    });

    describe("tier 3 — brace-balanced extraction (nested objects)", () => {
        it("finds the first valid object in mixed text", () => {
            const text = 'Sure! {"result":"ok"} Hope that helps.';
            expect(extractJSON(text)).toEqual('{"result":"ok"}');
        });

        it("correctly tracks nesting depth", () => {
            const text = 'Before {"a":{"b":1}} after';
            expect(extractJSON(text)).toEqual('{"a":{"b":1}}');
        });

        it("ignores braces inside string values", () => {
            // The } inside the string must NOT close the outer object.
            const text = 'prose {"greeting":"hello }"} trailing';
            const result = extractJSON(text);
            expect(result).toEqual('{"greeting":"hello }"}');
            expect(JSON.parse(result!)).toEqual({ greeting: "hello }" });
        });

        it("respects escaped quotes inside strings", () => {
            const text = 'leading {"s":"she said \\"hi\\""} trailing';
            const result = extractJSON(text);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ s: 'she said "hi"' });
        });

        it("skips incomplete/invalid JSON and finds the next valid one", () => {
            // First "object" has a syntax error; parser moves on.
            const text = 'garbage {invalid,} then {"good":true}';
            expect(extractJSON(text)).toEqual('{"good":true}');
        });

        it("handles deeply nested objects", () => {
            const deep = '{"a":{"b":{"c":{"d":{"e":{"f":"deep"}}}}}}';
            expect(extractJSON(`prefix ${deep} suffix`)).toEqual(deep);
        });
    });

    describe("tier 4 — array-balanced extraction", () => {
        it("extracts array after a failed object search", () => {
            const text = "notes: [1, 2, 3] done";
            expect(extractJSON(text)).toEqual("[1, 2, 3]");
        });

        it("prefers the first inner object over the containing array (documented quirk)", () => {
            // Tier 3 (brace-balanced) runs BEFORE tier 4 (array-balanced).
            // For `[{"id":1},{"id":2}]` the tier-3 scan finds the first `{`
            // and returns the first valid object, not the full array.
            // This is a real limitation of extractJSON for tool-call-style
            // LLM outputs that wrap an argument array — callers that need
            // the full array should either prompt the LLM to emit the
            // array ALONE (no leading `[` in code-block form prevents
            // tier-2 from hitting it first) OR post-process by parsing
            // the response with JSON.parse if tier-1 succeeds.
            const text = 'result: [{"id":1},{"id":2}] ok';
            expect(extractJSON(text)).toEqual('{"id":1}');
        });

        it("gets the full array when the array is the direct root (tier 1)", () => {
            // Tier 1 direct parse catches it before tier 3 can split the
            // result — if the input IS valid JSON as-is, it round-trips.
            expect(extractJSON('[{"id":1},{"id":2}]')).toEqual('[{"id":1},{"id":2}]');
        });

        it("ignores brackets inside strings", () => {
            const text = 'start ["has ] bracket", "ok"] end';
            const result = extractJSON(text);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual(["has ] bracket", "ok"]);
        });
    });

    describe("failure paths", () => {
        it("returns null for empty input", () => {
            expect(extractJSON("")).toBeNull();
            expect(extractJSON("   ")).toBeNull();
        });

        it("returns null for non-JSON prose", () => {
            expect(extractJSON("Hello world, how are you today?")).toBeNull();
        });

        it("returns null for a malformed code block", () => {
            expect(extractJSON("```json\n{bad syntax\n```")).toBeNull();
        });

        it("returns null for an opening brace with no close", () => {
            expect(extractJSON('some text { unterminated')).toBeNull();
        });

        it("extracts the first balanced {} pair even from messy input", () => {
            // `{}` is valid JSON (empty object) so any input that CONTAINS
            // a balanced {} pair — even inside apparent noise — yields it.
            // Callers that need "must be non-trivial JSON" should check
            // the parsed shape themselves.
            expect(extractJSON("}{}}{}{{}{{")).toEqual("{}");
        });

        it("returns null for input with only unbalanced braces (no {} or [] sub-string)", () => {
            expect(extractJSON("{{{{{")).toBeNull();
            expect(extractJSON("}}}}}")).toBeNull();
        });
    });

    describe("realistic LLM outputs", () => {
        it("extracts tool-call-style JSON from a chatty response", () => {
            const llmOut =
                "I'll call the function with these arguments:\n\n```json\n" +
                '{"tool":"search","query":"hello world","limit":10}\n' +
                "```\n\nLet me know the result.";
            const result = extractJSON(llmOut);
            expect(result).not.toBeNull();
            const parsed = JSON.parse(result!);
            expect(parsed.tool).toEqual("search");
            expect(parsed.query).toEqual("hello world");
            expect(parsed.limit).toEqual(10);
        });

        it("handles JSON with mixed newlines and indentation", () => {
            const llmOut = `Here you go:
{
    "status": "ok",
    "items": [
        { "name": "first" },
        { "name": "second" }
    ]
}
Done!`;
            const result = extractJSON(llmOut);
            expect(result).not.toBeNull();
            const parsed = JSON.parse(result!);
            expect(parsed.status).toEqual("ok");
            expect(parsed.items).toHaveLength(2);
        });

        it("picks the first valid JSON when the response has multiple candidates", () => {
            const text = 'First: {"a":1}. Second: {"b":2}.';
            // Tier 3 returns the FIRST valid candidate.
            expect(extractJSON(text)).toEqual('{"a":1}');
        });
    });

    describe("edge cases", () => {
        it("handles unicode/emoji inside JSON strings", () => {
            const input = '{"emoji":"🚀","cjk":"日本語","arabic":"مرحبا"}';
            expect(extractJSON(input)).toEqual(input);
        });

        it("handles JSON inside prose that contains other { characters", () => {
            // Tricky: prose mentions a single `{` then actual JSON follows.
            const text = "The set { comprises { these {\"key\":\"value\"}";
            // Tier 3 walks `{` positions in order; the stray prose `{`
            // doesn't balance to valid JSON, so it advances to the real
            // object and returns it.
            const result = extractJSON(text);
            expect(result).toEqual('{"key":"value"}');
        });

        it("handles backslashes at end of string value", () => {
            const input = '{"path":"C:\\\\Users\\\\name"}';
            const result = extractJSON(input);
            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ path: "C:\\Users\\name" });
        });
    });
});
