// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Optimization Outer Loop ────────────────────────────────
// The top-level orchestrator that mirrors the MetaHarnessEngine from the
// research paper: propose → apply → evaluate → store → repeat.
//
// Each iteration:
//   1. Materialize a new candidate workspace (copy of best parent)
//   2. Write .metaharness/ instruction bundle (AGENTS.md + all history)
//   3. Proposer agent reads filesystem and proposes HarnessConfig changes
//   4. Apply proposed config to registry
//   5. Run benchmark suite → HarnessScore
//   6. Compare to parent — keep if improved, discard otherwise
//   7. Restore best config, write manifest, continue
//
// After all iterations: persist best config to data/harness/active/harness-config.json

import type { LLMClient } from "../llm.js";
import type { CandidateManifest, OptimizeOptions, OptimizeResult } from "./types.js";
import { HarnessRunStore } from "./run-store.js";
import { proposeNextCandidate } from "./proposer.js";
import { evaluateCandidate } from "./evaluator.js";
import { applyConfig, persistActiveConfig, snapshotConfig } from "./registry.js";
import { setActiveCandidate, clearActiveCandidate, flushTracesToCandidate } from "./trace-store.js";
import { recordOutcome } from "../prompts/prompt-evolver.js";

// Native Rust acceleration for candidate comparison and leaderboard ranking
let nativeCompare: ((parent: number, challenger: number, threshold?: number) => { challenger_wins: boolean; delta: number; significant: boolean }) | null = null;
let nativeRank: ((candidates: Array<{ candidate_id: string; objective: number; outcome: string }>) => { ranked: Array<{ candidate_id: string; objective: number; outcome: string }>; best_candidate_id: string; best_objective: number; improvement_over_baseline: number }) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = await import("../../native/index.js").catch(() => null) as any;
    if (native?.compareHarnessCandidates) nativeCompare = native.compareHarnessCandidates;
    if (native?.rankHarnessCandidates) nativeRank = native.rankHarnessCandidates;
} catch { /* fall back to JS */ }

const DEFAULT_OPTIONS: OptimizeOptions = {
    budget: 20,
    fastMode: false,
    searchMode: "hill-climb",
    proposalBatchSize: 1,
    objective: "Maximize ATLAS agent quality: improve memory retrieval precision, tool selection accuracy, and task completion score while maintaining token efficiency.",
    usePareto: true,
    useSurrogate: true,
};

// ── Main entry point ────────────────────────────────────────────────────────

