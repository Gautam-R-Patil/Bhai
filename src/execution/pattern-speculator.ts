// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── PASTE Pattern Speculator ─────────────────────
 * Pattern-Aware Speculative Tool Execution.
 * Learns recurring tool-call patterns and pre-executes likely next calls.
 * 48.5% latency reduction in the PASTE paper (2026).
 *
 * How it works:
 * 1. Records all tool call sequences
 * 2. Learns frequent patterns (e.g., web_search → read_url → summarize)
 * 3. Before the LLM decides the next tool, predicts and pre-executes it
 * 4. If prediction is correct, result is already available (zero wait)
 * 5. If wrong, discards the speculative result (no harm)
 */

import type { Database } from "../memory/sqlite.js";

// ── Types ─────────────────────────────────────

export interface SpeculationResult {
    shouldSpeculate: boolean;
    predictedTool: string;
    confidence: number;
    isSafe: boolean;
    needsPreviousOutput: boolean;
}

interface PatternDB {
    patterns: any[];
    totalSequences: number;
}

// ── Safe Tools (read-only, no side effects) ───

const SAFE_TOOLS = new Set([
    "web_search", "read", "grep", "glob", "read_url", "list_directory",
    "get_weather", "get_calendar", "system_info", "recall_memory",
    "search_memory", "get_time", "clipboard_read",
]);

// ── State ─────────────────────────────────────

let recentTools: string[] = [];
let patternDB: PatternDB = { patterns: [], totalSequences: 0 };
let speculativeResults = new Map<string, any>(); // tool -> pre-computed result
const MAX_RECENT = 20;

// ── Init ──────────────────────────────────────

export function initPatternSpeculator(db?: Database): void {
    const native = loadNative();
    if (native) {
        patternDB = native.createPatternDb();
    }
    console.log("[PASTE] Pattern speculator initialized");
}

// ── Record Tool Execution ─────────────────────

/**
 * Record a tool execution. Updates the pattern database.
 * Called after every tool call in the agent loop.
 */
export function recordToolExecution(toolName: string, succeeded: boolean): void {
    const native = loadNative();

    if (native && recentTools.length > 0) {
        patternDB = native.recordToolSequence(
            patternDB, recentTools, toolName, succeeded
        );
    }

    recentTools.push(toolName);
    if (recentTools.length > MAX_RECENT) recentTools.shift();
}

// ── Get Speculation Decision ──────────────────

/**
 * Decide whether to speculatively execute the predicted next tool.
 * Returns the prediction with confidence score.
 */
export function getSpeculationDecision(): SpeculationResult {
    if (recentTools.length === 0) {
        return { shouldSpeculate: false, predictedTool: "", confidence: 0, isSafe: false, needsPreviousOutput: false };
    }

    const native = loadNative();
    if (native) {
        const decision = native.shouldSpeculate(
            patternDB, recentTools, [...SAFE_TOOLS]
        );
        return {
            shouldSpeculate: decision.should_speculate,
            predictedTool: decision.predicted_tool,
            confidence: decision.confidence,
            isSafe: decision.is_safe,
            needsPreviousOutput: decision.needs_previous_output,
        };
    }

    // JS fallback: simple bigram prediction
    return predictFromBigrams();
}

// ── Speculative Cache ─────────────────────────

/**
 * Store a speculative result (pre-computed tool output).
 */
export function cacheSpeculativeResult(toolName: string, result: any): void {
    speculativeResults.set(toolName, { result, timestamp: Date.now() });
}

/**
 * Check if a speculative result is available for this tool.
 * Returns the cached result if available and fresh (< 30s old).
 */
export function getSpeculativeResult(toolName: string): any | null {
    const cached = speculativeResults.get(toolName);
    if (!cached) return null;

    // Speculative results expire after 30 seconds
    if (Date.now() - cached.timestamp > 30_000) {
        speculativeResults.delete(toolName);
        return null;
    }

    speculativeResults.delete(toolName);
    return cached.result;
}

/**
 * Update dependency estimation after a speculation succeeds or fails.
 */
export function updateDependency(wasDependent: boolean): void {
    if (recentTools.length < 2) return;

    const native = loadNative();
    if (native) {
        const lastTool = recentTools[recentTools.length - 1];
        const sequence = recentTools.slice(0, -1);
        patternDB = native.updateDependency(patternDB, sequence, lastTool, wasDependent);
    }
}

// ── JS Fallback ───────────────────────────────

function predictFromBigrams(): SpeculationResult {
    // Simple frequency-based bigram prediction
    if (recentTools.length === 0) {
        return { shouldSpeculate: false, predictedTool: "", confidence: 0, isSafe: false, needsPreviousOutput: false };
    }

    const lastTool = recentTools[recentTools.length - 1];

    // Common patterns (hardcoded fallback)
    const commonNextTools: Record<string, string> = {
        "web_search": "read_url",
        "read_url": "summarize",
        "list_directory": "read",
        "get_calendar": "recall_memory",
    };

    const predicted = commonNextTools[lastTool];
    if (predicted) {
        return {
            shouldSpeculate: SAFE_TOOLS.has(predicted),
            predictedTool: predicted,
            confidence: 0.5,
            isSafe: SAFE_TOOLS.has(predicted),
            needsPreviousOutput: true,
        };
    }

    return { shouldSpeculate: false, predictedTool: "", confidence: 0, isSafe: false, needsPreviousOutput: false };
}

// ── Stats ─────────────────────────────────────

export function getPatternStats(): {
    totalPatterns: number;
    totalSequences: number;
    topPatterns: any[];
} {
    const native = loadNative();
    if (native) {
        const top = native.getTopPatterns(patternDB, 5);
        return {
            totalPatterns: patternDB.patterns?.length || 0,
            totalSequences: patternDB.totalSequences || 0,
            topPatterns: top,
        };
    }
    return { totalPatterns: 0, totalSequences: 0, topPatterns: [] };
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const nativeRequire = createRequire(import.meta.url);
        const path = require("node:path");
        _native = nativeRequire(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
