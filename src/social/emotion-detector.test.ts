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

    it("everyday words don't read as pressure or confusion", () => {
        expect(detectEmotion("what's the deadline for filing?").primary).toBe("neutral");
        expect(detectEmotion("I lost my keys again").primary).toBe("neutral");
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
        expect(buildDynamicContextReminder("hey", { hour: 0 })).toMatch(/keep it short unless they asked for detail/i);
        expect(buildDynamicContextReminder("hey", { hour: 23 })).not.toMatch(/\brest\b|late/i);
    });

    it("pressure gets a short fix-first steer, not sympathy", () => {
        const r = buildDynamicContextReminder("the build is broken, fix it asap", { hour: 14 });
        expect(r).toContain("fix first");
        expect(r).not.toContain("Acknowledge their feelings");
    });

    it("confusion gets no fix-first steer, and mornings don't push priorities", () => {
        expect(buildDynamicContextReminder("I'm confused, what do you mean", { hour: 14 })).not.toContain("fix first");
        expect(buildDynamicContextReminder("hey", { hour: 8 })).toBe("");
    });
});
