// @vitest-environment jsdom
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";

const awakening = await import("../wizard/steps/awakening.js");
// The file is a renderer IIFE — module.exports is populated when run under Node.
// In vitest with jsdom we get the WizardSteps registration AND module.exports.
const mod = awakening._internals ? awakening : (awakening.default || awakening);
const { resolveName, buildGreeting, timeOfDay } = mod._internals || mod;

describe("awakening.resolveName", () => {
    it("returns profile.name when present", () => {
        expect(resolveName({ profile: { name: "Dheeraj" }, osUserName: "dheeraj" })).toBe("Dheeraj");
    });
    it("falls back to OS user name, capitalized", () => {
        expect(resolveName({ profile: {}, osUserName: "dheeraj" })).toBe("Dheeraj");
    });
    it("returns null when both are absent", () => {
        expect(resolveName({})).toBeNull();
    });
});

describe("awakening.buildGreeting", () => {
    it("appends comma + name + period when name resolved", () => {
        const out = buildGreeting({ profile: { name: "Dheeraj" } });
        expect(out).toMatch(/^Good (morning|afternoon|evening), Dheeraj\.$|^Working late, Dheeraj\.$/);
    });
    it("uses bare TOD greeting with period when no name", () => {
        const out = buildGreeting({});
        expect(out).toMatch(/^Good (morning|afternoon|evening)\.$|^Working late\.$/);
    });
});

describe("awakening.timeOfDay", () => {
    it("maps 6am → morning", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 6, 0))).toBe("morning");
    });
    it("maps 2pm → afternoon", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 14, 0))).toBe("afternoon");
    });
    it("maps 7pm → evening", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 19, 0))).toBe("evening");
    });
    it("maps 1am → late-night", () => {
        expect(timeOfDay(new Date(2026, 0, 1, 1, 0))).toBe("late-night");
    });
});