export async function runMetaHarnessOptimization(
    llm: LLMClient,
    options: Partial<OptimizeOptions> = {},
    onProgress?: (msg: string) => Promise<void>,
): Promise<OptimizeResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const runStart = Date.now();

    console.log(`[META-HARNESS] Starting optimization run — budget=${opts.budget}, fastMode=${opts.fastMode}, mode=${opts.searchMode}`);
    await onProgress?.("🔬 Meta-Harness: initializing optimization run…").catch(() => {});

    const store = new HarnessRunStore();
    store.initializeRun({
        budget: opts.budget,
        fastMode: opts.fastMode,
        searchMode: opts.searchMode,
        proposalBatchSize: opts.proposalBatchSize,
        objective: opts.objective,
    });

    // ── Step 1: Baseline ──────────────────────────────────────────────────
    await onProgress?.("🔬 Meta-Harness: scoring baseline…").catch(() => {});
    let best = store.materializeBaseline();
    setActiveCandidate(store.runDir, best.candidateId);

    const baselineScores = await evaluateCandidate(llm, best.candidateId, best.harnessConfig, { fastMode: opts.fastMode });
    best.scores = baselineScores;
    best.objective = baselineScores.composite;
    best.valid = true;
    best.outcome = "baseline";
    best.outcomeSummary = `Baseline composite score: ${baselineScores.composite}`;
    store.writeScores(best.candidateId, baselineScores);
    store.writeManifest(best);
    flushTracesToCandidate(store.runDir, best.candidateId);
    clearActiveCandidate();

    console.log(`[META-HARNESS] Baseline: composite=${baselineScores.composite} mem=${(baselineScores.memoryRecallScore*100).toFixed(0)} tool=${(baselineScores.toolSelectionScore*100).toFixed(0)}`);

    const allCandidateIds: string[] = [best.candidateId];
    let iterationsRun = 0;

    // ── Main optimization loop ────────────────────────────────────────────
    for (let iter = 0; iter < opts.budget; iter++) {
        iterationsRun++;
        console.log(`[META-HARNESS] Iteration ${iter + 1}/${opts.budget} (best=${best.objective})`);
        await onProgress?.(`🔬 Meta-Harness: iteration ${iter + 1}/${opts.budget} (best=${best.objective})…`).catch(() => {});

        // Materialize new candidate workspace
        const candidate = store.materializeCandidate(best);
        allCandidateIds.push(candidate.candidateId);

        // Write the .metaharness/ instruction bundle for the proposer
        store.writeInstructionBundle(candidate, best, opts.objective);

        // ── Propose ──────────────────────────────────────────────────────
        let proposed;
        try {
            proposed = await proposeNextCandidate(llm, candidate, store);
        } catch (propErr) {
            console.warn(`[META-HARNESS] Proposer failed (iter ${iter + 1}):`, (propErr as Error).message);
            candidate.outcome = "crash";
            candidate.outcomeSummary = `Proposer error: ${(propErr as Error).message}`;
            candidate.valid = false;
            store.writeManifest(candidate);
            continue;
        }

        store.writeProposedConfig(candidate.candidateId, proposed);

        // Check if proposer made no changes (no-op)
        const parentDims = best.harnessConfig.dimensions;
        const proposedDims = proposed.dimensions;
        const changedDims = Object.keys(proposedDims).filter(
            id => JSON.stringify(proposedDims[id]) !== JSON.stringify(parentDims[id])
        );
        if (changedDims.length === 0) {
            candidate.outcome = "no-change";
            candidate.outcomeSummary = "Proposer made no dimension changes";
            candidate.valid = best.valid;
            candidate.objective = best.objective;
            candidate.scores = best.scores;
            store.writeManifest(candidate);
            continue;
        }

        // ── Evaluate ─────────────────────────────────────────────────────
        setActiveCandidate(store.runDir, candidate.candidateId);
        let scores;
        try {
            scores = await evaluateCandidate(llm, candidate.candidateId, proposed, { fastMode: opts.fastMode });
        } catch (evalErr) {
            console.warn(`[META-HARNESS] Evaluation failed (iter ${iter + 1}):`, (evalErr as Error).message);
            candidate.outcome = "crash";
            candidate.outcomeSummary = `Evaluation error: ${(evalErr as Error).message}`;
            candidate.valid = false;
            store.writeManifest(candidate);
            clearActiveCandidate();
            // Restore best config
            applyConfig(best.harnessConfig);
            continue;
        }
        flushTracesToCandidate(store.runDir, candidate.candidateId);
        clearActiveCandidate();

        candidate.scores = scores;
        candidate.objective = scores.composite;
        candidate.valid = true;

        // ── Select (use Rust native comparison if available) ─────────────
        let improved: boolean;
        if (nativeCompare) {
            const cmp = nativeCompare(best.objective ?? 0, scores.composite);
            improved = cmp.challenger_wins;
        } else {
            improved = scores.composite > (best.objective ?? 0);
        }
        if (improved) {
            console.log(`[META-HARNESS] ✅ New best: ${candidate.candidateId} (${best.objective} → ${scores.composite}, changed: ${changedDims.join(", ")})`);
            candidate.outcome = "keep";
            candidate.outcomeSummary = `Improved from ${best.objective} to ${scores.composite} by changing: ${changedDims.join(", ")}`;

            // Record to prompt-evolver for cross-system tracking
            try {
                await recordOutcome("harness-meta", true, scores.composite / 100, scores.tokensUsed, true);
            } catch { /* non-fatal */ }

            best = candidate;
            applyConfig(proposed);
        } else {
            console.log(`[META-HARNESS] ⬇️ Discarded: ${candidate.candidateId} (${scores.composite} ≤ ${best.objective})`);
            candidate.outcome = "discard";
            candidate.outcomeSummary = `Score ${scores.composite} did not improve over parent ${best.objective}`;
            // Restore best config
            applyConfig(best.harnessConfig);
        }

        store.writeScores(candidate.candidateId, scores);
        store.writeManifest(candidate);

        await onProgress?.(`🔬 Meta-Harness: iter ${iter + 1} → ${scores.composite} (best: ${best.objective}) ${improved ? "✅ improved" : "⬇️ discarded"}`).catch(() => {});
    }

    // ── Persist best config ───────────────────────────────────────────────
    applyConfig(best.harnessConfig);
    persistActiveConfig(best.candidateId);

    // Use Rust native ranking for the final leaderboard if available
    if (nativeRank) {
        const history = store.readCandidateHistory();
        const ranked = nativeRank(history.map(c => ({
            candidate_id: c.candidateId,
            objective: c.objective ?? 0,
            outcome: c.outcome,
        })));
        console.log(`[META-HARNESS] Improvement over baseline: +${ranked.improvement_over_baseline} points`);
    }

    store.writeLeaderboard(best, allCandidateIds);

    const result: OptimizeResult = {
        runId: store.runId,
        runDir: store.runDir,
        bestCandidateId: best.candidateId,
        bestObjective: best.objective ?? 0,
        candidateIds: allCandidateIds,
        iterationsRun,
        durationMs: Date.now() - runStart,
        paretoFrontier: [],
    };

    console.log(`[META-HARNESS] Run complete. Best: ${best.candidateId} (score=${best.objective}) in ${(result.durationMs / 1000).toFixed(0)}s`);
    await onProgress?.(`✅ Meta-Harness complete: best score ${best.objective}/100 (${best.candidateId}), ${iterationsRun} iterations`).catch(() => {});

    return result;
}
