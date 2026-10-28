// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { buildDynamicContextReminder } from "../prompts/dynamic-context.js";
import { detectEmotion } from "./emotion-detector.js";

describe("emotion detector", () => {
    it("matches whole words only", () => {
        expect(detectEmotion("turn these notes into bullet points").primary).toBe("neutral");
        expect(detectEmotion("whatever works, just pick one").primary).toBe("neutral");
        expect(detectEmotion("ugh this is so annoying, it's broken").primary).toBe("frustrated");
    });
});

describe("dynamic context tone", () => {
    it("midnight counts as late, and late replies don't nag about rest or the hour", () => {
        expect(buildDynamicContextReminder("hey", { hour: 0 })).toContain("Keep responses brief");
        expect(buildDynamicContextReminder("hey", { hour: 23 })).not.toMatch(/\brest\b|late/i);
    });

    it("pressure gets a short fix-first steer, not sympathy", () => {
        const r = buildDynamicContextReminder("the build is broken, fix it asap", { hour: 14 });
        expect(r).toContain("fix first");
        expect(r).not.toContain("Acknowledge their feelings");
    });
});
