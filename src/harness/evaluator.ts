// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Candidate Evaluator ─────────────────────────────────────
// Evaluates a harness configuration by applying it to the registry and running
// the benchmark suite. Returns a composite HarnessScore used by the optimizer
// to select the best candidate.
//
// Composite score weights:
//   35% task completion quality  (requires live LLM)
//   25% memory recall precision  (no network)
//   25% tool selection accuracy  (no network)
//   15% token efficiency         (derived from completion score / tokens)

import type { LLMClient } from "../llm.js";
import type { HarnessConfig, HarnessScore } from "./types.js";
import { applyConfig, resetToDefaults } from "./registry.js";
import { runMemoryRecallBenchmark } from "./benchmarks/memory-recall.js";
import { runToolSelectionBenchmark } from "./benchmarks/tool-selection.js";
import { runTaskCompletionBenchmark } from "./benchmarks/task-completion.js";

// Native Rust acceleration for score computation (napi-rs generates camelCase)
let nativeCompute: ((input: {
    taskCompletionScore: number;
    memoryRecallScore: number;
    toolSelectionScore: number;
    tokenEfficiency: number;
    tokensUsed: number;
}) => { composite: number; weightedTask: number; weightedMemory: number; weightedTools: number; weightedEfficiency: number }) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = await import("../../native/index.js").catch(() => null) as any;
    if (native?.computeHarnessComposite) nativeCompute = native.computeHarnessComposite;
} catch { /* fall back to JS */ }

export async function evaluateCandidate(
    llm: LLMClient,
    candidateId: string,
    config: HarnessConfig,
    opts: { fastMode?: boolean } = {},
): Promise<HarnessScore> {
    const start = Date.now();

    // Apply the candidate config to the registry
    applyConfig(config);

    try {
        // Run all benchmarks in parallel where possible
        const [memResult, toolResult] = await Promise.all([
            runMemoryRecallBenchmark().catch(e => {
                console.warn("[HARNESS-EVAL] Memory recall benchmark failed:", (e as Error).message);
                return { name: "memory-recall", score: 0, details: {}, durationMs: 0, error: (e as Error).message };
            }),
            runToolSelectionBenchmark().catch(e => {
                console.warn("[HARNESS-EVAL] Tool selection benchmark failed:", (e as Error).message);
                return { name: "tool-selection", score: 0, details: {}, durationMs: 0, error: (e as Error).message };
            }),
        ]);

        let taskScore = 0;
        let tokensUsed = 0;

        if (!opts.fastMode) {
            const taskResult = await runTaskCompletionBenchmark(llm).catch(e => {
                console.warn("[HARNESS-EVAL] Task completion benchmark failed:", (e as Error).message);
                return { name: "task-completion", score: 0, details: {}, durationMs: 0 };
            });
            taskScore = taskResult.score;
            tokensUsed = (taskResult.details as { tokensUsed?: number }).tokensUsed ?? 0;
        } else {
            // In fast mode, use memory + tool scores as proxy for task completion
            taskScore = (memResult.score + toolResult.score) / 2;
        }

        // Compute token efficiency: higher task score with fewer tokens = better
        const tokenEfficiency = tokensUsed > 0
            ? Math.min(1, (taskScore * 100) / (tokensUsed / 1000 + 1))
            : taskScore;

        // Use Rust native SIMD computation if available, else pure JS fallback
        let composite: number;
        if (nativeCompute) {
            const result = nativeCompute({
                taskCompletionScore: taskScore,
                memoryRecallScore: memResult.score,
                toolSelectionScore: toolResult.score,
                tokenEfficiency,
                tokensUsed,
            });
            composite = Math.round(result.composite);
        } else {
            composite = Math.round(
                taskScore * 35 +
                memResult.score * 25 +
                toolResult.score * 25 +
                tokenEfficiency * 15
            );
        }

        const score: HarnessScore = {
            candidateId,
            composite,
            memoryRecallScore: memResult.score,
            toolSelectionScore: toolResult.score,
            taskCompletionScore: taskScore * 100,
            researchQualityScore: 0,  // placeholder; research benchmark is slow
            tokenEfficiency,
            tokensUsed,
            timestamp: new Date().toISOString(),
        };

        console.log(`[HARNESS-EVAL] ${candidateId}: composite=${composite} mem=${(memResult.score*100).toFixed(0)} tool=${(toolResult.score*100).toFixed(0)} task=${(taskScore*100).toFixed(0)} (${Date.now()-start}ms)`);
        return score;
    } finally {
        // Always restore the registry to defaults so we don't leak state
        resetToDefaults();
    }
}
