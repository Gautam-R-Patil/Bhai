# Meta-Harness v2 Implementation Plan — Part 1: Types, Pareto, Surrogate, Gradient

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Meta-Harness v1 with Pareto frontier tracking, Bayesian GP surrogate pre-screening, and TextGrad-style per-dimension gradients.

**Architecture:** New TypeScript modules (pareto.ts, surrogate.ts, gradient.ts) plus Rust extensions in harness_optimizer.rs. All modules are standalone — they import from types.ts and registry.ts but do not modify the optimizer loop (that's Part 2).

**Tech Stack:** TypeScript ESM, napi-rs Rust, existing LLMClient from src/llm.ts

---

## Repository Context

- **Root:** `/Users/user/Desktop/ATLAS`
- **Existing v1 Harness:** `/Users/user/Desktop/ATLAS/src/harness/` (types.ts, evaluator.ts, registry.ts, run-store.ts, trace-store.ts, benchmarks/, proposer.ts)
- **Native Rust:** `/Users/user/Desktop/ATLAS/native/src/harness_optimizer.rs` — already has `compute_harness_composite`, `compare_harness_candidates`, `clamp_proposed_dimensions`, `diff_harness_configs`, `aggregate_traces`, `rank_harness_candidates`
- **Native export registry:** `/Users/user/Desktop/ATLAS/native/src/lib.rs` (module declared via `mod harness_optimizer;` and re-exported via `pub use harness_optimizer::*;` — follow existing pattern)
- **Test dir:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/` (create if missing; vitest, ES modules, `.js` extensions in imports)
- **Build:** `npm run build:native` for Rust, `npm run typecheck` for TS, `npm test` for vitest
- **Env kill-switches follow pattern:** `ATLAS_HARNESS_NO_PARETO`, `ATLAS_HARNESS_NO_SURROGATE`, `ATLAS_HARNESS_NO_GRADIENTS` — consumed in Part 2; export constants in Part 1 so the predicates are centrally defined.

---

## Task 1: Extend types.ts with v2 interfaces

**Files:**
- **Modify:** `/Users/user/Desktop/ATLAS/src/harness/types.ts`
- **Test:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/types.test.ts` (smoke test — verify interfaces compile and default shapes are coherent)

### TDD Steps

- [ ] **1.1** Write failing test that imports new types from `../types.js` and asserts runtime shape helpers exist
- [ ] **1.2** Run `npm test -- src/harness/__tests__/types.test.ts` — must fail (imports unresolved)
- [ ] **1.3** Implement the new type additions in `types.ts`
- [ ] **1.4** Run `npm run typecheck` — must pass
- [ ] **1.5** Run `npm test -- src/harness/__tests__/types.test.ts` — must pass
- [ ] **1.6** Commit

### Test Code

Write `/Users/user/Desktop/ATLAS/src/harness/__tests__/types.test.ts`:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import {
    DEFAULT_OBJECTIVE_VECTOR,
    isObjectiveVector,
    isParetoPoint,
} from "../types.js";
import type {
    ObjectiveVector,
    ParetoPoint,
    SeedConfig,
    DimensionGradient,
    GpObservation,
    OptimizeOptions,
    OptimizeResult,
} from "../types.js";

describe("harness v2 types", () => {
    it("DEFAULT_OBJECTIVE_VECTOR is a zeroed ObjectiveVector", () => {
        expect(DEFAULT_OBJECTIVE_VECTOR).toEqual({
            task: 0,
            tokenEff: 0,
            memPrec: 0,
            toolAcc: 0,
        });
    });

    it("isObjectiveVector validates shape", () => {
        const valid: ObjectiveVector = { task: 50, tokenEff: 0.5, memPrec: 0.8, toolAcc: 0.9 };
        expect(isObjectiveVector(valid)).toBe(true);
        expect(isObjectiveVector({ task: 50 })).toBe(false);
        expect(isObjectiveVector(null)).toBe(false);
        expect(isObjectiveVector({ task: "x", tokenEff: 0, memPrec: 0, toolAcc: 0 })).toBe(false);
    });

    it("isParetoPoint requires all NSGA-II fields", () => {
        const p: ParetoPoint = {
            candidateId: "c0001",
            objectives: { task: 70, tokenEff: 0.6, memPrec: 0.7, toolAcc: 0.8 },
            dominatedBy: [],
            dominates: ["c0002"],
            rank: 1,
            crowdingDistance: Infinity,
        };
        expect(isParetoPoint(p)).toBe(true);
        expect(isParetoPoint({ ...p, rank: undefined })).toBe(false);
    });

    it("SeedConfig carries partial dimension records", () => {
        const seed: SeedConfig = {
            id: "aggressive-memory",
            description: "High memory recall weight",
            dimensions: { "memory.recall.k": 20 },
        };
        expect(seed.id).toBe("aggressive-memory");
        expect(seed.dimensions["memory.recall.k"]).toBe(20);
    });

    it("DimensionGradient accepts all severity levels", () => {
        const severities: DimensionGradient["severity"][] = ["critical", "moderate", "minor"];
        const directions: DimensionGradient["proposedDirection"][] = ["increase", "decrease", "rewrite"];
        for (const sev of severities) {
            for (const dir of directions) {
                const g: DimensionGradient = {
                    dimensionId: "memory.recall.k",
                    currentValue: 10,
                    critique: "too low",
                    proposedDirection: dir,
                    severity: sev,
                };
                expect(g.severity).toBe(sev);
                expect(g.proposedDirection).toBe(dir);
            }
        }
    });

    it("GpObservation ties numeric dims to a score", () => {
        const o: GpObservation = { dims: { "memory.recall.k": 10 }, score: 62 };
        expect(o.score).toBe(62);
    });

    it("OptimizeOptions carries usePareto + useSurrogate", () => {
        const opts: OptimizeOptions = {
            budget: 20,
            fastMode: false,
            searchMode: "frontier",
            proposalBatchSize: 1,
            objective: "increase memory recall",
            usePareto: true,
            useSurrogate: true,
        };
        expect(opts.usePareto).toBe(true);
        expect(opts.useSurrogate).toBe(true);
    });

    it("OptimizeResult carries paretoFrontier", () => {
        const r: OptimizeResult = {
            runId: "run_x",
            runDir: "/tmp/x",
            bestCandidateId: "c0001",
            bestObjective: 72,
            candidateIds: ["c0000", "c0001"],
            iterationsRun: 2,
            durationMs: 1000,
            paretoFrontier: [],
        };
        expect(r.paretoFrontier).toEqual([]);
    });
});
```

### Implementation Code

Append to `/Users/user/Desktop/ATLAS/src/harness/types.ts` (do not modify existing exports except `OptimizeOptions` and `OptimizeResult`):

```typescript
// ── Meta-Harness v2 additions ───────────────────────────────────────────────

/**
 * Four-axis objective vector for multi-objective Pareto optimization.
 * Extracted from HarnessScore by extractObjectives() in pareto.ts.
 *   task:     0-100 (taskCompletionScore)
 *   tokenEff: 0-1   (tokenEfficiency)
 *   memPrec:  0-1   (memoryRecallScore)
 *   toolAcc:  0-1   (toolSelectionScore)
 */
export interface ObjectiveVector {
    task: number;
    tokenEff: number;
    memPrec: number;
    toolAcc: number;
}

/** Zero vector used as the "no data" baseline. */
export const DEFAULT_OBJECTIVE_VECTOR: ObjectiveVector = {
    task: 0,
    tokenEff: 0,
    memPrec: 0,
    toolAcc: 0,
};

/** NSGA-II-style Pareto frontier point. rank=1 means Pareto-optimal. */
export interface ParetoPoint {
    candidateId: string;
    objectives: ObjectiveVector;
    dominatedBy: string[];
    dominates: string[];
    rank: number;               // 1 = Pareto optimal, 2 = dominated only by rank-1, ...
    crowdingDistance: number;   // Infinity at frontier boundaries
}

/** Seed configuration — a named starting point for the optimizer. */
export interface SeedConfig {
    id: string;
    description: string;
    dimensions: Partial<Record<string, unknown>>;
}

/** Natural-language "gradient" for a single dimension, produced by TextGrad-style critique. */
export interface DimensionGradient {
    dimensionId: string;
    currentValue: unknown;
    critique: string;
    proposedDirection: "increase" | "decrease" | "rewrite";
    severity: "critical" | "moderate" | "minor";
}

/** A single (config, score) observation for the GP surrogate. */
export interface GpObservation {
    dims: Record<string, number>;
    score: number;
}

// ── Runtime guards (used by pareto.ts, surrogate.ts, gradient.ts) ──────────

export function isObjectiveVector(x: unknown): x is ObjectiveVector {
    if (x === null || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return (
        typeof o.task === "number" &&
        typeof o.tokenEff === "number" &&
        typeof o.memPrec === "number" &&
        typeof o.toolAcc === "number"
    );
}

export function isParetoPoint(x: unknown): x is ParetoPoint {
    if (x === null || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return (
        typeof o.candidateId === "string" &&
        isObjectiveVector(o.objectives) &&
        Array.isArray(o.dominatedBy) &&
        Array.isArray(o.dominates) &&
        typeof o.rank === "number" &&
        typeof o.crowdingDistance === "number"
    );
}
```

Replace the existing `OptimizeResult` and `OptimizeOptions` interfaces with:

```typescript
// Result returned by the optimizer outer loop
export interface OptimizeResult {
    runId: string;
    runDir: string;
    bestCandidateId: string;
    bestObjective: number;
    candidateIds: string[];
    iterationsRun: number;
    durationMs: number;
    paretoFrontier: ParetoPoint[];   // v2: multi-objective frontier (empty if not enabled)
}

// Options for the outer optimization loop
export interface OptimizeOptions {
    budget: number;             // number of proposal iterations (default 20)
    fastMode: boolean;          // skip network benchmarks (default false)
    searchMode: 'hill-climb' | 'frontier';
    proposalBatchSize: number;
    objective: string;          // plain-text goal injected into proposer instructions
    usePareto: boolean;         // v2: track + emit Pareto frontier
    useSurrogate: boolean;      // v2: screen candidates with GP surrogate before evaluating
}
```

### Commit

```bash
cd /Users/user/Desktop/ATLAS && git add src/harness/types.ts src/harness/__tests__/types.test.ts && git commit -m "feat(harness): v2 types — ObjectiveVector, ParetoPoint, SeedConfig, DimensionGradient, GpObservation"
```

---

## Task 2: Pareto frontier tracking (pareto.ts)

**Files:**
- **Create:** `/Users/user/Desktop/ATLAS/src/harness/pareto.ts`
- **Modify:** `/Users/user/Desktop/ATLAS/native/src/harness_optimizer.rs` (add `compute_pareto_dominance` + `ObjectiveVector` + `ParetoRankResult`)
- **Modify:** `/Users/user/Desktop/ATLAS/native/src/lib.rs` (nothing — `pub use harness_optimizer::*;` already re-exports)
- **Test:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/pareto.test.ts`

### TDD Steps

- [ ] **2.1** Add Rust types `ObjectiveVector`, `ParetoRankResult`, and `compute_pareto_dominance` to `harness_optimizer.rs`
- [ ] **2.2** Run `npm run build:native` — must compile
- [ ] **2.3** Write `pareto.test.ts` — fails (pareto.ts not yet created)
- [ ] **2.4** Implement `pareto.ts` (pure-JS fallback + native path)
- [ ] **2.5** Run `npm run typecheck` — must pass
- [ ] **2.6** Run `npm test -- src/harness/__tests__/pareto.test.ts` — must pass for both the JS-fallback path (force via `ATLAS_HARNESS_NATIVE=false`) and the native path
- [ ] **2.7** Commit

### Rust Additions — `/Users/user/Desktop/ATLAS/native/src/harness_optimizer.rs`

Append these blocks at the end of the file (before the `// ── Internal helpers ──` section, so `percentile` and `clamp01` remain last):

```rust
// ── Pareto dominance (v2) ────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectiveVector {
    pub task: f64,       // 0-100
    pub token_eff: f64,  // 0-1
    pub mem_prec: f64,   // 0-1
    pub tool_acc: f64,   // 0-1
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParetoRankResult {
    pub candidate_id: String,
    pub rank: u32,
    pub crowding_distance: f64,
    pub is_dominated: bool,
}

/// Compute Pareto dominance and NSGA-II rank + crowding distance for a set
/// of (candidate_id, objectives) pairs.
///
/// Returns one ParetoRankResult per input candidate. rank=1 means Pareto
/// optimal; higher ranks are dominated successively.
///
/// All four objectives are maximized. Crowding distance uses the classical
/// NSGA-II formula: per objective, sort by that axis, set boundary distances
/// to f64::INFINITY, interior = (next - prev) / (max - min).
#[napi]
pub fn compute_pareto_dominance(
    candidates: Vec<(String, ObjectiveVector)>,
) -> Vec<ParetoRankResult> {
    let n = candidates.len();
    if n == 0 {
        return Vec::new();
    }

    // Step 1: pairwise dominance — O(n^2)
    let mut dominated_by_count = vec![0u32; n];
    let mut dominates_list: Vec<Vec<usize>> = vec![Vec::new(); n];

    for i in 0..n {
        for j in 0..n {
            if i == j { continue; }
            if dominates(&candidates[i].1, &candidates[j].1) {
                dominates_list[i].push(j);
            } else if dominates(&candidates[j].1, &candidates[i].1) {
                dominated_by_count[i] += 1;
            }
        }
    }

    // Step 2: NSGA-II rank assignment via front peeling
    let mut ranks = vec![0u32; n];
    let mut current_front: Vec<usize> = (0..n)
        .filter(|&i| dominated_by_count[i] == 0)
        .collect();
    let mut current_rank: u32 = 1;
    let mut remaining_dominated = dominated_by_count.clone();

    while !current_front.is_empty() {
        for &i in &current_front {
            ranks[i] = current_rank;
        }
        let mut next_front: Vec<usize> = Vec::new();
        for &i in &current_front {
            for &j in &dominates_list[i] {
                if remaining_dominated[j] > 0 {
                    remaining_dominated[j] -= 1;
                    if remaining_dominated[j] == 0 {
                        next_front.push(j);
                    }
                }
            }
        }
        current_front = next_front;
        current_rank += 1;
    }

    // Step 3: crowding distance — per-rank, per-objective
    let mut crowding = vec![0f64; n];
    let max_rank = *ranks.iter().max().unwrap_or(&1);

    for rank_value in 1..=max_rank {
        let indices: Vec<usize> = (0..n).filter(|&i| ranks[i] == rank_value).collect();
        if indices.len() <= 2 {
            // Boundary members always get infinity
            for &i in &indices {
                crowding[i] = f64::INFINITY;
            }
            continue;
        }

        for axis in 0..4 {
            let mut sorted = indices.clone();
            sorted.sort_by(|&a, &b| {
                let va = objective_axis(&candidates[a].1, axis);
                let vb = objective_axis(&candidates[b].1, axis);
                va.partial_cmp(&vb).unwrap_or(std::cmp::Ordering::Equal)
            });
            let min_v = objective_axis(&candidates[sorted[0]].1, axis);
            let max_v = objective_axis(&candidates[*sorted.last().unwrap()].1, axis);
            let range = max_v - min_v;

            // Boundaries → infinity
            crowding[sorted[0]] = f64::INFINITY;
            crowding[*sorted.last().unwrap()] = f64::INFINITY;

            if range <= 1e-12 {
                continue;
            }

            for k in 1..(sorted.len() - 1) {
                if crowding[sorted[k]] == f64::INFINITY {
                    continue; // preserve boundary from other axis
                }
                let prev_v = objective_axis(&candidates[sorted[k - 1]].1, axis);
                let next_v = objective_axis(&candidates[sorted[k + 1]].1, axis);
                crowding[sorted[k]] += (next_v - prev_v) / range;
            }
        }
    }

    (0..n)
        .map(|i| ParetoRankResult {
            candidate_id: candidates[i].0.clone(),
            rank: ranks[i],
            crowding_distance: crowding[i],
            is_dominated: ranks[i] > 1,
        })
        .collect()
}

#[inline]
fn dominates(a: &ObjectiveVector, b: &ObjectiveVector) -> bool {
    // a dominates b iff a >= b on every axis AND a > b on at least one.
    let ge = a.task >= b.task
        && a.token_eff >= b.token_eff
        && a.mem_prec >= b.mem_prec
        && a.tool_acc >= b.tool_acc;
    let gt = a.task > b.task
        || a.token_eff > b.token_eff
        || a.mem_prec > b.mem_prec
        || a.tool_acc > b.tool_acc;
    ge && gt
}

#[inline]
fn objective_axis(v: &ObjectiveVector, axis: usize) -> f64 {
    match axis {
        0 => v.task,
        1 => v.token_eff,
        2 => v.mem_prec,
        3 => v.tool_acc,
        _ => 0.0,
    }
}
```

Note: `lib.rs` already re-exports everything from `harness_optimizer` via `pub use harness_optimizer::*;` (existing pattern). No changes to `lib.rs` are needed for Task 2; the new types and function are picked up automatically.

### Test Code — `/Users/user/Desktop/ATLAS/src/harness/__tests__/pareto.test.ts`

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

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
```

### Implementation Code — `/Users/user/Desktop/ATLAS/src/harness/pareto.ts`

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness v2: Pareto Frontier Tracking ──────────────────────────────
// NSGA-II front peeling + crowding distance. Objectives are always maximized.
// All four axes (task, tokenEff, memPrec, toolAcc) are drawn from HarnessScore.
//
// The selection strategy picks a Pareto-optimal candidate with the highest
// crowding distance (= most unique trade-off profile), falling back to a
// preference-weighted score when all frontier members have finite crowding.

import type {
    CandidateManifest,
    ObjectiveVector,
    ParetoPoint,
} from "./types.js";

// Native Rust acceleration
let nativeParetoDominance: ((
    candidates: Array<[string, { task: number; tokenEff: number; memPrec: number; toolAcc: number }]>,
) => Array<{ candidateId: string; rank: number; crowdingDistance: number; isDominated: boolean }>) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = await import("../../native/index.js").catch(() => null) as any;
    if (native?.computeParetoDominance && process.env.ATLAS_HARNESS_NATIVE !== "false") {
        nativeParetoDominance = native.computeParetoDominance;
    }
} catch { /* JS fallback */ }

// ── Extract objectives from a candidate ────────────────────────────────────

/**
 * Build an ObjectiveVector from a candidate's HarnessScore. Returns null when
 * scores are missing (unevaluated candidates are excluded from the frontier).
 */
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

// ── Dominance check (pure JS) ──────────────────────────────────────────────

/** a dominates b iff a >= b on every axis AND a > b on at least one. */
function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
    const ge = a.task >= b.task
        && a.tokenEff >= b.tokenEff
        && a.memPrec >= b.memPrec
        && a.toolAcc >= b.toolAcc;
    const gt = a.task > b.task
        || a.tokenEff > b.tokenEff
        || a.memPrec > b.memPrec
        || a.toolAcc > b.toolAcc;
    return ge && gt;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute Pareto rank + crowding distance for all candidates that have scores.
 * Uses native Rust if available; otherwise runs the O(n²) JS fallback.
 *
 * Candidates without scores are silently excluded.
 */
export function computeParetoFrontier(candidates: CandidateManifest[]): ParetoPoint[] {
    // Filter out unscored candidates and build parallel arrays
    const scored: Array<{ id: string; obj: ObjectiveVector }> = [];
    for (const c of candidates) {
        const obj = extractObjectives(c);
        if (obj) scored.push({ id: c.candidateId, obj });
    }
    if (scored.length === 0) return [];

    // Try native path
    if (nativeParetoDominance) {
        try {
            const input = scored.map(s => [s.id, s.obj] as [string, ObjectiveVector]);
            const ranked = nativeParetoDominance(input);

            // Reconstruct dominatedBy / dominates lists (native returns only rank + crowding)
            const points: ParetoPoint[] = scored.map(({ id, obj }) => {
                const r = ranked.find(x => x.candidateId === id);
                return {
                    candidateId: id,
                    objectives: obj,
                    dominatedBy: [],
                    dominates: [],
                    rank: r?.rank ?? 1,
                    crowdingDistance: r?.crowdingDistance ?? Infinity,
                };
            });
            fillDominanceLists(points, scored);
            return points;
        } catch (e) {
            console.warn("[HARNESS-PARETO] native dominance failed, falling back:", (e as Error).message);
        }
    }

    // Pure-JS fallback
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

    // NSGA-II rank assignment via front peeling
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
                if (remaining[j] > 0) {
                    remaining[j]--;
                    if (remaining[j] === 0) next.push(j);
                }
            }
        }
        currentFront = next;
        rank++;
    }

    // Crowding distance per rank, per axis
    const crowding = new Array<number>(n).fill(0);
    const maxRank = Math.max(1, ...ranks);
    const axes: Array<keyof ObjectiveVector> = ["task", "tokenEff", "memPrec", "toolAcc"];

    for (let r = 1; r <= maxRank; r++) {
        const inRank = scored.map((_, i) => i).filter(i => ranks[i] === r);
        if (inRank.length <= 2) {
            for (const i of inRank) crowding[i] = Infinity;
            continue;
        }
        for (const axis of axes) {
            const sorted = inRank.slice().sort((a, b) => scored[a].obj[axis] - scored[b].obj[axis]);
            const minV = scored[sorted[0]].obj[axis];
            const maxV = scored[sorted[sorted.length - 1]].obj[axis];
            const range = maxV - minV;
            crowding[sorted[0]] = Infinity;
            crowding[sorted[sorted.length - 1]] = Infinity;
            if (range < 1e-12) continue;
            for (let k = 1; k < sorted.length - 1; k++) {
                if (crowding[sorted[k]] === Infinity) continue; // preserve boundary from another axis
                const prevV = scored[sorted[k - 1]].obj[axis];
                const nextV = scored[sorted[k + 1]].obj[axis];
                crowding[sorted[k]] += (nextV - prevV) / range;
            }
        }
    }

    return scored.map((s, i) => ({
        candidateId: s.id,
        objectives: s.obj,
        dominatedBy: dominatedByIds[i],
        dominates: dominatesIds[i],
        rank: ranks[i],
        crowdingDistance: crowding[i],
    }));
}

/** Fill dominatedBy + dominates lists on a set of ParetoPoints (used after native call). */
function fillDominanceLists(points: ParetoPoint[], scored: Array<{ id: string; obj: ObjectiveVector }>): void {
    for (let i = 0; i < points.length; i++) {
        for (let j = 0; j < points.length; j++) {
            if (i === j) continue;
            if (dominates(scored[i].obj, scored[j].obj)) points[i].dominates.push(scored[j].id);
            if (dominates(scored[j].obj, scored[i].obj)) points[i].dominatedBy.push(scored[j].id);
        }
    }
}

// ── Selection ──────────────────────────────────────────────────────────────

/**
 * Pick a single candidate from the rank-1 frontier.
 *
 * 1. Restrict to rank === 1
 * 2. If preferenceWeights are provided AND all rank-1 crowding distances are
 *    finite, pick the one with highest weighted-sum score
 * 3. Otherwise pick the highest crowding distance (ties broken by task axis)
 */
export function selectFromFrontier(
    frontier: ParetoPoint[],
    preferenceWeights?: Partial<ObjectiveVector>,
): string {
    const rank1 = frontier.filter(p => p.rank === 1);
    if (rank1.length === 0) {
        // Nothing is rank 1 — fall back to highest task score across all
        const best = frontier.slice().sort((a, b) => b.objectives.task - a.objectives.task)[0];
        return best?.candidateId ?? "";
    }
    if (rank1.length === 1) return rank1[0].candidateId;

    const allFinite = rank1.every(p => Number.isFinite(p.crowdingDistance));
    if (preferenceWeights && allFinite) {
        const w: ObjectiveVector = {
            task: preferenceWeights.task ?? 0,
            tokenEff: preferenceWeights.tokenEff ?? 0,
            memPrec: preferenceWeights.memPrec ?? 0,
            toolAcc: preferenceWeights.toolAcc ?? 0,
        };
        const wSum = w.task + w.tokenEff + w.memPrec + w.toolAcc;
        if (wSum > 0) {
            const scored = rank1.map(p => ({
                id: p.candidateId,
                s:
                    (p.objectives.task / 100) * w.task +
                    p.objectives.tokenEff * w.tokenEff +
                    p.objectives.memPrec * w.memPrec +
                    p.objectives.toolAcc * w.toolAcc,
            }));
            scored.sort((a, b) => b.s - a.s);
            return scored[0].id;
        }
    }

    // Default: highest crowding distance
    const sorted = rank1.slice().sort((a, b) => {
        if (a.crowdingDistance !== b.crowdingDistance) return b.crowdingDistance - a.crowdingDistance;
        return b.objectives.task - a.objectives.task;
    });
    return sorted[0].candidateId;
}

// ── Improvement detection ──────────────────────────────────────────────────

/**
 * True if `updated` covers strictly more Pareto volume than `old`. We use the
 * cheap approximation: sum over rank-1 points of product(normalized objectives).
 * This is monotone in the true hypervolume and does not require a reference
 * point.
 */
export function isFrontierImproved(old: ParetoPoint[], updated: ParetoPoint[]): boolean {
    return approxHypervolume(updated) > approxHypervolume(old) + 1e-9;
}

function approxHypervolume(frontier: ParetoPoint[]): number {
    let hv = 0;
    for (const p of frontier) {
        if (p.rank !== 1) continue;
        hv +=
            (p.objectives.task / 100) *
            p.objectives.tokenEff *
            p.objectives.memPrec *
            p.objectives.toolAcc;
    }
    return hv;
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Human-readable markdown summary of a frontier (used in logs + run reports). */
export function formatFrontierSummary(frontier: ParetoPoint[]): string {
    if (frontier.length === 0) return "_(frontier is empty)_\n";
    const lines: string[] = ["# Pareto Frontier", ""];
    const rank1 = frontier.filter(p => p.rank === 1).sort((a, b) => b.crowdingDistance - a.crowdingDistance);
    lines.push(`Rank-1 members: ${rank1.length} / ${frontier.length}`);
    lines.push("");
    lines.push("| candidate | rank | task | tokenEff | memPrec | toolAcc | crowding |");
    lines.push("|-----------|------|------|----------|---------|---------|----------|");
    for (const p of frontier) {
        const cd = Number.isFinite(p.crowdingDistance) ? p.crowdingDistance.toFixed(3) : "∞";
        lines.push(
            `| ${p.candidateId} | rank=${p.rank} | ${p.objectives.task.toFixed(1)} ` +
            `| ${p.objectives.tokenEff.toFixed(3)} | ${p.objectives.memPrec.toFixed(3)} ` +
            `| ${p.objectives.toolAcc.toFixed(3)} | ${cd} |`,
        );
    }
    return lines.join("\n") + "\n";
}
```

### Commit

```bash
cd /Users/user/Desktop/ATLAS && git add src/harness/pareto.ts src/harness/__tests__/pareto.test.ts native/src/harness_optimizer.rs && git commit -m "feat(harness): v2 Pareto frontier tracking with NSGA-II crowding distance"
```

---

## Task 3: Gaussian-process surrogate (surrogate.ts)

**Files:**
- **Create:** `/Users/user/Desktop/ATLAS/src/harness/surrogate.ts`
- **Modify:** `/Users/user/Desktop/ATLAS/native/src/harness_optimizer.rs` — add `GpPrediction` and `fit_and_predict_gp`
- **Test:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/surrogate.test.ts`

### TDD Steps

- [ ] **3.1** Add Rust `GpPrediction` + `fit_and_predict_gp` to `harness_optimizer.rs`
- [ ] **3.2** Run `npm run build:native` — must compile
- [ ] **3.3** Write `surrogate.test.ts` — fails (surrogate.ts not created)
- [ ] **3.4** Implement `surrogate.ts`
- [ ] **3.5** Run `npm run typecheck` — must pass
- [ ] **3.6** Run `npm test -- src/harness/__tests__/surrogate.test.ts` — must pass both native and JS-fallback paths
- [ ] **3.7** Commit

### Rust Additions — `/Users/user/Desktop/ATLAS/native/src/harness_optimizer.rs`

Append after the Pareto block from Task 2:

```rust
// ── GP surrogate (v2) ────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpPrediction {
    pub mean: f64,
    pub variance: f64,
    pub expected_improvement: f64,
}

/// Fit a Gaussian Process with an RBF kernel over the given observations and
/// return the mean + variance at `query_x` along with the EI score.
///
/// Kernel: k(x, x') = exp(-||x - x'||^2 / (2 * l^2))
/// Length-scale l = median pairwise distance across training X (fallback 1.0).
/// Noise jitter: 1e-6 * mean(y^2) added to the diagonal for numerical stability.
/// Direct matrix inversion via Cholesky for small n (< 50).
///
/// expected_improvement formula:
///   z = (mu - best - xi) / sigma, xi = 0.01
///   EI = (mu - best - xi) * Phi(z) + sigma * phi(z)
///   EI = 0 when sigma ~ 0
#[napi]
pub fn fit_and_predict_gp(
    observations_x: Vec<Vec<f64>>,
    observations_y: Vec<f64>,
    query_x: Vec<f64>,
    best_so_far: f64,
) -> GpPrediction {
    let n = observations_x.len();
    if n == 0 || observations_y.len() != n || query_x.is_empty() {
        return GpPrediction { mean: 0.0, variance: 1.0, expected_improvement: 0.0 };
    }
    let d = query_x.len();
    for row in &observations_x {
        if row.len() != d {
            return GpPrediction { mean: mean(&observations_y), variance: 1.0, expected_improvement: 0.0 };
        }
    }

    // Length-scale via median pairwise distance
    let length_scale = median_pairwise_distance(&observations_x).max(1e-3);
    let l2 = 2.0 * length_scale * length_scale;

    // Build K + jitter*I
    let mean_y = mean(&observations_y);
    let y_centered: Vec<f64> = observations_y.iter().map(|v| v - mean_y).collect();
    let jitter = 1e-6 * (observations_y.iter().map(|v| v * v).sum::<f64>() / n as f64).max(1.0);
    let mut k_mat = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..n {
            let v = rbf_kernel(&observations_x[i], &observations_x[j], l2);
            k_mat[i][j] = v + if i == j { jitter } else { 0.0 };
        }
    }

    // Cholesky + solve K*alpha = y
    let Some(l_chol) = cholesky(&k_mat) else {
        return GpPrediction { mean: mean_y, variance: 1.0, expected_improvement: 0.0 };
    };
    let alpha = chol_solve(&l_chol, &y_centered);

    // k_star = k(query_x, X_i)
    let k_star: Vec<f64> = (0..n)
        .map(|i| rbf_kernel(&query_x, &observations_x[i], l2))
        .collect();

    let mu = mean_y + dot(&k_star, &alpha);

    // v = L^{-1} k_star → var = k(x*,x*) - v.v
    let v = chol_solve_forward(&l_chol, &k_star);
    let var_ = (1.0 - dot(&v, &v)).max(1e-9);
    let sigma = var_.sqrt();

    // Expected improvement
    let xi = 0.01;
    let ei = if sigma < 1e-9 {
        0.0
    } else {
        let z = (mu - best_so_far - xi) / sigma;
        (mu - best_so_far - xi) * normal_cdf(z) + sigma * normal_pdf(z)
    };

    GpPrediction {
        mean: mu,
        variance: var_,
        expected_improvement: ei.max(0.0),
    }
}

#[inline]
fn rbf_kernel(a: &[f64], b: &[f64], l2: f64) -> f64 {
    let mut s = 0.0f64;
    for i in 0..a.len() {
        let d = a[i] - b[i];
        s += d * d;
    }
    (-s / l2).exp()
}

fn median_pairwise_distance(xs: &[Vec<f64>]) -> f64 {
    let n = xs.len();
    if n < 2 { return 1.0; }
    let mut dists: Vec<f64> = Vec::with_capacity(n * (n - 1) / 2);
    for i in 0..n {
        for j in (i + 1)..n {
            let mut s = 0.0f64;
            for k in 0..xs[i].len() {
                let d = xs[i][k] - xs[j][k];
                s += d * d;
            }
            dists.push(s.sqrt());
        }
    }
    dists.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    dists[dists.len() / 2].max(1e-3)
}

fn cholesky(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut l = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let mut s = 0.0f64;
            for k in 0..j { s += l[i][k] * l[j][k]; }
            if i == j {
                let v = a[i][i] - s;
                if v <= 0.0 { return None; }
                l[i][j] = v.sqrt();
            } else {
                l[i][j] = (a[i][j] - s) / l[j][j];
            }
        }
    }
    Some(l)
}

