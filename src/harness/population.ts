// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Population Initialization ─────────────────────────────
// Evaluates 4 hardcoded seed configurations in parallel before the first
// proposal iteration, giving the Pareto optimizer a diverse starting frontier.

import type { LLMClient } from "../llm.js";
import type { CandidateManifest, HarnessConfig, SeedConfig } from "./types.js";
import type { HarnessRunStore } from "./run-store.js";
import { evaluateCandidate } from "./evaluator.js";
import { snapshotConfig, resetToDefaults } from "./registry.js";
import { setActiveCandidate, clearActiveCandidate, flushTracesToCandidate, clearTraceBuffer } from "./trace-store.js";

export const BHAI_SEED_CONFIGS: SeedConfig[] = [
    {
        id: "baseline-defaults",
        description: "Current hardcoded defaults — reference point",
        dimensions: {},
    },
    {
        id: "memory-aggressive",
        description: "Higher recall k-values, recency-skewed fusion",
        dimensions: {
            "memory.recall.k": 15,
            "memory.coreMemory.k": 15,
            "memory.fusion.relevanceWeight": 0.4,
            "memory.fusion.recencyWeight": 0.4,
            "memory.fusion.importanceWeight": 0.2,
            "memory.san.weight": 0.4,
        },
    },
    {
        id: "tool-conservative",
        description: "Fewer tools in context, higher confidence threshold",
        dimensions: {
            "toolRouter.maxToolsTotal": 24,
            "toolRouter.llmConfidenceThreshold": 0.55,
            "toolRouter.mcpSimilarityThreshold": 0.35,
        },
    },
    {
        id: "evaluator-strict",
        description: "Higher accept threshold, more retries",
        dimensions: {
            "evaluator.acceptThreshold": 80,
            "evaluator.retryThreshold": 50,
            "evaluator.maxRetries": 3,
            "swarm.multiCriticThreshold": 55,
            "swarm.moaThreshold": 65,
        },
    },
];

export async function initializePopulation(
    store: HarnessRunStore,
    llm: LLMClient,
    fastMode: boolean,
    onProgress?: (msg: string) => Promise<void>,
): Promise<CandidateManifest[]> {
    await onProgress?.(`🌱 Population: materializing ${BHAI_SEED_CONFIGS.length} seed candidates…`).catch(() => {});

    // Reset to hardcoded defaults before snapshotting, so baseline-defaults seed
    // always reflects the true factory defaults rather than a previous run's persisted config.
    resetToDefaults();

    // Materialize all candidate directories first (sequential, assigns c0000-c0003)
    const entries: Array<{ manifest: CandidateManifest; seed: SeedConfig; config: HarnessConfig }> = [];
    for (const seed of BHAI_SEED_CONFIGS) {
        const baseConfig = snapshotConfig("__seed__");
        const seedConfig: HarnessConfig = {
            candidateId: "__pending__",
            dimensions: { ...baseConfig.dimensions, ...seed.dimensions },
            createdAt: new Date().toISOString(),
        };

        const manifest = entries.length === 0
            ? store.materializeBaseline()
            : store.materializeCandidate(entries[0].manifest);

        seedConfig.candidateId = manifest.candidateId;
        manifest.harnessConfig = seedConfig;
        store.writeProposedConfig(manifest.candidateId, seedConfig);
        store.writeManifest(manifest);
        entries.push({ manifest, seed, config: seedConfig });
    }

    // Evaluate seeds sequentially — the registry is a process-singleton, so parallel
    // evaluations would trample each other's applyConfig/resetToDefaults calls.
    const valid: CandidateManifest[] = [];
    for (const { manifest, seed, config } of entries) {
        try {
            await onProgress?.(`🌱 Evaluating seed: ${seed.id}…`).catch(() => {});
            clearTraceBuffer();  // discard any traces from prior steps before this seed
            setActiveCandidate(store.runDir, manifest.candidateId);
            // evaluateCandidate handles applyConfig + resetToDefaults in its own try/finally
            const scores = await evaluateCandidate(llm, manifest.candidateId, config, { fastMode });
            flushTracesToCandidate(store.runDir, manifest.candidateId);
            clearActiveCandidate();

            manifest.scores = scores;
            manifest.objective = scores.composite;
            manifest.valid = true;
            manifest.outcome = manifest.candidateId === "c0000" ? "baseline" : "keep";
            manifest.outcomeSummary = `Seed "${seed.id}": composite=${scores.composite.toFixed(1)}`;
            store.writeScores(manifest.candidateId, scores);
            store.writeManifest(manifest);
            valid.push(manifest);
        } catch (err) {
            clearActiveCandidate();
            resetToDefaults();
            manifest.outcome = "crash";
            manifest.outcomeSummary = `Seed "${seed.id}" crashed: ${(err as Error).message}`;
            manifest.valid = false;
            store.writeManifest(manifest);
            console.warn(`[POPULATION] Seed ${seed.id} failed: ${(err as Error).message}`);
        }
    }

    await onProgress?.(`🌱 Population initialized: ${valid.length}/${BHAI_SEED_CONFIGS.length} seeds valid.`).catch(() => {});
    return valid;
}
