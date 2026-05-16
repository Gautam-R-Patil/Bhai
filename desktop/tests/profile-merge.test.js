// Tests profile-merge.js: name + tone validation + W2 persona fields.
import { describe, it, expect } from "vitest";
import { mergeProfile, ALLOWED_TONES, ALLOWED_PERSONAS } from "../wizard/profile-merge.js";

describe("mergeProfile — name + tone (legacy)", () => {
    it("requires a name on first save", () => {
        expect(() => mergeProfile({}, {})).toThrow(/name is required/);
        expect(() => mergeProfile({}, { name: "   " })).toThrow(/name is required/);
    });
    it("accepts a name from update", () => {
        const out = mergeProfile({}, { name: "Dheeraj" });
        expect(out.name).toBe("Dheeraj");
        expect(out.tone).toBe("friendly");
    });
    it("preserves existing name when update omits it (persona step flow)", () => {
        const out = mergeProfile({ name: "Dheeraj", tone: "professional" }, { persona: "developer" });
        expect(out.name).toBe("Dheeraj");
        expect(out.persona).toBe("developer");
    });
    it("normalizes invalid tone to friendly", () => {
        const out = mergeProfile({}, { name: "X", tone: "snarky" });
        expect(out.tone).toBe("friendly");
    });
    it("accepts each ALLOWED_TONE", () => {
        for (const tone of ALLOWED_TONES) {
            const out = mergeProfile({}, { name: "X", tone });
            expect(out.tone).toBe(tone);
        }
    });
});

describe("mergeProfile — W2 persona fields", () => {
    it("persists persona / personaConfidence / personaSelectedAt", () => {
        const out = mergeProfile({}, {
            name: "X",
            persona: "developer",
            personaConfidence: 1.0,
            personaSelectedAt: 1715800000000,
        });
        expect(out.persona).toBe("developer");
        expect(out.personaConfidence).toBe(1.0);
        expect(out.personaSelectedAt).toBe(1715800000000);
    });
    it("clamps personaConfidence into [0, 1]", () => {
        const high = mergeProfile({}, { name: "X", persona: "developer", personaConfidence: 9.0 });
        expect(high.personaConfidence).toBe(1.0);
        const low = mergeProfile({}, { name: "X", persona: "developer", personaConfidence: -3 });
        expect(low.personaConfidence).toBe(0);
    });
    it("defaults personaConfidence to 1.0 when omitted", () => {
        const out = mergeProfile({}, { name: "X", persona: "founder" });
        expect(out.personaConfidence).toBe(1.0);
    });
    it("defaults personaSelectedAt to now when omitted", () => {
        const before = Date.now();
        const out = mergeProfile({}, { name: "X", persona: "creator" });
        const after = Date.now();
        expect(out.personaSelectedAt).toBeGreaterThanOrEqual(before);
        expect(out.personaSelectedAt).toBeLessThanOrEqual(after);
    });
    it("rejects unknown persona values (does NOT set persona)", () => {
        const out = mergeProfile({}, { name: "X", persona: "manager" });
        expect(out.persona).toBeUndefined();
        expect(out.personaConfidence).toBeUndefined();
    });
    it("accepts each ALLOWED_PERSONA", () => {
        for (const persona of ALLOWED_PERSONAS) {
            const out = mergeProfile({}, { name: "X", persona });
            expect(out.persona).toBe(persona);
        }
    });
    it("preserves existing persona when update omits it", () => {
        const out = mergeProfile(
            { name: "X", persona: "developer", personaConfidence: 1.0, personaSelectedAt: 999 },
            { name: "X", tone: "playful" },
        );
        expect(out.persona).toBe("developer");
        expect(out.personaConfidence).toBe(1.0);
        expect(out.personaSelectedAt).toBe(999);
        expect(out.tone).toBe("playful");
    });
});
