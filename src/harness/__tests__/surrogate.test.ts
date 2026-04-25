// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { buildSurrogate, shouldEvaluate, SurrogateModel } from "../surrogate.js";
import type { CandidateManifest, HarnessScore, HarnessConfig } from "../types.js";

function mkHistoryCandidate(id: string, composite: number, dimValue: number): CandidateManifest {
    const scores: HarnessScore = {
        candidateId: id,
        composite,
        memoryRecallScore: 0.5,
        toolSelectionScore: 0.5,
        taskCompletionScore: composite,
        researchQualityScore: 0,
        tokenEfficiency: 0.5,
        tokensUsed: 1000,
        timestamp: new Date().toISOString(),
    };
    return {
        candidateId: id,
        parentCandidateId: null,
        objective: composite,
        valid: true,
        outcome: "keep",
        outcomeSummary: "",
        harnessConfig: {
            candidateId: id,
            dimensions: { "memory.recall.k": dimValue, "subagent.researcher.systemPrompt": "irrelevant string" },
            createdAt: new Date().toISOString(),
        },
        scores,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe("surrogate", () => {
    it("buildSurrogate returns null for < 5 observations", () => {
        const hist = [mkHistoryCandidate("c1", 50, 10), mkHistoryCandidate("c2", 60, 12)];
        expect(buildSurrogate(hist)).toBeNull();
    });

    it("buildSurrogate requires at least 5 scored candidates", () => {
        const hist = [
            mkHistoryCandidate("c1", 50, 10),
            mkHistoryCandidate("c2", 60, 12),
            mkHistoryCandidate("c3", 70, 14),
            mkHistoryCandidate("c4", 65, 11),
        ];
        expect(buildSurrogate(hist)).toBeNull();
        hist.push(mkHistoryCandidate("c5", 68, 13));
        expect(buildSurrogate(hist)).not.toBeNull();
    });

    it("SurrogateModel.predict interpolates near observed points", () => {
        const hist = Array.from({ length: 6 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 40 + i * 10, 10 + i * 2));
        const model = buildSurrogate(hist);
        expect(model).not.toBeNull();
        const pred = model!.predict({ "memory.recall.k": 10 });
        expect(pred.mean).toBeGreaterThan(30);
        expect(pred.mean).toBeLessThan(60);
        expect(pred.uncertainty).toBeGreaterThanOrEqual(0);
    });

    it("shouldEvaluate returns true when surrogate is null", () => {
        const cfg: HarnessConfig = { candidateId: "x", dimensions: { "memory.recall.k": 10 }, createdAt: new Date().toISOString() };
        expect(shouldEvaluate(null, cfg, 75)).toBe(true);
    });

    it("shouldEvaluate returns true for borderline predictions", () => {
        const hist = Array.from({ length: 8 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 40 + i * 5, 10 + i));
        const model = buildSurrogate(hist);
        const cfg: HarnessConfig = {
            candidateId: "x",
            dimensions: { "memory.recall.k": 13 },
            createdAt: new Date().toISOString(),
        };
        expect(shouldEvaluate(model, cfg, 60)).toBe(true);
    });

    it("shouldEvaluate returns a boolean for extreme extrapolation", () => {
        const hist = Array.from({ length: 6 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 70 + i, 10 + i));
        const model = buildSurrogate(hist);
        const cfg: HarnessConfig = {
            candidateId: "far",
            dimensions: { "memory.recall.k": -500 },
            createdAt: new Date().toISOString(),
        };
        expect(typeof shouldEvaluate(model, cfg, 100)).toBe("boolean");
    });

    it("acquisitionEI produces a non-negative scalar", () => {
        const hist = Array.from({ length: 6 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 40 + i * 10, 10 + i * 2));
        const model = buildSurrogate(hist) as SurrogateModel;
        const ei = model.acquisitionEI({ "memory.recall.k": 15 }, 70);
        expect(ei).toBeGreaterThanOrEqual(0);
    });

    it("non-numeric dimensions are ignored", () => {
        const hist = Array.from({ length: 5 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 50 + i, 10 + i));
        const model = buildSurrogate(hist);
        expect(model).not.toBeNull();
        const pred = model!.predict({ "memory.recall.k": 12 });
        expect(Number.isFinite(pred.mean)).toBe(true);
    });
});
