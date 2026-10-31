// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness v2: Pareto Frontier Tracking ──────────────────────────────
// NSGA-II front peeling + crowding distance. Objectives are always maximized.
// All four axes (task, tokenEff, memPrec, toolAcc) are drawn from HarnessScore.

import type {
    CandidateManifest,
    ObjectiveVector,
    ParetoPoint,
} from "./types.js";
import { createRequire as _nativeRequire } from "node:module";

let nativeParetoDominance: ((
    candidates: Array<[string, { task: number; tokenEff: number; memPrec: number; toolAcc: number }]>,
) => Array<{ candidateId: string; rank: number; crowdingDistance: number; isDominated: boolean }>) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let native: any = null;
    try { native = _nativeRequire(import.meta.url)(process.cwd() + "/native/index.js"); } catch { native = null; }
    if (native?.computeParetoDominance && process.env.BHAI_HARNESS_NATIVE !== "false") {
        nativeParetoDominance = native.computeParetoDominance;
    }
} catch { /* JS fallback */ }

export function extractObjectives(candidate: CandidateManifest): ObjectiveVector | null {
    const s = candidate.scores;
    if (!s) return null;
    return {
        task: s.taskCompletionScore,
        tokenEff: s.tokenEfficiency,
        memPrec: s.memoryRecallScore,
        toolAcc: s.toolSelectionScore,
    };
}

function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
    const ge = a.task >= b.task && a.tokenEff >= b.tokenEff && a.memPrec >= b.memPrec && a.toolAcc >= b.toolAcc;
    const gt = a.task > b.task || a.tokenEff > b.tokenEff || a.memPrec > b.memPrec || a.toolAcc > b.toolAcc;
    return ge && gt;
}

export function computeParetoFrontier(candidates: CandidateManifest[]): ParetoPoint[] {
    const scored: Array<{ id: string; obj: ObjectiveVector }> = [];
    for (const c of candidates) {
        const obj = extractObjectives(c);
        if (obj) scored.push({ id: c.candidateId, obj });
    }
    if (scored.length === 0) return [];

    if (nativeParetoDominance) {
        try {
            const input = scored.map(s => [s.id, { task: s.obj.task, tokenEff: s.obj.tokenEff, memPrec: s.obj.memPrec, toolAcc: s.obj.toolAcc }] as [string, { task: number; tokenEff: number; memPrec: number; toolAcc: number }]);
            const ranked = nativeParetoDominance(input);
            const points: ParetoPoint[] = scored.map(({ id, obj }) => {
                const r = ranked.find(x => x.candidateId === id);
                return { candidateId: id, objectives: obj, dominatedBy: [], dominates: [], rank: r?.rank ?? 1, crowdingDistance: r?.crowdingDistance ?? Infinity };
            });
            fillDominanceLists(points, scored);
            return points;
        } catch (e) {
            console.warn("[HARNESS-PARETO] native dominance failed, falling back:", (e as Error).message);
        }
    }

    return computeParetoFrontierJS(scored);
}

function computeParetoFrontierJS(scored: Array<{ id: string; obj: ObjectiveVector }>): ParetoPoint[] {
    const n = scored.length;
    const dominatedByCount = new Array<number>(n).fill(0);
    const dominatesList: number[][] = Array.from({ length: n }, () => []);
    const dominatedByIds: string[][] = Array.from({ length: n }, () => []);
    const dominatesIds: string[][] = Array.from({ length: n }, () => []);

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            if (dominates(scored[i].obj, scored[j].obj)) {
                dominatesList[i].push(j);
                dominatesIds[i].push(scored[j].id);
            } else if (dominates(scored[j].obj, scored[i].obj)) {
                dominatedByCount[i]++;
                dominatedByIds[i].push(scored[j].id);
            }
        }
    }

    const ranks = new Array<number>(n).fill(0);
    const remaining = dominatedByCount.slice();
    let currentFront: number[] = [];
    for (let i = 0; i < n; i++) if (remaining[i] === 0) currentFront.push(i);
    let rank = 1;
    while (currentFront.length > 0) {
        for (const i of currentFront) ranks[i] = rank;
        const next: number[] = [];
        for (const i of currentFront) {
            for (const j of dominatesList[i]) {
                if (remaining[j] > 0) { remaining[j]--; if (remaining[j] === 0) next.push(j); }
            }
        }
        currentFront = next;
        rank++;
    }

    const crowding = new Array<number>(n).fill(0);
    const maxRank = Math.max(1, ...ranks);
    const axes: Array<keyof ObjectiveVector> = ["task", "tokenEff", "memPrec", "toolAcc"];

    for (let r = 1; r <= maxRank; r++) {
        const inRank = scored.map((_, i) => i).filter(i => ranks[i] === r);
        if (inRank.length <= 2) { for (const i of inRank) crowding[i] = Infinity; continue; }
        for (const axis of axes) {
            const sorted = inRank.slice().sort((a, b) => scored[a].obj[axis] - scored[b].obj[axis]);
            const minV = scored[sorted[0]].obj[axis];
            const maxV = scored[sorted[sorted.length - 1]].obj[axis];
            const range = maxV - minV;
            crowding[sorted[0]] = Infinity;
            crowding[sorted[sorted.length - 1]] = Infinity;
            if (range < 1e-12) continue;
            for (let k = 1; k < sorted.length - 1; k++) {
                if (crowding[sorted[k]] === Infinity) continue;
                crowding[sorted[k]] += (scored[sorted[k + 1]].obj[axis] - scored[sorted[k - 1]].obj[axis]) / range;
            }
        }
    }

    return scored.map((s, i) => ({
        candidateId: s.id, objectives: s.obj,
        dominatedBy: dominatedByIds[i], dominates: dominatesIds[i],
        rank: ranks[i], crowdingDistance: crowding[i],
    }));
}

