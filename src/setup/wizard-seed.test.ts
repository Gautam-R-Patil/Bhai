// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Tests buildIdentityUpdate — name + tone + W2 persona validation.
import { describe, it, expect } from "vitest";
import { buildIdentityUpdate } from "./wizard-seed.js";

describe("buildIdentityUpdate — name + tone (legacy)", () => {
    it("returns name from profile", () => {
        const out = buildIdentityUpdate({ name: "Dheeraj" });
        expect(out.name).toEqual({ value: "Dheeraj", verified: true });
    });
    it("trims whitespace from name", () => {
        const out = buildIdentityUpdate({ name: "  Dheeraj  " });
        expect(out.name).toEqual({ value: "Dheeraj", verified: true });
    });
    it("returns tone as preferences.communication_style", () => {
        const out = buildIdentityUpdate({ name: "X", tone: "professional" });
        expect(out.preferences?.communication_style).toBe("professional");
    });
    it("preserves legacy age + gender in extra", () => {
        const out = buildIdentityUpdate({ name: "X", age: 30, gender: "non-binary" });
        expect(out.extra?.age).toBe(30);
        expect(out.extra?.gender).toBe("non-binary");
    });
    it("returns empty object for an empty profile", () => {
        const out = buildIdentityUpdate({});
        expect(out.name).toBeUndefined();
        expect(out.preferences).toBeUndefined();
        expect(out.extra).toBeUndefined();
    });
});

describe("buildIdentityUpdate — W2 persona", () => {
    it("persists valid persona to extra.persona", () => {
        const out = buildIdentityUpdate({
            name: "X",
            persona: "developer",
            personaConfidence: 1.0,
            personaSelectedAt: 1715800000000,
        });
        expect(out.extra?.persona).toBe("developer");
        expect(out.extra?.personaConfidence).toBe(1.0);
        expect(out.extra?.personaSelectedAt).toBe(1715800000000);
    });
    it("accepts every canonical persona", () => {
        for (const p of ["developer", "founder", "creator", "researcher", "explorer"] as const) {
            const out = buildIdentityUpdate({ name: "X", persona: p });
            expect(out.extra?.persona, `persona=${p}`).toBe(p);
        }
    });
    it("drops unknown persona values entirely", () => {
        const out = buildIdentityUpdate({ name: "X", persona: "manager" });
        expect(out.extra?.persona).toBeUndefined();
        expect(out.extra?.personaConfidence).toBeUndefined();
    });
    it("defaults personaConfidence to 1.0 when omitted", () => {
        const out = buildIdentityUpdate({ name: "X", persona: "developer" });
        expect(out.extra?.personaConfidence).toBe(1.0);
    });
    it("clamps personaConfidence below 0 or above 1 to default", () => {
        const high = buildIdentityUpdate({ name: "X", persona: "developer", personaConfidence: 9.0 });
        expect(high.extra?.personaConfidence).toBe(1.0);
        const low = buildIdentityUpdate({ name: "X", persona: "developer", personaConfidence: -0.5 });
        expect(low.extra?.personaConfidence).toBe(1.0);
    });
    it("omits personaSelectedAt if not a positive number", () => {
        const out = buildIdentityUpdate({ name: "X", persona: "developer", personaSelectedAt: -1 });
        expect(out.extra?.personaSelectedAt).toBeUndefined();
    });
    it("a profile with no persona behaves exactly as before W2", () => {
        const out = buildIdentityUpdate({ name: "X", tone: "playful", age: 25 });
        expect(out.name).toEqual({ value: "X", verified: true });
        expect(out.preferences?.communication_style).toBe("playful");
        expect(out.extra?.age).toBe(25);
        expect(out.extra?.persona).toBeUndefined();
    });
    it("persona coexists with legacy extra fields", () => {
        const out = buildIdentityUpdate({
            name: "X",
            persona: "creator",
            personaConfidence: 0.8,
            age: 28,
            customLegacyKey: "preserved",
        });
        expect(out.extra?.persona).toBe("creator");
        expect(out.extra?.personaConfidence).toBe(0.8);
        expect(out.extra?.age).toBe(28);
        expect(out.extra?.customLegacyKey).toBe("preserved");
    });
});
