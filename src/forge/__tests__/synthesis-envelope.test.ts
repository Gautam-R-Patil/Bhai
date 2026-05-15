// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { parseEnvelope, type SynthesisEnvelope } from "../synthesis.js";

const validRaw = JSON.stringify({
    handler_code: "module.exports = async (input) => input.x + 1;",
    tests: [
        { input: { x: 1 }, expected_kind: "returns_equals", expected_value: 2, description: "increments" },
        { input: { x: 5 }, expected_kind: "returns_equals", expected_value: 6, description: "again" },
        { input: { x: -1 }, expected_kind: "returns_equals", expected_value: 0, description: "negative" },
    ],
    capabilities_declared: [],
    side_effects: "none",
    synthesis_notes: "trivial increment",
});

describe("synthesis envelope parser", () => {
    it("parses a valid envelope", () => {
        const env = parseEnvelope(validRaw);
        expect(env.ok).toBe(true);
        if (env.ok) {
            expect(env.envelope.handler_code).toContain("input.x + 1");
            expect(env.envelope.tests).toHaveLength(3);
            expect(env.envelope.side_effects).toBe("none");
        }
    });

    it("extracts JSON from markdown fence", () => {
        const fenced = "```json\n" + validRaw + "\n```";
        const env = parseEnvelope(fenced);
        expect(env.ok).toBe(true);
    });

    it("rejects missing handler_code", () => {
        const env = parseEnvelope(JSON.stringify({ tests: [], capabilities_declared: [], side_effects: "none" }));
        expect(env.ok).toBe(false);
        if (!env.ok) expect(env.errors[0]).toMatch(/handler_code/);
    });

    it("rejects tests < 3", () => {
        const env = parseEnvelope(JSON.stringify({
            handler_code: "x",
            tests: [{ input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" }],
            capabilities_declared: [], side_effects: "none",
        }));
        expect(env.ok).toBe(false);
        if (!env.ok) expect(env.errors[0]).toMatch(/at least 3 tests/i);
    });

    it("rejects tests > 7", () => {
        const tests = Array.from({ length: 8 }, () => ({ input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" }));
        const env = parseEnvelope(JSON.stringify({
            handler_code: "x", tests, capabilities_declared: [], side_effects: "none",
        }));
        expect(env.ok).toBe(false);
        if (!env.ok) expect(env.errors[0]).toMatch(/at most 7 tests/i);
    });

    it("rejects unknown expected_kind", () => {
        const env = parseEnvelope(JSON.stringify({
            handler_code: "x",
            tests: [
                { input: {}, expected_kind: "magic_kind", expected_value: 1, description: "d" },
                { input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" },
                { input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" },
            ],
            capabilities_declared: [], side_effects: "none",
        }));
        expect(env.ok).toBe(false);
        if (!env.ok) expect(env.errors[0]).toMatch(/expected_kind/);
    });

    it("rejects malformed JSON", () => {
        const env = parseEnvelope("{ not json");
        expect(env.ok).toBe(false);
    });

    it("rejects handler_code longer than 50KB", () => {
        const big = "x".repeat(60_000);
        const env = parseEnvelope(JSON.stringify({
            handler_code: big,
            tests: [
                { input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" },
                { input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" },
                { input: {}, expected_kind: "returns_equals", expected_value: 1, description: "d" },
            ],
            capabilities_declared: [], side_effects: "none",
        }));
        expect(env.ok).toBe(false);
        if (!env.ok) expect(env.errors[0]).toMatch(/handler_code too large/i);
    });
});
