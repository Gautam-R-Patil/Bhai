// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import {
    asPersona,
    getPersonaIdentityLine,
    getPersonaToolWeights,
    applyPersonaWeight,
    PERSONA_VALUES,
} from "./persona-bias.js";

describe("asPersona", () => {
    it("returns the value when it's a valid persona", () => {
        expect(asPersona("developer")).toBe("developer");
        expect(asPersona("explorer")).toBe("explorer");
    });
    it("returns null for unknown strings", () => {
        expect(asPersona("manager")).toBeNull();
        expect(asPersona("")).toBeNull();
    });
    it("returns null for non-strings", () => {
        expect(asPersona(42)).toBeNull();
        expect(asPersona(null)).toBeNull();
        expect(asPersona(undefined)).toBeNull();
        expect(asPersona({ persona: "developer" })).toBeNull();
    });
});

describe("getPersonaIdentityLine", () => {
    it("returns a non-empty string for every persona except explorer", () => {
        for (const p of PERSONA_VALUES) {
            const line = getPersonaIdentityLine(p);
            if (p === "explorer") {
                expect(line).toBeNull();
            } else {
                expect(line).toBeTruthy();
                expect(typeof line).toBe("string");
                expect((line as string).length).toBeGreaterThan(20);
            }
        }
    });
    it("returns null for null/undefined", () => {
        expect(getPersonaIdentityLine(null)).toBeNull();
        expect(getPersonaIdentityLine(undefined)).toBeNull();
    });
    it("explorer is intentionally a no-op", () => {
        expect(getPersonaIdentityLine("explorer")).toBeNull();
    });
});

describe("getPersonaToolWeights", () => {
    it("every persona returns a weight map", () => {
        for (const p of PERSONA_VALUES) {
            const w = getPersonaToolWeights(p);
            expect(typeof w).toBe("object");
            expect(w).not.toBeNull();
        }
    });

    it("every weight is in [0.7, 1.4] and none is exactly 1.0", () => {
        for (const p of PERSONA_VALUES) {
            const w = getPersonaToolWeights(p);
            for (const [cat, weight] of Object.entries(w)) {
                expect(weight, `persona=${p} cat=${cat}`).toBeGreaterThanOrEqual(0.7);
                expect(weight, `persona=${p} cat=${cat}`).toBeLessThanOrEqual(1.4);
                // 1.0 is the implicit default — listing it explicitly is dead weight.
                expect(weight, `persona=${p} cat=${cat}`).not.toBe(1.0);
            }
        }
    });

    it("explorer returns an empty map", () => {
        expect(Object.keys(getPersonaToolWeights("explorer"))).toHaveLength(0);
    });

    it("null / undefined return empty", () => {
        expect(Object.keys(getPersonaToolWeights(null))).toHaveLength(0);
        expect(Object.keys(getPersonaToolWeights(undefined))).toHaveLength(0);
    });

    it("developer biases toward coding categories", () => {
        const w = getPersonaToolWeights("developer");
        expect(w.coding).toBeGreaterThanOrEqual(1.2);
        expect(w.codebase).toBeGreaterThanOrEqual(1.2);
        expect(w.shell).toBeGreaterThanOrEqual(1.2);
    });

    it("researcher biases toward research + sources", () => {
        const w = getPersonaToolWeights("researcher");
        expect(w.research).toBeGreaterThanOrEqual(1.3);
        expect(w.web_search).toBeGreaterThanOrEqual(1.2);
    });

    it("uses real category names from src/tool-router.ts", () => {
        // Smoke check — none of the spec's invented names appear in any persona's map.
        const all = [...PERSONA_VALUES].flatMap((p) => Object.keys(getPersonaToolWeights(p)));
        const forbidden = ["code", "git", "email", "calendar", "image", "citation", "meeting"];
        for (const f of forbidden) {
            expect(all, `forbidden invented name "${f}" found in weight maps`).not.toContain(f);
        }
    });
});

describe("applyPersonaWeight", () => {
    it("multiplies score by the weight when category matches", () => {
        // developer.coding = 1.35 → 0.5 * 1.35 = 0.675
        expect(applyPersonaWeight("developer", "coding", 0.5)).toBeCloseTo(0.675);
    });
    it("returns score unchanged when category isn't biased", () => {
        expect(applyPersonaWeight("developer", "marketing", 0.5)).toBe(0.5);
    });
    it("returns score unchanged for null persona", () => {
        expect(applyPersonaWeight(null, "coding", 0.5)).toBe(0.5);
    });
    it("returns score unchanged for explorer persona", () => {
        expect(applyPersonaWeight("explorer", "coding", 0.5)).toBe(0.5);
    });
});
