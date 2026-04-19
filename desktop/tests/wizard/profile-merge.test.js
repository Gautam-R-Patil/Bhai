// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { mergeProfile, ALLOWED_TONES } from "../../wizard/profile-merge.js";

describe("mergeProfile", () => {
    it("writes name + tone on a fresh profile", () => {
        const out = mergeProfile({}, { name: "Dheeraj", tone: "friendly" });
        expect(out).toMatchObject({ name: "Dheeraj", tone: "friendly" });
    });
    it("preserves legacy age/gender/extras fields", () => {
        const existing = { name: "Old", age: 40, gender: "x", extra: 7 };
        const out = mergeProfile(existing, { name: "New", tone: "professional" });
        expect(out).toMatchObject({ name: "New", tone: "professional", age: 40, gender: "x", extra: 7 });
    });
    it("trims whitespace around the name", () => {
        expect(mergeProfile({}, { name: "  Dheeraj  " }).name).toBe("Dheeraj");
    });
    it("throws on empty name", () => {
        expect(() => mergeProfile({}, { name: "   " })).toThrow(/name is required/i);
        expect(() => mergeProfile({}, {})).toThrow(/name is required/i);
    });
    it("defaults tone to 'friendly' when missing", () => {
        expect(mergeProfile({}, { name: "A" }).tone).toBe("friendly");
    });
    it("normalizes invalid tones to 'friendly'", () => {
        expect(mergeProfile({}, { name: "A", tone: "angry" }).tone).toBe("friendly");
    });
    it("accepts all three valid tones verbatim", () => {
        for (const t of ALLOWED_TONES) {
            expect(mergeProfile({}, { name: "A", tone: t }).tone).toBe(t);
        }
    });
    it("does not mutate the existing profile", () => {
        const existing = { name: "Old", age: 40 };
        mergeProfile(existing, { name: "New", tone: "playful" });
        expect(existing).toEqual({ name: "Old", age: 40 });
    });
});
