// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";

const routerMod = await import("../wizard/router.js");
const router = routerMod.default || routerMod;
const { getSteps, needsAwakening } = router;

describe("needsAwakening", () => {
    it("returns true for first install", () => {
        expect(needsAwakening({})).toBe(true);
    });
    it("returns false for reconfigure", () => {
        expect(needsAwakening({ isReconfigure: true })).toBe(false);
    });
    it("returns false for signed-in returning user", () => {
        expect(needsAwakening({ account: { signedIn: true } })).toBe(false);
    });
});

describe("getSteps prepends awakening", () => {
    it("awakening is first on a fresh-install state", () => {
        const { steps } = getSteps({});
        expect(steps[0]).toBe("awakening");
    });
    it("awakening is absent on reconfigure", () => {
        const { steps } = getSteps({ isReconfigure: true });
        expect(steps.includes("awakening")).toBe(false);
    });
});
