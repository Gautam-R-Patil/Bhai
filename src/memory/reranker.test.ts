// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { rerankHeuristic } from "./reranker.js";

describe("rerankHeuristic — empty queryWords guard", () => {
    const candidates = [
        { id: 1, content: "hello world", originalScore: 0.9 },
        { id: 2, content: "foo bar", originalScore: 0.5 },
    ];

    it("does not produce NaN scores for a short/stopword-only query", () => {
        // All tokens ≤2 chars → queryWords.size === 0 → used to be 0/0 = NaN.
        const results = rerankHeuristic("ok", candidates, 5);
        for (const r of results) {
            expect(Number.isFinite(r.score)).toBe(true);
        }
    });

    it("falls back to original embedding score when query has no usable tokens", () => {
        const results = rerankHeuristic("", candidates, 5);
        // overlapScore is 0, so combinedScore === originalScore * 0.6
        const top = results[0];
        expect(top.id).toBe(1); // 0.9*0.6 beats 0.5*0.6 — ranking preserved
        expect(top.score).toBeCloseTo(0.54, 5);
    });

    it("still ranks by keyword overlap for a normal query", () => {
        const results = rerankHeuristic("foo bar", candidates, 5);
        expect(results[0].id).toBe(2); // keyword overlap lifts the "foo bar" row
        expect(Number.isFinite(results[0].score)).toBe(true);
    });
});
