// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Optimization Outer Loop (v2) ─────────────────────────
// Full paper-fidelity loop (arxiv 2603.28052):
//   Phase 0: Population init — 4 seeds evaluated in parallel
//   Phase 1: For each iteration:
//     - NSGA-II select parent from Pareto frontier (or scalar best-of)
//     - Materialize candidate workspace
//     - TextGrad gradient hints if previous iter didn't improve
//     - Propose via filesystem-agent (or legacy) — proposer reads individual trace files
//     - Patch-validate code changes; apply if clean, else scope-violation
//     - Surrogate pre-screen; skip if predicted worse
//     - Evaluate, update Pareto, revert patches on regression

import type { LLMClient } from "../llm.js";
import type { CandidateManifest, OptimizeOptions, OptimizeResult, ParetoPoint } from "./types.js";
import { HarnessRunStore } from "./run-store.js";
import { proposeNextCandidate } from "./proposer.js";
import { proposeWithFilesystemAgent, type CodeChange } from "./code-proposer.js";
import { evaluateCandidate } from "./evaluator.js";
import { applyConfig, persistActiveConfig } from "./registry.js";
import { setActiveCandidate, clearActiveCandidate, flushTracesToCandidate, readCandidateTraces } from "./trace-store.js";
import { recordOutcome } from "../prompts/prompt-evolver.js";
import { initializePopulation } from "./population.js";
import { computeParetoFrontier, selectFromFrontier } from "./pareto.js";
import { buildSurrogate, shouldEvaluate } from "./surrogate.js";
import { generateDimensionGradients } from "./gradient.js";
import { validatePatch, applyCodeChange, revertCodeChanges } from "./patch-validator.js";

// Native Rust acceleration for comparison and ranking
let nativeCompare: ((parent: number, challenger: number, threshold?: number) => { challengerWins: boolean; delta: number; significant: boolean }) | null = null;
let nativeRank: ((candidates: Array<{ candidateId: string; objective: number; outcome: string }>) => { ranked: Array<{ candidateId: string; objective: number; outcome: string }>; bestCandidateId: string; bestObjective: number; improvementOverBaseline: number }) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = await import("../../native/index.js").catch(() => null) as any;
    if (native?.compareHarnessCandidates) nativeCompare = native.compareHarnessCandidates;
    if (native?.rankHarnessCandidates) nativeRank = native.rankHarnessCandidates;
} catch { /* fall back to JS */ }

const DEFAULT_OPTIONS: OptimizeOptions = {
    budget: 20,
    fastMode: false,
    searchMode: "frontier",
    proposalBatchSize: 1,
    objective: "Maximize ATLAS agent quality: improve memory retrieval, tool selection accuracy, and task completion score while maintaining token efficiency.",
    usePareto: true,
    useSurrogate: true,
    useCodeSearch: true,
    useGradients: true,
};

