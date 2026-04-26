// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness v2: Gaussian Process Surrogate ───────────────────────────
// Pre-screens proposed candidates before expensive benchmark evaluation.
// GP with RBF kernel when native Rust is available; k-NN IDW fallback in JS.
//
// shouldEvaluate(): skip only when upper-confidence-bound (mean + 1.5σ) is
// clearly below (bestScore - 5). Borderline cases always evaluate.

import type { CandidateManifest, HarnessConfig, GpObservation } from "./types.js";

const MIN_OBSERVATIONS = 5;
const EVAL_MARGIN = 5;
const SIGMA_MULT = 1.5;

let nativeGp: ((
    x: number[][],
    y: number[],
    q: number[],
    best: number,
) => { mean: number; variance: number; expectedImprovement: number }) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = await import("../../native/index.js").catch(() => null) as any;
    if (native?.fitAndPredictGp && process.env.ATLAS_HARNESS_NATIVE !== "false") {
        nativeGp = native.fitAndPredictGp;
    }
} catch { /* JS fallback */ }

export class SurrogateModel {
    readonly observations: GpObservation[];
    readonly numericDims: string[];
    readonly bestSoFar: number;

    constructor(obs: GpObservation[], numericDims: string[]) {
        this.observations = obs;
        this.numericDims = numericDims;
        this.bestSoFar = obs.reduce((m, o) => (o.score > m ? o.score : m), -Infinity);
    }

    predict(dims: Record<string, number>): { mean: number; uncertainty: number } {
        const q = this.numericDims.map(id => dims[id] ?? 0);
        const x = this.observations.map(o => this.numericDims.map(id => o.dims[id] ?? 0));
        const y = this.observations.map(o => o.score);

        if (nativeGp) {
            try {
                const result = nativeGp(x, y, q, this.bestSoFar);
                return { mean: result.mean, uncertainty: Math.sqrt(Math.max(0, result.variance)) };
            } catch (e) {
                console.warn("[HARNESS-SURROGATE] native GP failed, falling back:", (e as Error).message);
            }
        }

        return jsInverseDistance(x, y, q);
    }

    acquisitionEI(dims: Record<string, number>, bestSoFar: number): number {
        const q = this.numericDims.map(id => dims[id] ?? 0);
        const x = this.observations.map(o => this.numericDims.map(id => o.dims[id] ?? 0));
        const y = this.observations.map(o => o.score);

        if (nativeGp) {
            try {
                const r = nativeGp(x, y, q, bestSoFar);
                return Math.max(0, r.expectedImprovement);
            } catch { /* fall through */ }
        }

        const pred = jsInverseDistance(x, y, q);
        const sigma = pred.uncertainty;
        if (sigma < 1e-9) return 0;
        const z = (pred.mean - bestSoFar - 0.01) / sigma;
        return Math.max(0, (pred.mean - bestSoFar - 0.01) * normCdf(z) + sigma * normPdf(z));
    }
}

export function buildSurrogate(history: CandidateManifest[]): SurrogateModel | null {
    // Exclude no-change and other non-evaluated outcomes to avoid duplicate (x,y) training pairs
    const scored = history.filter(c => c.scores !== null && c.valid && c.outcome !== "no-change");
    if (scored.length < MIN_OBSERVATIONS) return null;

    const numericDims = new Set<string>();
    for (const c of scored) {
        for (const [id, v] of Object.entries(c.harnessConfig.dimensions)) {
            if (typeof v === "number" && Number.isFinite(v)) numericDims.add(id);
        }
    }
    if (numericDims.size === 0) return null;
    const dimList = [...numericDims].sort();

    const obs: GpObservation[] = scored.map(c => {
        const dimsRecord: Record<string, number> = {};
        for (const id of dimList) {
            const v = c.harnessConfig.dimensions[id];
            dimsRecord[id] = (typeof v === "number" && Number.isFinite(v)) ? v : 0;
        }
        return { dims: dimsRecord, score: c.scores!.composite };
    });

    return new SurrogateModel(obs, dimList);
}

export function shouldEvaluate(
    surrogate: SurrogateModel | null,
    config: HarnessConfig,
    bestScore: number,
): boolean {
    if (surrogate === null) return true;

    const numericDims: Record<string, number> = {};
    for (const id of surrogate.numericDims) {
        const v = config.dimensions[id];
        numericDims[id] = (typeof v === "number" && Number.isFinite(v)) ? v : 0;
    }

    const { mean, uncertainty } = surrogate.predict(numericDims);
    if (mean > bestScore - EVAL_MARGIN) return true;
    if (mean + SIGMA_MULT * uncertainty < bestScore - EVAL_MARGIN) return false;
    return true;
}

function jsInverseDistance(x: number[][], y: number[], q: number[]): { mean: number; uncertainty: number } {
    if (x.length === 0) return { mean: 0, uncertainty: 1 };
    const k = Math.min(3, x.length);
    const dists = x.map((xi, i) => ({ i, d: euclidean(xi, q) })).sort((a, b) => a.d - b.d);
    if (dists[0].d < 1e-9) return { mean: y[dists[0].i], uncertainty: 0.5 };

    const nearest = dists.slice(0, k);
    const weights = nearest.map(n => 1 / (n.d * n.d + 1e-6));
    const wSum = weights.reduce((s, w) => s + w, 0);
    const meanVal = nearest.reduce((s, n, idx) => s + y[n.i] * weights[idx], 0) / wSum;

    const neighborScores = nearest.map(n => y[n.i]);
    const mn = neighborScores.reduce((s, v) => s + v, 0) / neighborScores.length;
    const variance = neighborScores.reduce((s, v) => s + (v - mn) ** 2, 0) / Math.max(1, neighborScores.length - 1);
    const uncertainty = Math.sqrt(variance) + 0.1 * Math.min(10, dists[0].d);

    return { mean: meanVal, uncertainty };
}

function euclidean(a: number[], b: number[]): number {
    return Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
}

function normPdf(z: number): number {
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

function normCdf(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z < 0 ? p : 1 - p;
}
