# Meta-Harness v2 Design

**Date:** 2026-04-25  
**Status:** Approved  
**Context:** Upgrade the ATLAS Meta-Harness system from config-dimension-only optimization to full paper fidelity: code-level search with real filesystem agent, Pareto frontier tracking, population initialization, TextGrad gradients per dimension, and Bayesian surrogate.

---

## Why This Upgrade

The current implementation (v1) has one critical flaw that the actual Meta-Harness ablation study quantifies:

| Proposer information | Median accuracy |
|---|---|
| Scores only | 34.6 |
| Scores + Summary | 34.9 (barely better) |
| **Full raw traces (filesystem)** | **50.0 (+15 points)** |

Our v1 proposer sends a JSON summary string — the "Scores + Summary" condition. The paper shows this is nearly worthless compared to giving the proposer actual filesystem access to grep/cat individual trace files. Fixing this single architectural decision is the highest-leverage change.

The second major gap is search space: v1 only tunes 30 numeric/string config dimensions. The paper's search is over actual *code* — the proposer can rewrite retrieval logic, context assembly, prompt construction. This is what produces the structural discoveries (four-route BM25, Label-Primed Query, draft-verification) that beat hand-designed baselines.

---

## Architecture Overview

### v2 Changes (additive on top of v1)

1. **`src/harness/code-proposer.ts`** — new agent-based proposer that runs ATLAS's own `runAgent()` in a sandboxed git worktree, with access to read/grep/edit tool calls against the harness filesystem
2. **`src/harness/pareto.ts`** — Pareto frontier tracker (Accuracy × TokenEfficiency × MemoryRecall)  
3. **`src/harness/surrogate.ts`** — Gaussian process surrogate over numeric dimensions, Rust-accelerated
4. **`src/harness/gradient.ts`** — TextGrad-style per-dimension natural-language gradients  
5. **`src/harness/population.ts`** — multi-seed population initialization
6. **Rust: `native/src/harness_optimizer.rs` extensions** — Gaussian process regression, Pareto dominance computation, population diversity scoring
7. **`optimizer.ts` updated** — integrates all new modules, code-level search loop

---

## 1. Code-Level Search with Filesystem Agent

### The Core Change

Replace the current proposer (which builds a JSON context string and calls `llm.chat()`) with an agent that:
- Runs in an isolated git worktree (`agent-worktrees/<candidate-id>/`)
- Has access to the full `data/harness/runs/<run_id>/` filesystem
- Can use standard ATLAS tools: `read_file`, `shell_exec` (grep/cat), `edit_file`
- Can modify files in `src/harness/` (with write-scope restriction to `src/harness/` only)
- Must write its final config to `proposed-config.json` AND optionally write code changes to `src/harness/` files

### What the Agent Can Modify (Write Scope)

The paper allows proposer to modify "full harness implementations." For ATLAS, the allowed write scope is:

```
src/harness/registry.ts         — change dimension defaults, add dimensions
src/harness/proposed-changes/   — sandbox for proposed code changes (NEW)
proposed-config.json            — the config diff (always required)
```

The `src/harness/proposed-changes/` directory contains:
- `memory-retrieval-patch.ts` — proposed changes to recall() logic
- `tool-router-patch.ts` — proposed changes to tool selection
- `context-assembly-patch.ts` — proposed changes to context injection
- `evaluator-patch.ts` — proposed changes to evaluation rubric

These are **patches**, not full file replacements. The optimizer applies them via a patch mechanism that the Rust module validates for safety (no imports outside src/, no shell exec, no network calls).

### Filesystem Layout for Agent

The agent sees:

