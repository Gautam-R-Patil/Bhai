// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { computeSelfStateDeltas } from "./self-state.js";

describe("computeSelfStateDeltas — self-state dynamics", () => {
    it("a frustrated or stressed session LOWERS user-model confidence (the model was off)", () => {
        expect(computeSelfStateDeltas(8, "frustrated", "focused").confDelta).toBeLessThan(0);
        expect(computeSelfStateDeltas(30, "stressed", "focused").confDelta).toBeLessThan(0);
    });
    it("a good session still builds confidence, capped per session", () => {
        expect(computeSelfStateDeltas(2, "driven", "supportive").confDelta).toBeCloseTo(0.01);
        expect(computeSelfStateDeltas(100, "curious", "supportive").confDelta).toBe(0.02); // capped
    });
    it("energy decays on long sessions, recovers on short ones", () => {
        expect(computeSelfStateDeltas(25, "neutral", "focused").energyDelta).toBe(-0.05);
        expect(computeSelfStateDeltas(15, "neutral", "focused").energyDelta).toBe(-0.02);
        expect(computeSelfStateDeltas(3, "neutral", "focused").energyDelta).toBe(0.03);
    });
    it("maps tone to engagement mode, else keeps the current one", () => {
        expect(computeSelfStateDeltas(5, "excited", "supportive").mode).toBe("focused");
        expect(computeSelfStateDeltas(5, "curious", "supportive").mode).toBe("exploratory");
        expect(computeSelfStateDeltas(5, "frustrated", "focused").mode).toBe("supportive");
        expect(computeSelfStateDeltas(5, "neutral", "exploratory").mode).toBe("exploratory"); // unchanged
    });
});
