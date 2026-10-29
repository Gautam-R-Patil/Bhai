// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { opusWarranted } from "./model-router.js";

describe("opusWarranted", () => {
    it("keeps Opus for explicit asks, a complex hint, or repeated failures", () => {
        expect(opusWarranted("think hard about this proof")).toBe(true);
        expect(opusWarranted("use opus for this")).toBe(true);
        expect(opusWarranted("refactor the parser", 0, "complex")).toBe(true);
        expect(opusWarranted("click the button", 3)).toBe(true);
    });
    it("drops to Sonnet otherwise", () => {
        expect(opusWarranted("design a landing page in Figma")).toBe(false);
        expect(opusWarranted("what's the weather", 2)).toBe(false);
        expect(opusWarranted(undefined)).toBe(false);
    });
});