function fillDominanceLists(points: ParetoPoint[], scored: Array<{ id: string; obj: ObjectiveVector }>): void {
    for (let i = 0; i < points.length; i++) {
        for (let j = 0; j < points.length; j++) {
            if (i === j) continue;
            if (dominates(scored[i].obj, scored[j].obj)) points[i].dominates.push(scored[j].id);
            if (dominates(scored[j].obj, scored[i].obj)) points[i].dominatedBy.push(scored[j].id);
        }
    }
}

export function selectFromFrontier(frontier: ParetoPoint[], preferenceWeights?: Partial<ObjectiveVector>): string {
    const rank1 = frontier.filter(p => p.rank === 1);
    if (rank1.length === 0) {
        const best = frontier.slice().sort((a, b) => b.objectives.task - a.objectives.task)[0];
        return best?.candidateId ?? "";
    }
    if (rank1.length === 1) return rank1[0].candidateId;

    const allFinite = rank1.every(p => Number.isFinite(p.crowdingDistance));
    if (preferenceWeights && allFinite) {
        const w: ObjectiveVector = { task: preferenceWeights.task ?? 0, tokenEff: preferenceWeights.tokenEff ?? 0, memPrec: preferenceWeights.memPrec ?? 0, toolAcc: preferenceWeights.toolAcc ?? 0 };
        const wSum = w.task + w.tokenEff + w.memPrec + w.toolAcc;
        if (wSum > 0) {
            const scored = rank1.map(p => ({ id: p.candidateId, s: (p.objectives.task / 100) * w.task + p.objectives.tokenEff * w.tokenEff + p.objectives.memPrec * w.memPrec + p.objectives.toolAcc * w.toolAcc }));
            scored.sort((a, b) => b.s - a.s);
            return scored[0].id;
        }
    }

    return rank1.slice().sort((a, b) => {
        if (a.crowdingDistance !== b.crowdingDistance) return b.crowdingDistance - a.crowdingDistance;
        return b.objectives.task - a.objectives.task;
    })[0].candidateId;
}

export function isFrontierImproved(old: ParetoPoint[], updated: ParetoPoint[]): boolean {
    return approxHypervolume(updated) > approxHypervolume(old) + 1e-9;
}

function approxHypervolume(frontier: ParetoPoint[]): number {
    let hv = 0;
    for (const p of frontier) {
        if (p.rank !== 1) continue;
        hv += (p.objectives.task / 100) * p.objectives.tokenEff * p.objectives.memPrec * p.objectives.toolAcc;
    }
    return hv;
}

export function formatFrontierSummary(frontier: ParetoPoint[]): string {
    if (frontier.length === 0) return "_(frontier is empty)_\n";
    const lines: string[] = ["# Pareto Frontier", ""];
    const rank1 = frontier.filter(p => p.rank === 1);
    lines.push(`Rank-1 members: ${rank1.length} / ${frontier.length}`, "");
    lines.push("| candidate | rank | task | tokenEff | memPrec | toolAcc | crowding |");
    lines.push("|-----------|------|------|----------|---------|---------|----------|");
    for (const p of frontier) {
        const cd = Number.isFinite(p.crowdingDistance) ? p.crowdingDistance.toFixed(3) : "∞";
        lines.push(`| ${p.candidateId} | rank=${p.rank} | ${p.objectives.task.toFixed(1)} | ${p.objectives.tokenEff.toFixed(3)} | ${p.objectives.memPrec.toFixed(3)} | ${p.objectives.toolAcc.toFixed(3)} | ${cd} |`);
    }
    return lines.join("\n") + "\n";
}
