// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Active Inference Memory Controller ───────────
 * Free energy minimization for principled information-seeking.
 * The agent queries memory not randomly but to reduce uncertainty.
 * Based on Active Inference (2025) and DR-FREE (Nature Comms, Dec 2025).
 */

// ── Types ─────────────────────────────────────

export interface BeliefState {
    hypotheses: string[];
    probabilities: number[];
    evidenceCounts: number[];
}

export interface InferenceDecision {
    shouldExplore: boolean;
    freeEnergy: number;
    entropy: number;
    bestQueryIndex: number;     // Which query to execute first
    explorationScore: number;   // 0=exploit, 1=explore
}

// ── Core Functions ────────────────────────────

/**
 * Decide whether the agent should seek more information or act on current beliefs.
 */
export function makeInferenceDecision(
    beliefs: BeliefState,
    queryRelevances: number[][],  // [query_idx][hypothesis_idx] = relevance
): InferenceDecision {
    const native = loadNative();

    // The fail-open loader returns {} when no binary exists for this platform, so
    // check the functions, not just truthiness, before taking the native path.
    if (native && typeof native.computeFreeEnergy === "function") {
        const nativeBeliefs = {
            hypotheses: beliefs.hypotheses,
            probabilities: beliefs.probabilities,
            evidenceCounts: beliefs.evidenceCounts,
        };

        const fe = native.computeFreeEnergy(nativeBeliefs);

        let bestQuery = 0;
        if (queryRelevances.length > 0) {
            const rankings = native.rankQueriesByInfoGain(nativeBeliefs, queryRelevances);
            if (rankings.length > 0) {
                bestQuery = rankings[0].queryIndex;
            }
        }

        const explorationScore = native.explorationExploitationDecision(
            fe.entropy,
            Math.log(beliefs.hypotheses.length),
            beliefs.evidenceCounts.reduce((a: number, b: number) => a + b, 0),
            5 // min evidence before exploiting
        );

        return {
            shouldExplore: fe.shouldExplore,
            freeEnergy: fe.freeEnergy,
            entropy: fe.entropy,
            bestQueryIndex: bestQuery,
            explorationScore,
        };
    }

    // JS fallback
    const sum = beliefs.probabilities.reduce((a, b) => a + b, 0);
    const probs = sum > 0 ? beliefs.probabilities.map(p => p / sum) : beliefs.probabilities.map(() => 1 / beliefs.probabilities.length);
    const entropy = -probs.filter(p => p > 1e-10).reduce((s, p) => s + p * Math.log(p), 0);
    const totalEvidence = beliefs.evidenceCounts.reduce((a, b) => a + b, 0);

    return {
        shouldExplore: entropy > 1.0 || totalEvidence < 5,
        freeEnergy: entropy,
        entropy,
        bestQueryIndex: 0,
        // `|| 2` only guarded length 0; length 1 gives log(1)=0 → 0/0 = NaN.
        // A single hypothesis has zero entropy, so exploration score is 0.
        explorationScore: Math.min(1, entropy / Math.log(Math.max(2, beliefs.hypotheses.length))),
    };
}

/**
 * Update beliefs given new evidence.
 */
export function updateBeliefs(
    beliefs: BeliefState,
    evidenceForHypothesis: number,
    strength: number,
): BeliefState {
    const native = loadNative();
    if (native && typeof native.updateBeliefs === "function") {
        const nativeBeliefs = {
            hypotheses: beliefs.hypotheses,
            probabilities: beliefs.probabilities,
            evidenceCounts: beliefs.evidenceCounts,
        };
        const updated = native.updateBeliefs(nativeBeliefs, evidenceForHypothesis, strength);
        return {
            hypotheses: updated.hypotheses,
            probabilities: updated.probabilities,
            evidenceCounts: updated.evidenceCounts,
        };
    }

    // JS fallback
    const newProbs = [...beliefs.probabilities];
    const newCounts = [...beliefs.evidenceCounts];
    if (evidenceForHypothesis < newProbs.length) {
        newProbs[evidenceForHypothesis] *= (1 + strength);
        newCounts[evidenceForHypothesis]++;
        const sum = newProbs.reduce((a, b) => a + b, 0);
        if (sum > 0) newProbs.forEach((_, i) => newProbs[i] /= sum);
    }
    return { hypotheses: beliefs.hypotheses, probabilities: newProbs, evidenceCounts: newCounts };
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;
function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const r = createRequire(import.meta.url);
        const path = require("node:path");
        _native = r(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}

/** Test-only: inject a fake native module ({} = fail-open/no binary) or undefined to restore. */
export function _setNativeForTests(mod: unknown): void {
    if (mod === undefined) { _native = null; _nativeLoaded = false; return; }
    _native = mod; _nativeLoaded = true;
}
