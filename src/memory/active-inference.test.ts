// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The native path uses napi camelCase fields; snake_case made every call throw
// (input) or read undefined (output). These assert a well-formed result on
// whichever path runs — native here, JS fallback on CI without the binary.
import { describe, expect, it } from "vitest";
import { makeInferenceDecision, updateBeliefs } from "./active-inference.js";

const beliefs = { hypotheses: ["a", "b", "c"], probabilities: [0.5, 0.3, 0.2], evidenceCounts: [2, 1, 0] };

describe("active inference (native or JS fallback)", () => {
    it("makeInferenceDecision returns finite, well-typed fields — not undefined/NaN", () => {
        const d = makeInferenceDecision(beliefs, [[0.9, 0.1, 0.0], [0.2, 0.2, 0.6]]);
        expect(typeof d.shouldExplore).toBe("boolean");
        expect(Number.isFinite(d.freeEnergy)).toBe(true);
        expect(Number.isFinite(d.entropy)).toBe(true);
        expect(Number.isFinite(d.explorationScore)).toBe(true);
        expect(Number.isInteger(d.bestQueryIndex)).toBe(true);
    });

    it("a single hypothesis does not produce NaN (log(1)=0 guard)", () => {
        const d = makeInferenceDecision({ hypotheses: ["only"], probabilities: [1], evidenceCounts: [3] }, []);
        expect(Number.isFinite(d.explorationScore)).toBe(true);
    });

    it("updateBeliefs returns aligned arrays and bumps the right count", () => {
        const u = updateBeliefs(beliefs, 0, 0.5);
        expect(u.hypotheses).toHaveLength(3);
        expect(u.probabilities).toHaveLength(3);
        expect(u.evidenceCounts).toHaveLength(3);
        expect(u.evidenceCounts.every((n) => Number.isFinite(n))).toBe(true);
        expect(u.evidenceCounts[0]).toBe(3); // was 2, +1 for hypothesis 0
    });
});

import { _setNativeForTests } from "./active-inference.js";

describe("native absent (fail-open loader returns {})", () => {
    it("falls back to JS when the native module has no functions — no crash", () => {
        _setNativeForTests({}); // simulate a platform with no binary (loader returns {})
        try {
            const d = makeInferenceDecision(beliefs, [[0.9, 0.1, 0.0]]);
            expect(Number.isFinite(d.freeEnergy)).toBe(true);
            expect(typeof d.shouldExplore).toBe("boolean");
            expect(updateBeliefs(beliefs, 0, 0.5).evidenceCounts).toHaveLength(3);
        } finally {
            _setNativeForTests(undefined); // restore real loader
        }
    });
});