```
data/harness/runs/<run_id>/
├── candidates/
│   ├── c0000/
│   │   ├── harness-config.json      ← numeric/string dimensions
│   │   ├── scores.json
│   │   ├── traces/
│   │   │   ├── <timestamp>_<id>.json  ← raw TraceRecord per invocation
│   │   │   └── <timestamp>_<id>.json
│   │   ├── code-changes/            ← NEW: any code patches this candidate applied
│   │   │   └── memory-retrieval-patch.ts
│   │   └── .metaharness/
│   │       ├── AGENTS.md
│   │       ├── registry-dimensions.md
│   │       └── experience/parent/
│   └── c0001/
│       └── ...
```

The agent is told: "Read trace files individually using cat or grep. Do not rely on summaries. Look for patterns in failures across multiple trace files."

### Safety Constraints

The `AGENTS.md` instructions enumerate:
- **Allowed**: read any file under `data/harness/`, edit `proposed-config.json`, write to `src/harness/proposed-changes/`
- **Forbidden**: modify files outside write scope, network calls, shell exec beyond read-only (grep/cat/ls/find), imports from outside `src/harness/`

The Rust safety validator scans proposed patches for violations before applying.

---

## 2. Pareto Frontier (GEPA-style)

### Why Pareto

A single composite score hides important trade-offs. The paper uses Pareto dominance across accuracy and context cost. For ATLAS, the relevant objectives are:

- **TaskQuality** — composite evaluation score (higher is better)
- **TokenEfficiency** — composite/tokensUsed ratio (higher is better)  
- **MemoryPrecision** — memory recall benchmark score (higher is better)
- **ToolAccuracy** — tool selection benchmark score (higher is better)

A candidate dominates another if it is ≥ on all dimensions and strictly better on at least one.

### `src/harness/pareto.ts`

```typescript
export interface ParetoPoint {
  candidateId: string;
  objectives: { task: number; tokenEff: number; memPrec: number; toolAcc: number };
  dominatedBy: string[];
  dominates: string[];
  rank: number;        // 1 = Pareto optimal
  crowdingDistance: number;  // for selection diversity
}

export function computeParetoFrontier(candidates: CandidateManifest[]): ParetoPoint[]
export function selectFromFrontier(frontier: ParetoPoint[], preferenceWeights?: Record<string, number>): CandidateManifest
export function isFrontierImproved(oldFrontier: ParetoPoint[], newFrontier: ParetoPoint[]): boolean
```

The optimizer selects the parent for the next iteration using NSGA-II-style crowding distance: from the Pareto frontier, pick the candidate with the highest crowding distance (most isolated from neighbors) to maximize diversity.

The final output reports the full Pareto frontier, not just a single best.

### Rust acceleration

`harness_optimizer.rs` gains:
- `compute_pareto_dominance(points: Vec<ObjectiveVector>) -> Vec<ParetoRank>` — O(n²) with early termination
- `compute_crowding_distance(frontier: Vec<ObjectiveVector>) -> Vec<f64>` — NSGA-II crowding distance

---

## 3. Bayesian Surrogate (MIPROv2-style)

### When It Activates

After 5+ evaluated candidates exist, the surrogate activates. Before evaluating a proposed candidate, the surrogate predicts its composite score. If the prediction is below `best.objective - sigma * 1.5` (clearly worse), the candidate is skipped without running expensive benchmarks.

This is "cheap pre-screening": run the full benchmark only on candidates that look promising.

### `src/harness/surrogate.ts`

The surrogate operates over the **numeric dimensions only** (17 of the 30 dimensions). It fits a lightweight Gaussian process with RBF kernel to the existing (config → composite_score) observations.

```typescript
export interface SurrogateModel {
  fit(observations: Array<{ dims: Record<string, number>; score: number }>): void
  predict(dims: Record<string, number>): { mean: number; uncertainty: number }
  acquisitionEI(dims: Record<string, number>, bestSoFar: number): number  // Expected Improvement
}

export function buildSurrogate(history: CandidateManifest[]): SurrogateModel | null  // null if < 5 points
export function shouldEvaluate(surrogate: SurrogateModel | null, config: HarnessConfig, best: number): boolean
```

