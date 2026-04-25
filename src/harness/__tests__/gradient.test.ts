// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    generateDimensionGradients,
    formatGradientHints,
    GRADIENT_THRESHOLD,
} from "../gradient.js";
import { initRegistry } from "../registry.js";
import type { CandidateManifest, HarnessScore, TraceRecord, DimensionGradient } from "../types.js";
import type { LLMClient } from "../../llm.js";

function mkCandidate(id: string, composite: number): CandidateManifest {
    const scores: HarnessScore = {
        candidateId: id,
        composite,
        memoryRecallScore: 0.4,
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
        harnessConfig: { candidateId: id, dimensions: { "memory.recall.k": 10 }, createdAt: new Date().toISOString() },
        scores,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function mkTrace(taskSucceeded: boolean, evalScore: number | null): TraceRecord {
    return {
        traceId: `t_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: "s1",
        iterationNumber: 1,
        queryText: "what's on my calendar?",
        toolsSelected: ["calendar.read"],
        contextSourcesIncluded: ["memory", "calendar"],
        memoryHitCount: 3,
        memoryTopScore: 0.7,
        evaluationScore: evalScore,
        taskSucceeded,
        durationMs: 500,
        timestamp: new Date().toISOString(),
    };
}

function mkLLM(responseContent: string): LLMClient {
    return {
        chat: vi.fn().mockResolvedValue({
            choices: [{ message: { content: responseContent, role: "assistant" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
    } as unknown as LLMClient;
}

describe("gradient", () => {
    beforeEach(() => {
        initRegistry();
    });

    it("GRADIENT_THRESHOLD is exported as 2", () => {
        expect(GRADIENT_THRESHOLD).toBe(2);
    });

    it("returns [] when candidate is already near or above bestScore", async () => {
        const llm = mkLLM("[]");
        const candidate = mkCandidate("c1", 80);
        const gradients = await generateDimensionGradients(
            llm,
            candidate,
            [],
            { bestScore: 80 },
        );
        expect(gradients).toEqual([]);
        expect(llm.chat as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it("returns [] when candidate has no scores", async () => {
        const llm = mkLLM("[]");
        const candidate = mkCandidate("c1", 50);
        candidate.scores = null;
        const gradients = await generateDimensionGradients(llm, candidate, [], { bestScore: 80 });
        expect(gradients).toEqual([]);
    });

    it("parses a well-formed LLM JSON response into DimensionGradient[]", async () => {
        const payload = JSON.stringify([
            {
                dimensionId: "memory.recall.k",
                currentValue: 10,
                critique: "Too low — missed 3/5 relevant memories in failing traces.",
                proposedDirection: "increase",
                severity: "critical",
            },
            {
                dimensionId: "evaluator.acceptThreshold",
                currentValue: 70,
                critique: "Too strict; rejecting valid outputs.",
                proposedDirection: "decrease",
                severity: "moderate",
            },
        ]);
        const llm = mkLLM(payload);
        const candidate = mkCandidate("c1", 50);
        const traces = [mkTrace(false, 45), mkTrace(false, 50), mkTrace(true, 70)];
        const gradients = await generateDimensionGradients(llm, candidate, traces, { bestScore: 80 });
        expect(gradients).toHaveLength(2);
        expect(gradients[0].dimensionId).toBe("memory.recall.k");
        expect(gradients[0].severity).toBe("critical");
        expect(gradients[1].proposedDirection).toBe("decrease");
    });

    it("tolerates malformed LLM output (returns [])", async () => {
        const llm = mkLLM("this is not JSON at all.");
        const candidate = mkCandidate("c1", 50);
        const gradients = await generateDimensionGradients(llm, candidate, [], { bestScore: 80 });
        expect(gradients).toEqual([]);
    });

    it("clamps to max 5 gradients when LLM returns too many", async () => {
        const many = Array.from({ length: 10 }).map((_, i) => ({
            dimensionId: `memory.recall.k`,
            currentValue: i,
            critique: `critique ${i}`,
            proposedDirection: "increase" as const,
            severity: "minor" as const,
        }));
        const llm = mkLLM(JSON.stringify(many));
        const candidate = mkCandidate("c1", 50);
        const gradients = await generateDimensionGradients(llm, candidate, [], { bestScore: 80 });
        expect(gradients.length).toBeLessThanOrEqual(5);
    });

    it("formatGradientHints produces markdown with severity badges", () => {
        const grads: DimensionGradient[] = [
            { dimensionId: "memory.recall.k", currentValue: 10, critique: "too low", proposedDirection: "increase", severity: "critical" },
            { dimensionId: "evaluator.acceptThreshold", currentValue: 70, critique: "too strict", proposedDirection: "decrease", severity: "moderate" },
        ];
        const md = formatGradientHints(grads);
        expect(md).toContain("memory.recall.k");
        expect(md).toContain("critical");
        expect(md).toContain("increase");
        expect(md).toContain("evaluator.acceptThreshold");
        expect(md).toMatch(/^#/m);
    });

    it("formatGradientHints handles empty array", () => {
        expect(formatGradientHints([])).toMatch(/no gradients/i);
    });
});
