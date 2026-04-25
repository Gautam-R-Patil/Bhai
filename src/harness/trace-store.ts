// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Execution Trace Store ───────────────────────────────────
// Thin, non-blocking middleware that captures per-invocation telemetry from
// the agent loop, memory retrieval, and evaluator. Traces are flushed to the
// active harness candidate's traces/ directory so the proposer agent can read
// full execution history and reason causally about failures.

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { TraceRecord } from "./types.js";

// Native Rust acceleration for trace aggregation (napi-rs generates camelCase)
let nativeAggregateTraces: ((traces: Array<{
    taskSucceeded: boolean;
    evaluationScore?: number;       // napi-rs Option<f64> → number | undefined
    memoryHitCount: number;
    memoryTopScore: number;
    durationMs: number;
    toolsSelectedCount: number;
}>) => {
    count: number; successRate: number; avgEvalScore: number;
    avgMemoryHits: number; avgDurationMs: number; p50EvalScore: number; p10EvalScore: number;
}) | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const native = await import("../../native/index.js").catch(() => null) as any;
    if (native?.aggregateTraces) nativeAggregateTraces = native.aggregateTraces;
} catch { /* fall back to JS */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLAS_DATA_DIR = process.env.ATLAS_DATA_DIR || join(__dirname, "../../data");

// ── In-memory trace buffer ──────────────────────────────────────────────────

interface LiveTrace {
    traceId: string;
    sessionId: string;
    startMs: number;
    queryText: string;
    iterationNumber: number;
    toolsSelected: string[];
    contextSourcesIncluded: string[];
    memoryHitCount: number;
    memoryTopScore: number;
    evaluationScore: number | null;
}

const _liveTraces = new Map<string, LiveTrace>();
const _completedTraces: TraceRecord[] = [];
const MAX_COMPLETED_BUFFER = 200;

// Current active harness run dir — set by the optimizer when a run starts
let _activeRunDir: string | null = null;
let _activeCandidateId: string | null = null;

// ── Public control API ──────────────────────────────────────────────────────

/** Called by the optimizer to tell the trace store which candidate is active. */
export function setActiveCandidate(runDir: string, candidateId: string): void {
    _activeRunDir = runDir;
    _activeCandidateId = candidateId;
}

export function clearActiveCandidate(): void {
    _activeRunDir = null;
    _activeCandidateId = null;
}

// ── Per-invocation trace lifecycle ─────────────────────────────────────────

/** Start a trace for an agent invocation. Returns a traceId to pass to other record* calls. */
export function startTrace(sessionId: string, query: string, iterationNumber = 0): string {
    const traceId = randomUUID();
    _liveTraces.set(traceId, {
        traceId,
        sessionId,
        startMs: Date.now(),
        queryText: query.substring(0, 500),
        iterationNumber,
        toolsSelected: [],
        contextSourcesIncluded: [],
        memoryHitCount: 0,
        memoryTopScore: 0,
        evaluationScore: null,
    });
    return traceId;
}

export function recordToolsSelected(traceId: string, tools: string[]): void {
    const t = _liveTraces.get(traceId);
    if (t) t.toolsSelected = tools.slice(0, 40);
}

export function recordContextSources(traceId: string, sources: string[]): void {
    const t = _liveTraces.get(traceId);
    if (t) t.contextSourcesIncluded = sources.slice(0, 30);
}

export function recordMemoryHit(traceId: string, hitCount: number, topScore: number): void {
    const t = _liveTraces.get(traceId);
    if (t) {
        t.memoryHitCount = hitCount;
        t.memoryTopScore = topScore;
    }
}

export function recordEvaluationScore(traceId: string, score: number): void {
    const t = _liveTraces.get(traceId);
    if (t) t.evaluationScore = score;
}

/** Finalize a trace and add to the completed buffer. */
export function finalizeTrace(traceId: string, success: boolean): TraceRecord | null {
    const t = _liveTraces.get(traceId);
    if (!t) return null;
    _liveTraces.delete(traceId);

    const record: TraceRecord = {
        traceId: t.traceId,
        sessionId: t.sessionId,
        iterationNumber: t.iterationNumber,
        queryText: t.queryText,
        toolsSelected: t.toolsSelected,
        contextSourcesIncluded: t.contextSourcesIncluded,
        memoryHitCount: t.memoryHitCount,
        memoryTopScore: t.memoryTopScore,
        evaluationScore: t.evaluationScore,
        taskSucceeded: success,
        durationMs: Date.now() - t.startMs,
        timestamp: new Date().toISOString(),
    };

    _completedTraces.push(record);
    if (_completedTraces.length > MAX_COMPLETED_BUFFER) {
        _completedTraces.shift();
    }

    // Flush to disk if a harness run is active
    if (_activeRunDir && _activeCandidateId) {
        _writeTraceFile(record, _activeRunDir, _activeCandidateId);
    }

    return record;
}

// ── Batch flush to candidate directory ─────────────────────────────────────

/**
 * Write buffered traces to a candidate's traces/ directory and clear the buffer.
 * Called at the end of each candidate evaluation so the NEXT candidate starts
 * with a clean buffer and doesn't inherit prior candidates' traces.
 *
 * Live writes via finalizeTrace() already handle traces for the ACTIVE candidate.
 * This function handles any stragglers produced before setActiveCandidate() was
 * called (e.g., traces from population seed init).
 */
export function flushTracesToCandidate(runDir: string, candidateId: string): void {
    const tracesDir = join(runDir, "candidates", candidateId, "traces");
    if (!existsSync(tracesDir)) mkdirSync(tracesDir, { recursive: true });

    // Only flush traces that weren't already written live (i.e., those without a
    // candidate-specific file yet). Since live writes use timestamp+uuid filenames
    // and we call this after the run, re-writing is idempotent — but we still clear
    // to prevent cross-candidate contamination.
    for (const trace of _completedTraces) {
        _writeTraceFile(trace, runDir, candidateId);
    }
    // Clear buffer — next candidate starts fresh
    _completedTraces.length = 0;
}

/**
 * Read all trace files from a candidate's traces directory.
 * Used by the proposer to build diagnostic context.
 */
export function readCandidateTraces(runDir: string, candidateId: string): TraceRecord[] {
    const tracesDir = join(runDir, "candidates", candidateId, "traces");
    if (!existsSync(tracesDir)) return [];

    const traces: TraceRecord[] = [];
    try {
        const files = readdirSync(tracesDir) as string[];
        for (const file of files.filter((f: string) => f.endsWith(".json"))) {
            try {
                const raw = readFileSync(join(tracesDir, file), "utf-8");
                traces.push(JSON.parse(raw) as TraceRecord);
            } catch { /* skip corrupt trace */ }
        }
    } catch { /* directory read failure */ }

    return traces.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Get recent completed traces from the in-memory buffer. */
export function getRecentTraces(limit = 50): TraceRecord[] {
    return _completedTraces.slice(-limit);
}

/** Summarize traces for inclusion in proposer context. */
export function summarizeTraces(traces: TraceRecord[]): string {
    if (traces.length === 0) return "No execution traces available.";

    let successRate: number;
    let avgEvalScore: number;
    let avgMemHits: number;
    let avgDuration: number;

    if (nativeAggregateTraces) {
        // Use Rust SIMD aggregation for speed
        const agg = nativeAggregateTraces(traces.map(t => ({
            taskSucceeded: t.taskSucceeded,
            evaluationScore: t.evaluationScore ?? undefined,
            memoryHitCount: t.memoryHitCount,
            memoryTopScore: t.memoryTopScore,
            durationMs: t.durationMs,
            toolsSelectedCount: t.toolsSelected.length,
        })));
        successRate = agg.successRate;
        avgEvalScore = agg.avgEvalScore;
        avgMemHits = agg.avgMemoryHits;
        avgDuration = agg.avgDurationMs;
    } else {
        successRate = traces.filter(t => t.taskSucceeded).length / traces.length;
        avgEvalScore = traces
            .filter(t => t.evaluationScore !== null)
            .reduce((sum, t) => sum + (t.evaluationScore ?? 0), 0)
            / (traces.filter(t => t.evaluationScore !== null).length || 1);
        avgMemHits = traces.reduce((sum, t) => sum + t.memoryHitCount, 0) / traces.length;
        avgDuration = traces.reduce((sum, t) => sum + t.durationMs, 0) / traces.length;
    }

    // Tool frequency
    const toolCounts: Record<string, number> = {};
    for (const t of traces) {
        for (const tool of t.toolsSelected) {
            toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
        }
    }
    const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tool, count]) => `${tool}(${count})`)
        .join(", ");

    // Failure examples
    const failures = traces.filter(t => !t.taskSucceeded).slice(-3);
    const failureSummary = failures.length > 0
        ? failures.map(t => `  - "${t.queryText.substring(0, 80)}" (evalScore=${t.evaluationScore ?? "n/a"}, tools=[${t.toolsSelected.slice(0,3).join(",")}])`).join("\n")
        : "  None in this window";

    return `## Execution Trace Summary (${traces.length} traces)
- Success rate: ${(successRate * 100).toFixed(1)}%
- Avg eval score: ${avgEvalScore.toFixed(1)}
- Avg memory hits: ${avgMemHits.toFixed(1)}
- Avg duration: ${(avgDuration / 1000).toFixed(1)}s
- Top tools: ${topTools}

### Recent failures:
${failureSummary}`;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _writeTraceFile(trace: TraceRecord, runDir: string, candidateId: string): void {
    try {
        const tracesDir = join(runDir, "candidates", candidateId, "traces");
        if (!existsSync(tracesDir)) mkdirSync(tracesDir, { recursive: true });
        const filename = `${trace.timestamp.replace(/[:.]/g, "-")}_${trace.traceId.substring(0, 8)}.json`;
        writeFileSync(join(tracesDir, filename), JSON.stringify(trace, null, 2), "utf-8");
    } catch { /* trace write non-fatal */ }
}