### Rust acceleration

`harness_optimizer.rs` gains:
- `fit_gp_surrogate(x: Vec<Vec<f64>>, y: Vec<f64>) -> GpModel` — RBF kernel GP fit
- `predict_gp(model: GpModel, x_star: Vec<f64>) -> (mean: f64, variance: f64)` — GP prediction
- `expected_improvement(mean: f64, variance: f64, best: f64) -> f64`

---

## 4. TextGrad Per-Dimension Gradients

### What This Adds

Instead of the proposer proposing a whole new config from scratch, it can be primed with natural-language gradients per failing dimension. This mirrors TextGrad's "text backpropagation."

### `src/harness/gradient.ts`

After each benchmark run, if `scores.composite < best.objective - 2`, generate gradients:

```typescript
export interface DimensionGradient {
  dimensionId: string;
  currentValue: unknown;
  critique: string;         // "This threshold is too conservative because..."
  proposedDirection: string; // "increase" | "decrease" | "rewrite"
  severity: "critical" | "moderate" | "minor";
}

export async function generateDimensionGradients(
  llm: LLMClient,
  candidate: CandidateManifest,
  traces: TraceRecord[],
  benchmarkDetails: Record<string, unknown>,
): Promise<DimensionGradient[]>
```

These gradients are injected into the next proposer's `.metaharness/AGENTS.md` as a "gradient hints" section. The proposer can choose to follow or ignore them.

### Integration

In `optimizer.ts`, after an iteration that doesn't improve:
1. Generate gradients for the failing candidate
2. Write them to `candidates/<next-id>/.metaharness/gradient-hints.md`
3. The agent reads this file along with everything else

---

## 5. Population Initialization

### What Changes

Currently: one baseline `c0000` initialized from current registry defaults.

New: initialize `k` baseline candidates from distinct seeds, evaluate all before the first proposal iteration.

### Seeds for ATLAS

| Seed | Description | Rationale |
|---|---|---|
| `baseline-defaults` | Current hardcoded defaults | The reference point |
| `memory-aggressive` | Higher k-values, lower fusion weights skewed to recency | Good for long conversations |
| `tool-conservative` | Lower `maxToolsTotal`, higher confidence threshold | Reduces token waste |
| `evaluator-strict` | ACCEPT_THRESHOLD=80, more retries | Prioritizes quality over speed |

These 4 seeds are hardcoded in `src/harness/population.ts`. All 4 are evaluated before the first proposal step. The Pareto frontier is initialized from whichever seeds survive Pareto dominance.

### `src/harness/population.ts`

```typescript
export interface SeedConfig {
  id: string;
  description: string;
  dimensions: Partial<Record<string, unknown>>;
}

export const ATLAS_SEED_CONFIGS: SeedConfig[]
export function initializePopulation(store: HarnessRunStore, llm: LLMClient, fastMode: boolean): Promise<CandidateManifest[]>
```

---

## Data Flow (v2 Optimization Loop)

```
initializePopulation()     → evaluate 4 seeds → Pareto frontier (4 candidates)
                                                        ↓
for iter in budget:
  parent = selectFromFrontier(paretoFrontier)           ← crowding-distance selection
  candidate = store.materializeCandidate(parent)
  store.writeInstructionBundle(candidate, ...)          ← writes raw trace files, not summary
  
  gradients = generateDimensionGradients(...)           ← TextGrad hints for failing dims
  store.writeGradientHints(candidate, gradients)
  
  proposed_config = codeProposer.propose(candidate)     ← ATLAS runAgent() in worktree
    └── agent reads individual trace files via tool calls
    └── agent optionally writes src/harness/proposed-changes/
    └── agent writes proposed-config.json
  
  if (surrogate.shouldEvaluate(proposed_config)):       ← skip if clearly worse
    scores = evaluateCandidate(proposed_config)
    paretoFrontier = updateParetoFrontier(scores)
  else:
    mark candidate as surrogate-skip
    
  store.writeManifest(candidate)

return paretoFrontier  ← not just single best
```

