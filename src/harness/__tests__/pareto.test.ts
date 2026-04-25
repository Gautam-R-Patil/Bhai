// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import {
    extractObjectives,
    computeParetoFrontier,
    selectFromFrontier,
    isFrontierImproved,
    formatFrontierSummary,
} from "../pareto.js";
import type { CandidateManifest, HarnessScore, ParetoPoint } from "../types.js";

function mkScore(partial: Partial<HarnessScore> & { candidateId: string; composite: number }): HarnessScore {
    return {
        candidateId: partial.candidateId,
        composite: partial.composite,
        memoryRecallScore: partial.memoryRecallScore ?? 0.5,
        toolSelectionScore: partial.toolSelectionScore ?? 0.5,
        taskCompletionScore: partial.taskCompletionScore ?? 50,
        researchQualityScore: 0,
        tokenEfficiency: partial.tokenEfficiency ?? 0.5,
        tokensUsed: 1000,
        timestamp: new Date().toISOString(),
    };
}

function mkCandidate(id: string, score: HarnessScore | null): CandidateManifest {
    return {
        candidateId: id,
        parentCandidateId: null,
        objective: score?.composite ?? null,
        valid: score !== null,
        outcome: "keep",
        outcomeSummary: "",
        harnessConfig: { candidateId: id, dimensions: {}, createdAt: new Date().toISOString() },
        scores: score,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe("pareto", () => {
    it("extractObjectives returns null for candidates without scores", () => {
        expect(extractObjectives(mkCandidate("c0", null))).toBeNull();
    });

    it("extractObjectives maps HarnessScore to ObjectiveVector", () => {
        const c = mkCandidate("c1", mkScore({
            candidateId: "c1",
            composite: 80,
            taskCompletionScore: 85,
            tokenEfficiency: 0.7,
            memoryRecallScore: 0.9,
            toolSelectionScore: 0.6,
        }));
        expect(extractObjectives(c)).toEqual({
            task: 85,
            tokenEff: 0.7,
            memPrec: 0.9,
            toolAcc: 0.6,
        });
    });

    it("computeParetoFrontier ranks non-dominated candidates at rank 1", () => {
        const cs = [
            mkCandidate("c1", mkScore({ candidateId: "c1", composite: 70, taskCompletionScore: 90, tokenEfficiency: 0.3, memoryRecallScore: 0.5, toolSelectionScore: 0.5 })),
            mkCandidate("c2", mkScore({ candidateId: "c2", composite: 70, taskCompletionScore: 60, tokenEfficiency: 0.9, memoryRecallScore: 0.5, toolSelectionScore: 0.5 })),
            mkCandidate("c3", mkScore({ candidateId: "c3", composite: 40, taskCompletionScore: 50, tokenEfficiency: 0.2, memoryRecallScore: 0.2, toolSelectionScore: 0.2 })),
        ];
        const frontier = computeParetoFrontier(cs);
        expect(frontier).toHaveLength(3);
        const byId = Object.fromEntries(frontier.map(p => [p.candidateId, p]));
        expect(byId["c1"].rank).toBe(1);
        expect(byId["c2"].rank).toBe(1);
        expect(byId["c3"].rank).toBeGreaterThan(1);
    });

    it("computeParetoFrontier: strictly dominated point goes to rank 2", () => {
        const cs = [
            mkCandidate("winner", mkScore({ candidateId: "winner", composite: 90, taskCompletionScore: 90, tokenEfficiency: 0.9, memoryRecallScore: 0.9, toolSelectionScore: 0.9 })),
            mkCandidate("loser",  mkScore({ candidateId: "loser",  composite: 40, taskCompletionScore: 50, tokenEfficiency: 0.5, memoryRecallScore: 0.5, toolSelectionScore: 0.5 })),
        ];
        const frontier = computeParetoFrontier(cs);
        const byId = Object.fromEntries(frontier.map(p => [p.candidateId, p]));
        expect(byId["winner"].rank).toBe(1);
        expect(byId["loser"].rank).toBe(2);
        expect(byId["loser"].dominatedBy).toContain("winner");
    });

    it("computeParetoFrontier ignores candidates without scores", () => {
        const cs = [
            mkCandidate("c1", mkScore({ candidateId: "c1", composite: 70 })),
            mkCandidate("c2", null),
        ];
        const frontier = computeParetoFrontier(cs);
        expect(frontier).toHaveLength(1);
        expect(frontier[0].candidateId).toBe("c1");
    });

    it("selectFromFrontier picks the boundary (infinite crowding) from rank 1", () => {
        const frontier: ParetoPoint[] = [
            { candidateId: "a", objectives: { task: 90, tokenEff: 0.9, memPrec: 0.5, toolAcc: 0.5 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: Infinity },
            { candidateId: "b", objectives: { task: 70, tokenEff: 0.7, memPrec: 0.5, toolAcc: 0.5 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: 2.0 },
            { candidateId: "c", objectives: { task: 50, tokenEff: 0.5, memPrec: 0.9, toolAcc: 0.9 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: Infinity },
            { candidateId: "d", objectives: { task: 30, tokenEff: 0.3, memPrec: 0.3, toolAcc: 0.3 }, dominatedBy: ["a"], dominates: [], rank: 2, crowdingDistance: 0 },
        ];
        const pick = selectFromFrontier(frontier);
        expect(["a", "c"]).toContain(pick);
    });

    it("selectFromFrontier honors preferenceWeights when all crowding distances are finite", () => {
        const frontier: ParetoPoint[] = [
            { candidateId: "taskHeavy", objectives: { task: 90, tokenEff: 0.1, memPrec: 0.1, toolAcc: 0.1 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: 1.0 },
            { candidateId: "memHeavy",  objectives: { task: 10, tokenEff: 0.1, memPrec: 0.9, toolAcc: 0.1 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: 1.0 },
        ];
        const pick = selectFromFrontier(frontier, { task: 0, tokenEff: 0, memPrec: 1, toolAcc: 0 });
        expect(pick).toBe("memHeavy");
    });

    it("isFrontierImproved true when hypervolume grows", () => {
        const older: ParetoPoint[] = [
            { candidateId: "a", objectives: { task: 60, tokenEff: 0.5, memPrec: 0.5, toolAcc: 0.5 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: Infinity },
        ];
        const newer: ParetoPoint[] = [
            { candidateId: "a", objectives: { task: 60, tokenEff: 0.5, memPrec: 0.5, toolAcc: 0.5 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: Infinity },
            { candidateId: "b", objectives: { task: 80, tokenEff: 0.7, memPrec: 0.6, toolAcc: 0.6 }, dominatedBy: [], dominates: ["a"], rank: 1, crowdingDistance: Infinity },
        ];
        expect(isFrontierImproved(older, newer)).toBe(true);
    });

    it("isFrontierImproved false when new frontier is a subset of old hypervolume", () => {
        const older: ParetoPoint[] = [
            { candidateId: "a", objectives: { task: 80, tokenEff: 0.8, memPrec: 0.8, toolAcc: 0.8 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: Infinity },
        ];
        const newer: ParetoPoint[] = [
            { candidateId: "b", objectives: { task: 50, tokenEff: 0.5, memPrec: 0.5, toolAcc: 0.5 }, dominatedBy: ["a"], dominates: [], rank: 1, crowdingDistance: Infinity },
        ];
        expect(isFrontierImproved(older, newer)).toBe(false);
    });

    it("formatFrontierSummary emits human-readable markdown", () => {
        const frontier: ParetoPoint[] = [
            { candidateId: "c1", objectives: { task: 70, tokenEff: 0.6, memPrec: 0.7, toolAcc: 0.5 }, dominatedBy: [], dominates: [], rank: 1, crowdingDistance: Infinity },
        ];
        const md = formatFrontierSummary(frontier);
        expect(md).toContain("c1");
        expect(md).toContain("rank=1");
        expect(md).toMatch(/task/i);
    });
});