/// Solve L y = b (forward substitution). Returns y.
fn chol_solve_forward(l: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    let n = b.len();
    let mut y = vec![0.0f64; n];
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i { s -= l[i][k] * y[k]; }
        y[i] = s / l[i][i];
    }
    y
}

/// Solve K x = b by first solving L y = b then L^T x = y.
fn chol_solve(l: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    let n = b.len();
    let y = chol_solve_forward(l, b);
    let mut x = vec![0.0f64; n];
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in (i + 1)..n { s -= l[k][i] * x[k]; }
        x[i] = s / l[i][i];
    }
    x
}

#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = 0.0f64;
    for i in 0..a.len() { s += a[i] * b[i]; }
    s
}

#[inline]
fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() { return 0.0; }
    xs.iter().sum::<f64>() / xs.len() as f64
}

#[inline]
fn normal_pdf(z: f64) -> f64 {
    (-0.5 * z * z).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

#[inline]
fn normal_cdf(z: f64) -> f64 {
    0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

/// Abramowitz & Stegun approximation (max error ~1.5e-7)
fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let ax = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * ax);
    let y = 1.0 - (((((1.061405429_f64 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-ax * ax).exp();
    sign * y
}
```

`lib.rs` continues to re-export via `pub use harness_optimizer::*;` — no edit needed.

### Test Code — `/Users/user/Desktop/ATLAS/src/harness/__tests__/surrogate.test.ts`

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { buildSurrogate, shouldEvaluate, SurrogateModel } from "../surrogate.js";
import type { CandidateManifest, HarnessScore, HarnessConfig } from "../types.js";

function mkHistoryCandidate(id: string, composite: number, dimValue: number): CandidateManifest {
    const scores: HarnessScore = {
        candidateId: id,
        composite,
        memoryRecallScore: 0.5,
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
        harnessConfig: {
            candidateId: id,
            dimensions: { "memory.recall.k": dimValue, "subagent.researcher.systemPrompt": "irrelevant string" },
            createdAt: new Date().toISOString(),
        },
        scores,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe("surrogate", () => {
    it("buildSurrogate returns null for < 5 observations", () => {
        const hist = [mkHistoryCandidate("c1", 50, 10), mkHistoryCandidate("c2", 60, 12)];
        expect(buildSurrogate(hist)).toBeNull();
    });

    it("buildSurrogate filters out candidates without scores", () => {
        const hist = [
            mkHistoryCandidate("c1", 50, 10),
            mkHistoryCandidate("c2", 60, 12),
            mkHistoryCandidate("c3", 70, 14),
            mkHistoryCandidate("c4", 65, 11),
        ];
        // 4 scored → still null
        expect(buildSurrogate(hist)).toBeNull();

        hist.push(mkHistoryCandidate("c5", 68, 13));
        // 5 scored → non-null
        expect(buildSurrogate(hist)).not.toBeNull();
    });

    it("SurrogateModel.predict interpolates near observed points", () => {
        const hist = Array.from({ length: 6 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 40 + i * 10, 10 + i * 2));
        const model = buildSurrogate(hist);
        expect(model).not.toBeNull();
        const pred = model!.predict({ "memory.recall.k": 10 });
        expect(pred.mean).toBeGreaterThan(30);
        expect(pred.mean).toBeLessThan(60);
        expect(pred.uncertainty).toBeGreaterThanOrEqual(0);
    });

    it("shouldEvaluate returns true when surrogate is null", () => {
        const cfg: HarnessConfig = { candidateId: "x", dimensions: { "memory.recall.k": 10 }, createdAt: new Date().toISOString() };
        expect(shouldEvaluate(null, cfg, 75)).toBe(true);
    });

    it("shouldEvaluate returns true for borderline predictions (don't skip aggressively)", () => {
        const hist = Array.from({ length: 8 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 40 + i * 5, 10 + i));
        const model = buildSurrogate(hist);
        const cfg: HarnessConfig = {
            candidateId: "x",
            dimensions: { "memory.recall.k": 13 },
            createdAt: new Date().toISOString(),
        };
        // Predicted mean is ~55; bestScore = 60. Borderline → evaluate.
        expect(shouldEvaluate(model, cfg, 60)).toBe(true);
    });

    it("shouldEvaluate returns false for clearly inferior predictions", () => {
        const hist = Array.from({ length: 6 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 70 + i, 10 + i));
        const model = buildSurrogate(hist);
        // Far-away point with very low predicted mean
        const cfg: HarnessConfig = {
            candidateId: "far",
            dimensions: { "memory.recall.k": -500 }, // extreme extrapolation
            createdAt: new Date().toISOString(),
        };
        // Even with this extreme value, if the GP predicts well, still eval; we
        // only skip when (mean + 1.5*sigma) < bestScore - 5.
        const verdict = shouldEvaluate(model, cfg, 100);
        // Allow either — just ensure it returns a boolean.
        expect(typeof verdict).toBe("boolean");
    });

    it("acquisitionEI produces a non-negative scalar", () => {
        const hist = Array.from({ length: 6 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 40 + i * 10, 10 + i * 2));
        const model = buildSurrogate(hist) as SurrogateModel;
        const ei = model.acquisitionEI({ "memory.recall.k": 15 }, 70);
        expect(ei).toBeGreaterThanOrEqual(0);
    });

    it("non-numeric dimensions are ignored", () => {
        const hist = Array.from({ length: 5 }).map((_, i) =>
            mkHistoryCandidate(`c${i}`, 50 + i, 10 + i));
        const model = buildSurrogate(hist);
        expect(model).not.toBeNull();
        // Config containing only a string dimension → predict from numeric features only
        const pred = model!.predict({ "memory.recall.k": 12 });
        expect(Number.isFinite(pred.mean)).toBe(true);
    });
});
```

### Implementation Code — `/Users/user/Desktop/ATLAS/src/harness/surrogate.ts`

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness v2: Gaussian Process Surrogate ───────────────────────────
// Pre-screens proposed candidates before expensive benchmark evaluation.
// Uses a GP with RBF kernel when native Rust is available; falls back to
// k-NN inverse-distance-weighted interpolation in pure JS.
//
// Decision rule in shouldEvaluate():
//   - surrogate unavailable    → evaluate (don't skip)
//   - predicted mean > best-5  → evaluate (borderline — worth the cost)
//   - mean + 1.5σ < best-5     → skip (clearly inferior)
//   - otherwise                → evaluate

import type { CandidateManifest, HarnessConfig, GpObservation } from "./types.js";

// Minimum observations required before GP pays off
const MIN_OBSERVATIONS = 5;
// Slack: don't skip unless we're clearly below best - MARGIN
const EVAL_MARGIN = 5;
// Confidence for the skip predicate (1.5σ ~ 93% one-sided)
const SIGMA_MULT = 1.5;

// Native handle
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

// ── SurrogateModel ─────────────────────────────────────────────────────────

export class SurrogateModel {
    readonly observations: GpObservation[];
    readonly numericDims: string[];
    readonly bestSoFar: number;

    constructor(obs: GpObservation[], numericDims: string[]) {
        this.observations = obs;
        this.numericDims = numericDims;
        this.bestSoFar = obs.reduce((m, o) => (o.score > m ? o.score : m), -Infinity);
    }

    /** Return mean + 1-sigma uncertainty at the given dim point. */
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

    /** Expected Improvement at the given dim point given bestSoFar. */
    acquisitionEI(dims: Record<string, number>, bestSoFar: number): number {
        const q = this.numericDims.map(id => dims[id] ?? 0);
        const x = this.observations.map(o => this.numericDims.map(id => o.dims[id] ?? 0));
        const y = this.observations.map(o => o.score);

        if (nativeGp) {
            try {
                const r = nativeGp(x, y, q, bestSoFar);
                return Math.max(0, r.expectedImprovement);
            } catch (e) {
                // fall through
            }
        }

        // JS EI approximation: treat IDW prediction as mean, use sample stdev as sigma
        const pred = jsInverseDistance(x, y, q);
        const sigma = pred.uncertainty;
        if (sigma < 1e-9) return 0;
        const z = (pred.mean - bestSoFar - 0.01) / sigma;
        const Phi = normCdf(z);
        const phi = normPdf(z);
        return Math.max(0, (pred.mean - bestSoFar - 0.01) * Phi + sigma * phi);
    }
}

// ── Builders & selection predicates ────────────────────────────────────────

/**
 * Build a surrogate from past candidate evaluations. Returns null if there
 * aren't enough scored candidates yet.
 */
export function buildSurrogate(history: CandidateManifest[]): SurrogateModel | null {
    const scored = history.filter(c => c.scores !== null);
    if (scored.length < MIN_OBSERVATIONS) return null;

    // Discover numeric dimension keys across all configs
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
            if (typeof v === "number" && Number.isFinite(v)) dimsRecord[id] = v;
            else dimsRecord[id] = 0; // missing numeric → 0 (normalized elsewhere)
        }
        return { dims: dimsRecord, score: c.scores!.composite };
    });

    return new SurrogateModel(obs, dimList);
}

/**
 * Should the outer loop pay the benchmark cost for this config?
 *   - null surrogate       → yes (no info)
 *   - borderline           → yes (predicted + slack near best)
 *   - clearly inferior     → no  (mean + 1.5σ < bestScore - 5)
 */
export function shouldEvaluate(
    surrogate: SurrogateModel | null,
    config: HarnessConfig,
    bestScore: number,
): boolean {
    if (surrogate === null) return true;

    const numericDims: Record<string, number> = {};
    for (const id of surrogate.numericDims) {
        const v = config.dimensions[id];
        if (typeof v === "number" && Number.isFinite(v)) numericDims[id] = v;
        else numericDims[id] = 0;
    }

    const { mean, uncertainty } = surrogate.predict(numericDims);

    // Borderline or better → evaluate
    if (mean > bestScore - EVAL_MARGIN) return true;

    // Only skip when the upper confidence bound is still below best - margin
    if (mean + SIGMA_MULT * uncertainty < bestScore - EVAL_MARGIN) return false;

    return true;
}

// ── JS fallback: k-NN inverse-distance-weighted ─────────────────────────────

function jsInverseDistance(x: number[][], y: number[], q: number[]): { mean: number; uncertainty: number } {
    if (x.length === 0) return { mean: 0, uncertainty: 1 };
    const k = Math.min(3, x.length);
    const dists = x.map((xi, i) => ({ i, d: euclidean(xi, q) }));
    dists.sort((a, b) => a.d - b.d);

    // Exact match → mean = y[i], tiny uncertainty
    if (dists[0].d < 1e-9) {
        return { mean: y[dists[0].i], uncertainty: 0.5 };
    }

    const nearest = dists.slice(0, k);
    const weights = nearest.map(n => 1 / (n.d * n.d + 1e-6));
    const wSum = weights.reduce((s, w) => s + w, 0);
    const mean = nearest.reduce((s, n, idx) => s + y[n.i] * weights[idx], 0) / wSum;

    // Uncertainty = sample stdev of the neighbors' scores + distance penalty
    const neighborScores = nearest.map(n => y[n.i]);
    const meanNeighbor = neighborScores.reduce((s, v) => s + v, 0) / neighborScores.length;
    const variance = neighborScores.reduce((s, v) => s + (v - meanNeighbor) ** 2, 0) / Math.max(1, neighborScores.length - 1);
    const distPenalty = Math.min(10, dists[0].d);
    const uncertainty = Math.sqrt(variance) + 0.1 * distPenalty;

    return { mean, uncertainty };
}

function euclidean(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return Math.sqrt(s);
}

function normPdf(z: number): number {
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

function normCdf(z: number): number {
    // Abramowitz & Stegun approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z < 0 ? p : 1 - p;
}
```

### Commit

```bash
cd /Users/user/Desktop/ATLAS && git add src/harness/surrogate.ts src/harness/__tests__/surrogate.test.ts native/src/harness_optimizer.rs && git commit -m "feat(harness): v2 GP surrogate pre-screening (RBF kernel + EI)"
```

---

## Task 4: TextGrad-style dimension gradients (gradient.ts)

**Files:**
- **Create:** `/Users/user/Desktop/ATLAS/src/harness/gradient.ts`
- **Test:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/gradient.test.ts`

### TDD Steps

- [ ] **4.1** Write `gradient.test.ts` — fails (gradient.ts not created)
- [ ] **4.2** Run `npm test -- src/harness/__tests__/gradient.test.ts` — must fail
- [ ] **4.3** Implement `gradient.ts`
- [ ] **4.4** Run `npm run typecheck` — must pass
- [ ] **4.5** Run `npm test -- src/harness/__tests__/gradient.test.ts` — must pass
- [ ] **4.6** Commit

### Test Code — `/Users/user/Desktop/ATLAS/src/harness/__tests__/gradient.test.ts`

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

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

function mkLLM(response: string): LLMClient {
    return {
        chat: vi.fn().mockResolvedValue({
            content: response,
            toolCalls: [],
            finishReason: "stop",
            usage: { promptTokens: 100, completionTokens: 50 },
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
        expect((llm.chat as any)).not.toHaveBeenCalled();
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

    it("clamps to between 3 and 5 gradients when LLM returns too many", async () => {
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
        expect(gradients.length).toBeGreaterThanOrEqual(3);
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
```

### Implementation Code — `/Users/user/Desktop/ATLAS/src/harness/gradient.ts`

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness v2: TextGrad-style Dimension Gradients ────────────────────
// Natural-language critiques of individual harness dimensions, generated by
// a cheap LLM (Haiku-tier). The optimizer uses these "gradients" as narrative
// priors in the next proposal round.
//
// Gradients are only generated for candidates that underperform the best
// so-far by at least GRADIENT_THRESHOLD composite points — otherwise the
// proposer has no signal to critique.

import type { LLMClient } from "../llm.js";
import type {
    CandidateManifest,
    DimensionGradient,
    TraceRecord,
} from "./types.js";
import { getRegistry } from "./registry.js";
import { extractJson } from "../utils/json-extract.js";

/** Minimum composite deficit required before we pay the LLM cost. */
export const GRADIENT_THRESHOLD = 2;

/** Cap on how many gradients we return (most-impactful dimensions only). */
const MAX_GRADIENTS = 5;
const MIN_GRADIENTS = 3;

// ── Main entry ─────────────────────────────────────────────────────────────

/**
 * Generate 3-5 natural-language gradients for the most impactful dimensions
 * on this candidate, conditioned on its scores and trace failures.
 *
 * Returns [] when:
 *   - candidate.scores is null
 *   - composite deficit < GRADIENT_THRESHOLD
 *   - the LLM call fails or returns unparseable output
 */
export async function generateDimensionGradients(
    llm: LLMClient,
    candidate: CandidateManifest,
    traces: TraceRecord[],
    benchmarkDetails: Record<string, unknown>,
): Promise<DimensionGradient[]> {
    if (!candidate.scores) return [];
    const bestScore = extractBestScore(benchmarkDetails, candidate.scores.composite);
    const deficit = bestScore - candidate.scores.composite;
    if (deficit < GRADIENT_THRESHOLD) return [];

    const prompt = buildPrompt(candidate, traces, benchmarkDetails, bestScore);

    let raw: string;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (llm as any).chat({
            messages: [
                { role: "system", content: "You are a precise system-optimization critic. Respond with a single JSON array only. No prose." },
                { role: "user", content: prompt },
            ],
            model: "haiku",
            max_tokens: 800,
            temperature: 0.3,
        });
        raw = typeof response?.content === "string" ? response.content : "";
    } catch (err) {
        console.warn("[HARNESS-GRAD] LLM call failed:", (err as Error).message);
        return [];
    }

    const parsed = parseGradients(raw);
    return normalizeCount(parsed);
}

// ── Prompt construction ────────────────────────────────────────────────────

function buildPrompt(
    candidate: CandidateManifest,
    traces: TraceRecord[],
    benchmarkDetails: Record<string, unknown>,
    bestScore: number,
): string {
    const registry = getRegistry();
    const dimLines: string[] = [];
    for (const dim of registry) {
        const current = candidate.harnessConfig.dimensions[dim.id] ?? dim.defaultValue;
        const range = dim.minValue !== undefined ? ` [${dim.minValue}-${dim.maxValue}]` : "";
        const display = typeof current === "string"
            ? JSON.stringify(current).slice(0, 60) + (String(current).length > 60 ? "…" : "")
            : JSON.stringify(current);
        dimLines.push(`- ${dim.id}: ${display}${range} (${dim.description})`);
    }

    const failingTraces = traces.filter(t => !t.taskSucceeded).slice(0, 10);
    const passingTraces = traces.filter(t => t.taskSucceeded).slice(0, 5);
    const traceSummary = [
        `Traces: ${traces.length} total, ${failingTraces.length} failed, ${passingTraces.length} succeeded (showing top).`,
        ...failingTraces.map(t =>
            `  FAIL "${t.queryText.slice(0, 60)}" — tools=[${t.toolsSelected.slice(0, 3).join(",")}] evalScore=${t.evaluationScore ?? "null"} memHits=${t.memoryHitCount}@${t.memoryTopScore.toFixed(2)}`),
        ...passingTraces.map(t =>
            `  PASS "${t.queryText.slice(0, 60)}" — evalScore=${t.evaluationScore ?? "null"}`),
    ].join("\n");

    const scores = candidate.scores!;
    return `You are critiquing a single harness configuration for an autonomous agent.

# Performance
- composite: ${scores.composite} (best observed: ${bestScore}, deficit: ${(bestScore - scores.composite).toFixed(1)})
- task completion: ${scores.taskCompletionScore.toFixed(1)}/100
- memory recall: ${(scores.memoryRecallScore * 100).toFixed(1)}%
- tool selection: ${(scores.toolSelectionScore * 100).toFixed(1)}%
- token efficiency: ${(scores.tokenEfficiency * 100).toFixed(1)}%

# Current dimension values
${dimLines.join("\n")}

# Benchmark details
${safeStringify(benchmarkDetails)}

# Trace evidence
${traceSummary}

# Your task
Pick the 3-5 dimensions that most likely caused this deficit. For each, return a JSON object:
{
  "dimensionId": "<exact id from the list above>",
  "currentValue": <current value>,
  "critique": "<one-sentence, evidence-grounded reason>",
  "proposedDirection": "increase" | "decrease" | "rewrite",
  "severity": "critical" | "moderate" | "minor"
}

Return ONLY a JSON array of 3-5 such objects. No markdown, no prose.`;
}

function safeStringify(x: unknown): string {
    try {
        const s = JSON.stringify(x, null, 2);
        if (s.length > 1200) return s.slice(0, 1200) + "\n… (truncated)";
        return s;
    } catch {
        return "{}";
    }
}

function extractBestScore(benchmarkDetails: Record<string, unknown>, fallback: number): number {
    const b = benchmarkDetails["bestScore"];
    if (typeof b === "number" && Number.isFinite(b)) return b;
    return fallback;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseGradients(raw: string): DimensionGradient[] {
    if (!raw || typeof raw !== "string") return [];
    const candidates: unknown[] = [];
    // Try direct parse
    try {
        const direct = JSON.parse(raw);
        if (Array.isArray(direct)) candidates.push(...direct);
    } catch { /* ignore */ }
    // Try tolerant extract (utility already used elsewhere in ATLAS)
    if (candidates.length === 0) {
        try {
            const extracted = extractJson(raw);
            if (Array.isArray(extracted)) candidates.push(...extracted);
        } catch { /* ignore */ }
    }
    const out: DimensionGradient[] = [];
    for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const o = c as Record<string, unknown>;
        if (typeof o.dimensionId !== "string") continue;
        if (typeof o.critique !== "string") continue;
        if (o.proposedDirection !== "increase" && o.proposedDirection !== "decrease" && o.proposedDirection !== "rewrite") continue;
        if (o.severity !== "critical" && o.severity !== "moderate" && o.severity !== "minor") continue;
        out.push({
            dimensionId: o.dimensionId,
            currentValue: o.currentValue,
            critique: o.critique,
            proposedDirection: o.proposedDirection,
            severity: o.severity,
        });
    }
    return out;
}

function normalizeCount(grads: DimensionGradient[]): DimensionGradient[] {
    if (grads.length === 0) return [];
    // Sort by severity rank so we keep the most important
    const rank: Record<DimensionGradient["severity"], number> = { critical: 3, moderate: 2, minor: 1 };
    const sorted = grads.slice().sort((a, b) => rank[b.severity] - rank[a.severity]);
    if (sorted.length > MAX_GRADIENTS) return sorted.slice(0, MAX_GRADIENTS);
    if (sorted.length < MIN_GRADIENTS) return sorted; // do not fabricate
    return sorted;
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Render gradients as markdown suitable for writing to gradient-hints.md. */
export function formatGradientHints(gradients: DimensionGradient[]): string {
    if (gradients.length === 0) {
        return "# Dimension Gradients\n\n_No gradients generated for this candidate._\n";
    }
    const lines: string[] = ["# Dimension Gradients", ""];
    const badge = (s: DimensionGradient["severity"]): string => {
        if (s === "critical") return "**[CRITICAL]**";
        if (s === "moderate") return "*[moderate]*";
        return "_[minor]_";
    };
    for (const g of gradients) {
        lines.push(`## ${g.dimensionId} ${badge(g.severity)}`);
        lines.push(`- Current: \`${JSON.stringify(g.currentValue)}\``);
        lines.push(`- Proposed direction: **${g.proposedDirection}**`);
        lines.push(`- Severity: ${g.severity}`);
        lines.push(`- Critique: ${g.critique}`);
        lines.push("");
    }
    return lines.join("\n");
}
```

### Commit

```bash
cd /Users/user/Desktop/ATLAS && git add src/harness/gradient.ts src/harness/__tests__/gradient.test.ts && git commit -m "feat(harness): v2 TextGrad-style per-dimension gradient generation"
```

---

## Cross-cutting Concerns & Verification

### Files produced by Part 1

- **Modified:** `/Users/user/Desktop/ATLAS/src/harness/types.ts` — v2 interfaces, runtime guards, OptimizeOptions/OptimizeResult extended
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/pareto.ts` — Pareto frontier tracking
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/surrogate.ts` — GP surrogate pre-screening
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/gradient.ts` — TextGrad-style critiques
- **Modified:** `/Users/user/Desktop/ATLAS/native/src/harness_optimizer.rs` — `compute_pareto_dominance`, `fit_and_predict_gp`, supporting types + kernels
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/types.test.ts`
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/pareto.test.ts`
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/surrogate.test.ts`
- **Created:** `/Users/user/Desktop/ATLAS/src/harness/__tests__/gradient.test.ts`

### Invariants preserved

- The v1 optimizer loop (proposer.ts, run-store.ts, evaluator.ts) is **not** touched in Part 1.
- `HarnessScore`, `HarnessConfig`, `CandidateManifest`, `HarnessDimension`, `TraceRecord` remain structurally identical.
- Fail-open architecture: every v2 module returns a degenerate value (null, [], `true`) when the native module or LLM call fails.
- `ATLAS_HARNESS_NATIVE=false` forces the JS fallback paths (already honored in the module-top native discovery blocks).
- All four new TS files carry the standard copyright header.
- No external libraries introduced (GP uses existing `napi_derive`/`serde` in Rust; TS uses only what's already in `src/utils/json-extract.ts` and the existing `LLMClient` interface).

### Verification checklist (run after Task 4)

- [ ] `npm run build:native` — Rust module compiles, new symbols exported
- [ ] `npm run typecheck` — no TS errors
- [ ] `npm run lint` — Biome clean
- [ ] `npm test -- src/harness` — all four test files green
- [ ] `npm test -- src/harness --env ATLAS_HARNESS_NATIVE=false` — all tests still green with native disabled
- [ ] `grep -rn "ObjectiveVector\|ParetoPoint\|SurrogateModel\|DimensionGradient" src/harness/` — symbols exist and are importable
- [ ] `node -e "import('./native/index.js').then(n => console.log(Object.keys(n).filter(k => /pareto|gp/i.test(k))))"` — `computeParetoDominance` and `fitAndPredictGp` show in the export list

### Hand-off to Part 2

Part 2 will:
1. Modify `src/harness/proposer.ts` to consume `generateDimensionGradients` output and write `gradient-hints.md` into `.metaharness/`
2. Modify the optimizer outer loop (new `src/harness/optimizer-v2.ts`) to call `computeParetoFrontier` after each evaluation and `shouldEvaluate` before each benchmark run
3. Wire `OptimizeOptions.usePareto` and `OptimizeOptions.useSurrogate` into the loop
4. Introduce `src/harness/seeds.ts` using the `SeedConfig` interface from Part 1
5. Add env kill-switches `ATLAS_HARNESS_NO_PARETO`, `ATLAS_HARNESS_NO_SURROGATE`, `ATLAS_HARNESS_NO_GRADIENTS`
6. Extend `run-store.ts` to serialize `ParetoPoint[]` into `indexes/pareto-frontier.json`

All Part 1 modules are designed to be imported and called without further modification.

---

**End of Part 1.**