---

## Files to Create/Modify

### New files
| File | Purpose |
|---|---|
| `src/harness/code-proposer.ts` | Agent-based proposer using runAgent() in worktree |
| `src/harness/pareto.ts` | Pareto frontier tracking and NSGA-II selection |
| `src/harness/surrogate.ts` | Gaussian process surrogate for pre-screening |
| `src/harness/gradient.ts` | TextGrad-style per-dimension gradients |
| `src/harness/population.ts` | Multi-seed population initialization |
| `src/harness/patch-validator.ts` | Rust-backed safety validation for proposed code patches |

### Modified files
| File | Change |
|---|---|
| `src/harness/run-store.ts` | Write raw trace files (not summary), add gradient hints, add code-changes dir |
| `src/harness/optimizer.ts` | New loop integrating population, Pareto, surrogate, gradients, code proposer |
| `src/harness/trace-store.ts` | Write richer trace files with full tool call logs, error details |
| `src/harness/evaluator.ts` | Return per-dimension scores for Pareto computation |
| `src/harness/types.ts` | Add ParetoPoint, SeedConfig, DimensionGradient, GpModel interfaces |
| `native/src/harness_optimizer.rs` | Add GP regression, Pareto dominance, crowding distance |

---

## Key Implementation Decisions

**Why worktrees for the code proposer?** ATLAS already has `agent-worktree.ts` infrastructure. Running the proposer agent in a worktree isolates its file edits from the live codebase until we decide to apply them.

**Why raw trace files in the filesystem, not a rich API?** The paper's key result: the agent uses `grep/cat` against 82 files per iteration. The richness comes from the agent deciding what to look at, not from us deciding what to summarize. Avoid the temptation to help.

**Why NSGA-II crowding distance for parent selection?** Prevents the frontier from collapsing to a single point. When two candidates are both Pareto-optimal, prefer the one that's most isolated (fills a gap in the trade-off space).

**Why GP surrogate over neural network?** GPs provide calibrated uncertainty estimates (needed for Expected Improvement). With only 5-40 observations, GPs generalize better than neural networks. RBF kernel is sufficient for smooth config spaces.

**Why TextGrad gradients as hints, not hard constraints?** The paper's proposer is free to ignore or override any guidance. Gradients are advisory: written to a file the agent can read, but the agent decides whether to follow them. This matches the paper's "minimal outer-loop structure" philosophy.

---

## Verification

1. `npm run typecheck` — no errors
2. `npm test` — all 518 tests pass  
3. Population init test: `npx ts-node src/harness/population.ts --dry-run` → prints 4 seed configs, no evaluation
4. Pareto test: create 5 mock candidates with known objectives → verify Pareto frontier = correct subset
5. Surrogate test: fit GP on 5 points → verify predictions are reasonable and EI increases near optima
6. Integration test: run `optimize-harness --budget 2 --fast` → observe agent using `read_file` and `grep` against trace files in the logs
7. Filesystem check: after iteration 1, verify `data/harness/runs/<id>/candidates/c0001/traces/` contains individual .json trace files, not a summary

---

## Expected Improvements Over v1

Based on the paper's ablation results, moving from summary-based to raw-trace-based proposer is the primary driver. Secondary improvements compound:

| Change | Expected lift | Basis |
|---|---|---|
| Raw trace filesystem access | +~15 pts median accuracy | Paper Table 3 ablation |
| Code-level search (not just dimensions) | Structural discoveries | Paper's discovered harnesses |
| Pareto frontier | Prevents local optima | GEPA paper |
| Population initialization | Faster convergence | MIPROv2 bootstrapping |
| Bayesian surrogate | 3-5x evaluation cost reduction | MIPROv2 paper |
| TextGrad gradients | Targeted proposals | TextGrad / ProTeGi |