export async function runMetaHarnessOptimization(
    llm: LLMClient,
    options: Partial<OptimizeOptions> = {},
    onProgress?: (msg: string) => Promise<void>,
): Promise<OptimizeResult> {
    const opts: OptimizeOptions = { ...DEFAULT_OPTIONS, ...options };
    const runStart = Date.now();

    console.log(`[META-HARNESS v2] budget=${opts.budget} fast=${opts.fastMode} pareto=${opts.usePareto} surrogate=${opts.useSurrogate} codeSearch=${opts.useCodeSearch} gradients=${opts.useGradients}`);
    await onProgress?.("🔬 Meta-Harness v2: initializing…").catch(() => {});

    const store = new HarnessRunStore();
    store.initializeRun({
        budget: opts.budget, fastMode: opts.fastMode, searchMode: opts.searchMode,
        proposalBatchSize: opts.proposalBatchSize, objective: opts.objective,
        usePareto: opts.usePareto, useSurrogate: opts.useSurrogate,
        useCodeSearch: opts.useCodeSearch, useGradients: opts.useGradients,
    });

    // ── Phase 0: Population ───────────────────────────────────────────────
    const seeds = await initializePopulation(store, llm, opts.fastMode, onProgress);
    if (seeds.length === 0) throw new Error("All population seeds failed — cannot proceed.");

    let paretoFrontier: ParetoPoint[] = opts.usePareto ? computeParetoFrontier(seeds) : [];
    const allIds: string[] = seeds.map(m => m.candidateId);
    let best = _pickBest(seeds, paretoFrontier, opts.usePareto);
    let previousBestId = best.candidateId;

    let iterationsRun = 0;
    let surrogateSkips = 0;
    let lastIterImproved: boolean | null = null;

    // ── Phase 1: Proposal iterations ──────────────────────────────────────
    for (let iter = 0; iter < opts.budget; iter++) {
        iterationsRun++;
        await onProgress?.(`🔬 iter ${iter + 1}/${opts.budget} (best=${best.objective})…`).catch(() => {});

        // NSGA-II parent selection
        const parent: CandidateManifest = opts.usePareto && paretoFrontier.length > 0
            ? (store.readCandidateHistory().find(c => c.candidateId === selectFromFrontier(paretoFrontier)) ?? best)
            : best;

        const candidate = store.materializeCandidate(parent);
        allIds.push(candidate.candidateId);
        store.writeInstructionBundle(candidate, parent, opts.objective);

        // TextGrad hints if previous iter regressed
        if (opts.useGradients && lastIterImproved === false) {
            try {
                const parentTraces = readCandidateTraces(store.runDir, parent.candidateId);
                const gradients = await generateDimensionGradients(llm, parent, parentTraces, { bestScore: best.objective ?? 0 });
                if (gradients.length > 0) store.writeGradientHints(candidate.candidateId, gradients);
            } catch (err) {
                console.warn(`[META-HARNESS v2] Gradient generation failed: ${(err as Error).message}`);
            }
        }

        // Propose
        let proposed;
        let codeChanges: CodeChange[] = [];
        try {
            if (opts.useCodeSearch) {
                const r = await proposeWithFilesystemAgent(llm, candidate, store);
                proposed = r.config;
                codeChanges = r.codeChanges;
            } else {
                proposed = await proposeNextCandidate(llm, candidate, store);
            }
        } catch (err) {
            console.warn(`[META-HARNESS v2] Proposer crashed iter ${iter + 1}: ${(err as Error).message}`);
            candidate.outcome = "crash";
            candidate.outcomeSummary = `Proposer error: ${(err as Error).message}`;
            candidate.valid = false;
            store.writeManifest(candidate);
            continue;
        }

        // Validate + apply code changes
        if (codeChanges.length > 0) {
            const violations: string[] = codeChanges.flatMap(c => {
                const r = validatePatch(c.content, c.patchFile);
                return r.valid ? [] : r.violations;
            });
            if (violations.length > 0) {
                console.warn(`[META-HARNESS v2] Patch rejected for ${candidate.candidateId}: ${violations.length} violations`);
                candidate.outcome = "scope-violation";
                candidate.outcomeSummary = `Violations: ${violations.slice(0, 3).join("; ")}`;
                candidate.valid = false;
                store.writeManifest(candidate);
                continue;
            }
            for (const change of codeChanges) applyCodeChange(change, process.cwd());
        }

        store.writeProposedConfig(candidate.candidateId, proposed);

        // No-op check
        const changedDims = Object.keys(proposed.dimensions).filter(
            id => JSON.stringify(proposed.dimensions[id]) !== JSON.stringify(parent.harnessConfig.dimensions[id])
        );
        if (changedDims.length === 0 && codeChanges.length === 0) {
            candidate.outcome = "no-change";
            candidate.outcomeSummary = "No dimension or code changes proposed";
            // Mark valid=false so no-change duplicates don't contaminate Pareto frontier or GP surrogate
            candidate.valid = false;
            candidate.objective = parent.objective;
            candidate.scores = parent.scores;
            store.writeManifest(candidate);
            lastIterImproved = false;  // treat as regression so next iter generates gradients
            continue;
        }

        // Surrogate pre-screen
        if (opts.useSurrogate) {
            try {
                const surrogate = buildSurrogate(store.readCandidateHistory());
                if (!shouldEvaluate(surrogate, proposed, best.objective ?? 0)) {
                    candidate.outcome = "surrogate-skip";
                    candidate.outcomeSummary = "Surrogate predicted no improvement";
                    candidate.valid = false;
                    surrogateSkips++;
                    store.writeManifest(candidate);
                    if (codeChanges.length > 0) revertCodeChanges(process.cwd());
                    lastIterImproved = false;  // trigger gradients next iteration
                    continue;
                }
            } catch (err) {
                console.warn(`[META-HARNESS v2] Surrogate check failed: ${(err as Error).message}`);
            }
        }

        // Evaluate
        setActiveCandidate(store.runDir, candidate.candidateId);
        let scores;
        try {
            applyConfig(proposed);
            scores = await evaluateCandidate(llm, candidate.candidateId, proposed, { fastMode: opts.fastMode });
        } catch (err) {
            console.warn(`[META-HARNESS v2] Evaluation crashed: ${(err as Error).message}`);
            candidate.outcome = "crash";
            candidate.outcomeSummary = `Eval error: ${(err as Error).message}`;
            candidate.valid = false;
            store.writeManifest(candidate);
            clearActiveCandidate();
            if (codeChanges.length > 0) revertCodeChanges(process.cwd());
            applyConfig(best.harnessConfig);
            continue;
        }
        flushTracesToCandidate(store.runDir, candidate.candidateId);
        clearActiveCandidate();

        candidate.scores = scores;
        candidate.objective = scores.composite;
        candidate.valid = true;

        // Update Pareto + best
        const allValid = [...store.readCandidateHistory().filter(c => c.valid && c.candidateId !== candidate.candidateId), candidate];
        if (opts.usePareto) {
            paretoFrontier = computeParetoFrontier(allValid);
            const newBestId = selectFromFrontier(paretoFrontier);
            lastIterImproved = newBestId !== previousBestId;
            previousBestId = newBestId;
            best = allValid.find(c => c.candidateId === newBestId) ?? best;
        } else {
            const improved = nativeCompare
                ? nativeCompare(best.objective ?? 0, scores.composite).challengerWins
                : scores.composite > (best.objective ?? 0);
            lastIterImproved = improved;
            if (improved) { best = candidate; previousBestId = candidate.candidateId; }
        }

        if (lastIterImproved) {
            candidate.outcome = "keep";
            candidate.outcomeSummary = `Improved: ${parent.objective} → ${scores.composite}`;
            try { await recordOutcome("harness-meta", true, scores.composite / 100, scores.tokensUsed, true); } catch { /* */ }
            applyConfig(proposed);
        } else {
            candidate.outcome = "discard";
            candidate.outcomeSummary = `Score ${scores.composite} did not improve frontier (best=${best.objective})`;
            if (codeChanges.length > 0) revertCodeChanges(process.cwd());
            applyConfig(best.harnessConfig);
        }

        store.writeScores(candidate.candidateId, scores);
        store.writeManifest(candidate);
        await onProgress?.(`🔬 iter ${iter + 1} → ${scores.composite} (best=${best.objective}) ${lastIterImproved ? "✅" : "⬇️"}`).catch(() => {});
    }

    // Finalize
    applyConfig(best.harnessConfig);
    persistActiveConfig(best.candidateId);

    if (nativeRank) {
        const history = store.readCandidateHistory();
        const ranked = nativeRank(history.map(c => ({ candidateId: c.candidateId, objective: c.objective ?? 0, outcome: c.outcome })));
        console.log(`[META-HARNESS v2] Improvement over baseline: +${ranked.improvementOverBaseline}`);
    }
    store.writeLeaderboard(best, allIds);

    const result: OptimizeResult = {
        runId: store.runId,
        runDir: store.runDir,
        bestCandidateId: best.candidateId,
        bestObjective: best.objective ?? 0,
        candidateIds: allIds,
        iterationsRun,
        durationMs: Date.now() - runStart,
        paretoFrontier,
        surrogateSkips,
    };

    console.log(`[META-HARNESS v2] Done. Best=${best.candidateId} (${best.objective}) in ${(result.durationMs / 1000).toFixed(0)}s surrogateSkips=${surrogateSkips}`);
    await onProgress?.(`✅ Meta-Harness v2 complete: ${best.objective}/100 (${best.candidateId}), ${iterationsRun} iters`).catch(() => {});
    return result;
}

function _pickBest(
    manifests: CandidateManifest[],
    frontier: ParetoPoint[],
    usePareto: boolean,
): CandidateManifest {
    if (usePareto && frontier.length > 0) {
        const id = selectFromFrontier(frontier);
        const m = manifests.find(c => c.candidateId === id);
        if (m) return m;
    }
    return manifests.reduce(
        (best, c) => ((c.objective ?? -Infinity) > (best.objective ?? -Infinity) ? c : best),
        manifests[0],
    );
}
