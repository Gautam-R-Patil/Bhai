// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Shared Types ─────────────────────────────────────────────
// Mirrors the domain model from the Meta-Harness paper (arxiv 2603.28052),
// adapted for ATLAS's TypeScript architecture. The core idea: treat ATLAS
// configuration surfaces as "harness dimensions" that can be proposed,
// evaluated, and evolved automatically by the optimization outer loop.

export interface HarnessDimension<T = unknown> {
    id: string;           // e.g. "memory.fusion.relevanceWeight"
    description: string;
    currentValue: T;
    defaultValue: T;
    minValue?: number;
    maxValue?: number;
    options?: T[];        // for enum-type dimensions
    filePath: string;     // source file this maps to
    lineRef: string;      // e.g. "sqlite.ts:1421"
    get(): T;
    set(value: T): void;
}

export interface HarnessConfig {
    candidateId: string;
    dimensions: Record<string, unknown>;  // dimension.id → value
    createdAt: string;
}

// Per-agent-invocation telemetry captured by trace-store.ts
export interface TraceRecord {
    traceId: string;
    sessionId: string;
    iterationNumber: number;
    queryText: string;
    toolsSelected: string[];
    contextSourcesIncluded: string[];
    memoryHitCount: number;
    memoryTopScore: number;
    evaluationScore: number | null;
    taskSucceeded: boolean;
    durationMs: number;
    timestamp: string;
}

// Output of one benchmark run against a candidate harness config
export interface HarnessScore {
    candidateId: string;
    composite: number;              // weighted aggregate 0-100
    memoryRecallScore: number;      // 0-1
    toolSelectionScore: number;     // 0-1
    taskCompletionScore: number;    // 0-100
    researchQualityScore: number;   // 0-1
    tokenEfficiency: number;        // composite/tokensUsed ratio, normalized 0-1
    tokensUsed: number;
    timestamp: string;
}

// Per-candidate record mirroring CandidateRecord from the OSS implementation
export interface CandidateManifest {
    candidateId: string;
    parentCandidateId: string | null;
    objective: number | null;       // primary optimization metric (= composite score)
    valid: boolean;
    outcome: 'baseline' | 'keep' | 'discard' | 'crash' | 'timeout' | 'no-change';
    outcomeSummary: string;
    harnessConfig: HarnessConfig;
    scores: HarnessScore | null;
    createdAt: string;
    updatedAt: string;
}

// Result returned by the optimizer outer loop
export interface OptimizeResult {
    runId: string;
    runDir: string;
    bestCandidateId: string;
    bestObjective: number;
    candidateIds: string[];
    iterationsRun: number;
    durationMs: number;
    paretoFrontier: ParetoPoint[];  // v2: multi-objective frontier (empty if not enabled)
}

// Options for the outer optimization loop
export interface OptimizeOptions {
    budget: number;
    fastMode: boolean;
    searchMode: 'hill-climb' | 'frontier';
    proposalBatchSize: number;
    objective: string;
    usePareto: boolean;      // v2: track + emit Pareto frontier
    useSurrogate: boolean;   // v2: screen candidates with GP surrogate before evaluating
}

// ── Meta-Harness v2 additions ───────────────────────────────────────────────

export interface ObjectiveVector {
    task: number;      // 0-100 (taskCompletionScore)
    tokenEff: number;  // 0-1   (tokenEfficiency)
    memPrec: number;   // 0-1   (memoryRecallScore)
    toolAcc: number;   // 0-1   (toolSelectionScore)
}

export const DEFAULT_OBJECTIVE_VECTOR: ObjectiveVector = {
    task: 0,
    tokenEff: 0,
    memPrec: 0,
    toolAcc: 0,
};

export interface ParetoPoint {
    candidateId: string;
    objectives: ObjectiveVector;
    dominatedBy: string[];
    dominates: string[];
    rank: number;
    crowdingDistance: number;
}

export interface SeedConfig {
    id: string;
    description: string;
    dimensions: Partial<Record<string, unknown>>;
}

export interface DimensionGradient {
    dimensionId: string;
    currentValue: unknown;
    critique: string;
    proposedDirection: "increase" | "decrease" | "rewrite";
    severity: "critical" | "moderate" | "minor";
}

export interface GpObservation {
    dims: Record<string, number>;
    score: number;
}

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
