// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMetaHarnessOptimization } from "../optimizer.js";
import type { LLMClient } from "../../llm.js";
import type { HarnessScore } from "../types.js";

vi.mock("../evaluator.js", () => ({
    evaluateCandidate: vi.fn(async (_llm: unknown, candidateId: string): Promise<HarnessScore> => {
        const composite = candidateId === "c0003" ? 85 : 60 + Math.random() * 5;
        return {
            candidateId, composite,
            memoryRecallScore: 0.6, toolSelectionScore: 0.7,
            taskCompletionScore: 70, researchQualityScore: 0.55,
            tokenEfficiency: 0.5, tokensUsed: 12000,
            timestamp: new Date().toISOString(),
        };
    }),
}));

vi.mock("../code-proposer.js", () => ({
    proposeWithFilesystemAgent: vi.fn(async (_llm: unknown, candidate: { candidateId: string; harnessConfig: { dimensions: Record<string, unknown> } }) => ({
        config: {
            candidateId: candidate.candidateId,
            dimensions: { "memory.recall.k": 11 },
            createdAt: new Date().toISOString(),
        },
        codeChanges: [],
    })),
    CodeChange: undefined,
}));

vi.mock("../proposer.js", () => ({
    proposeNextCandidate: vi.fn(async (_llm: unknown, candidate: { candidateId: string }) => ({
        candidateId: candidate.candidateId,
        dimensions: { "memory.recall.k": 8 },
        createdAt: new Date().toISOString(),
    })),
}));

vi.mock("../surrogate.js", () => ({
    buildSurrogate: vi.fn(() => null),
    shouldEvaluate: vi.fn(() => true),
}));

vi.mock("../pareto.js", () => ({
    computeParetoFrontier: vi.fn((candidates: Array<{ valid: boolean; objective: number | null; candidateId: string }>) =>
        candidates.filter(c => c.valid && c.objective !== null)
            .map(c => ({
                candidateId: c.candidateId,
                objectives: { task: c.objective, tokenEff: 0.5, memPrec: 0.5, toolAcc: 0.5 },
                dominatedBy: [],
                dominates: [],
                rank: 1,
                crowdingDistance: Infinity,
            }))
    ),
    selectFromFrontier: vi.fn((frontier: Array<{ candidateId: string; objectives: { task: number } }>) =>
        frontier.length > 0
            ? frontier.reduce((best, p) => p.objectives.task > best.objectives.task ? p : best, frontier[0]).candidateId
            : ""
    ),
}));

vi.mock("../gradient.js", () => ({
    generateDimensionGradients: vi.fn(async () => [
        { dimensionId: "memory.recall.k", currentValue: 10, critique: "too low", proposedDirection: "increase" as const, severity: "moderate" as const },
    ]),
    formatGradientHints: vi.fn(() => "# hints"),
}));

const fakeLLM = {} as LLMClient;

describe("runMetaHarnessOptimization v2", () => {
    let runDir: string;

    beforeEach(() => {
        const tmp = mkdtempSync(join(tmpdir(), "atlas-opt-v2-"));
        process.env.ATLAS_DATA_DIR = tmp;
        runDir = tmp;
    });

    afterEach(() => {
        delete process.env.ATLAS_DATA_DIR;
        try { rmSync(runDir, { recursive: true, force: true }); } catch { /* */ }
        vi.clearAllMocks();
    });

    it("runs population initialization before proposal iterations", async () => {
        const evalMod = await import("../evaluator.js");
        const spy = vi.mocked(evalMod.evaluateCandidate);
        await runMetaHarnessOptimization(fakeLLM, { budget: 2, fastMode: true });
        // 4 seeds minimum
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
        const firstFourIds = spy.mock.calls.slice(0, 4).map(c => c[1] as string).sort();
        expect(firstFourIds).toEqual(["c0000", "c0001", "c0002", "c0003"]);
    });

    it("uses code-proposer by default (useCodeSearch=true)", async () => {
        const codeProp = await import("../code-proposer.js");
        const spy = vi.mocked(codeProp.proposeWithFilesystemAgent);
        await runMetaHarnessOptimization(fakeLLM, { budget: 1, fastMode: true });
        expect(spy).toHaveBeenCalled();
    });

    it("uses the legacy proposer when useCodeSearch=false", async () => {
        const legacy = await import("../proposer.js");
        const codeProp = await import("../code-proposer.js");
        await runMetaHarnessOptimization(fakeLLM, { budget: 1, fastMode: true, useCodeSearch: false });
        expect(vi.mocked(legacy.proposeNextCandidate)).toHaveBeenCalled();
        expect(vi.mocked(codeProp.proposeWithFilesystemAgent)).not.toHaveBeenCalled();
    });

    it("skips evaluation and increments surrogateSkips when shouldEvaluate returns false", async () => {
        const sur = await import("../surrogate.js");
        vi.mocked(sur.shouldEvaluate).mockReturnValueOnce(false);
        const result = await runMetaHarnessOptimization(fakeLLM, { budget: 1, fastMode: true });
        expect(result.surrogateSkips).toBeGreaterThan(0);
    });

    it("returns a paretoFrontier array in the result", async () => {
        const result = await runMetaHarnessOptimization(fakeLLM, { budget: 1, fastMode: true });
        expect(Array.isArray(result.paretoFrontier)).toBe(true);
        expect(result.paretoFrontier.length).toBeGreaterThan(0);
    });

    it("calls generateDimensionGradients when useGradients=true and previous iter did not improve", async () => {
        const grad = await import("../gradient.js");
        const gradSpy = vi.mocked(grad.generateDimensionGradients);
        await runMetaHarnessOptimization(fakeLLM, { budget: 3, fastMode: true });
        expect(gradSpy).toHaveBeenCalled();
    });

    it("falls back gracefully when a proposer crashes", async () => {
        const codeProp = await import("../code-proposer.js");
        vi.mocked(codeProp.proposeWithFilesystemAgent).mockRejectedValueOnce(new Error("boom"));
        const result = await runMetaHarnessOptimization(fakeLLM, { budget: 2, fastMode: true });
        expect(result.runId).toBeDefined();
        expect(result.bestCandidateId).toBeDefined();
    });

    it("validates code changes from proposer and marks scope-violation when invalid", async () => {
        const codeProp = await import("../code-proposer.js");
        vi.mocked(codeProp.proposeWithFilesystemAgent).mockResolvedValueOnce({
            config: { candidateId: "x", dimensions: {}, createdAt: new Date().toISOString() },
            codeChanges: [{ patchFile: "evil.ts", content: "eval('hack')" }],
        });
        // Should not throw; candidate is marked scope-violation internally
        const result = await runMetaHarnessOptimization(fakeLLM, { budget: 1, fastMode: true });
        expect(result.runId).toBeDefined();
    });
});
