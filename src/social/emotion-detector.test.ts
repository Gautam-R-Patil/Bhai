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

describe("emotion scoring", () => {
    it("a frustrated cue is not out-scored by a smaller lexicon's cue", () => {
        // "frustrated" has the largest lexicon; size-normalised scoring made one
        // frustrated hit lose to one "happy" hit ("thanks"). Raw count fixes it.
        expect(detectEmotion("this is so annoying, thanks").primary).toBe("frustrated");
    });

    it("keeps caps/exclamation arousal when no lexicon word matched", () => {
        const e = detectEmotion("STOP SHOUTING AT ME!!!");
        expect(e.arousal).toBeGreaterThan(0.5);
    });

    it("does not score negated praise as positive", () => {
        const e = detectEmotion("this is not amazing and not helpful at all");
        expect(e.valence).toBeLessThanOrEqual(0);
        expect(e.primary).not.toBe("excited");
        expect(e.primary).not.toBe("happy");
    });

    it("a negator in a previous clause does not suppress a later cue", () => {
        // "not" negates "a fan", not "terrible" one clause later.
        expect(detectEmotion("not a fan, this is terrible").primary).toBe("frustrated");
    });

    it("counts an overlapping phrase once (longest wins)", () => {
        // "appreciate" ⊂ "really appreciate" must not double-count and dilute.
        const e = detectEmotion("really appreciate it");
        expect(e.primary).toBe("grateful");
        expect(e.valence).toBeGreaterThanOrEqual(0.85);
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

    // Regression guard for the caller-starvation bug: the relationship/length
    // modules only fire when the call site forwards these opts (agent.ts).
    it("relationshipDepth and preferredLength light up the tone modules", () => {
        const r = buildDynamicContextReminder("hey", { hour: 14, relationshipDepth: 0.9, preferredLength: "terse" });
        expect(r).toContain("close relationship");
        expect(r).toContain("concise");
    });
});
