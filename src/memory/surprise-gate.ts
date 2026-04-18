// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Surprise Gate (D-MEM Inspired) ───────────────
 * Dopamine-gated memory consolidation based on Reward Prediction Error.
 * Memories with surprising outcomes (positive or negative) get importance boosts.
 * Routine, predictable memories decay faster.
 *
 * Reference: D-MEM: Dopamine-Gated Agentic Memory (arXiv, March 2026)
 */

// ── Types ─────────────────────────────────────

export interface SurpriseSignal {
    memoryId: number;
    predictedOutcome: number;  // 0-1 what the agent expected
    actualOutcome: number;     // 0-1 what actually happened
    rpe: number;               // Reward Prediction Error
    isSurprising: boolean;
}

export interface SurpriseResult {
    memoryId: number;
    rpe: number;
    newImportance: number;
    isSurprising: boolean;
    decayMultiplier: number;
}

// ── Core Functions ────────────────────────────

/**
 * Compute Reward Prediction Error.
 * RPE = actual - predicted
 * Positive: better than expected. Negative: worse. Near-zero: expected.
 */
export function computeRPE(predicted: number, actual: number): number {
    try {
        const native = loadNative();
        if (native) return native.computeRpe(predicted, actual);
    } catch { /* */ }

    return Math.max(-1, Math.min(1, actual - predicted));
}

/**
 * Compute importance boost based on surprise level.
 * High |RPE| → stronger memory. Near-zero RPE → no boost.
 */
export function surpriseImportanceBoost(baseImportance: number, rpe: number): number {
    try {
        const native = loadNative();
        if (native) return native.surpriseImportanceBoost(baseImportance, rpe);
    } catch { /* */ }

    const absRPE = Math.abs(rpe);
    if (absRPE < 0.2) return baseImportance; // Not surprising
    const boost = Math.min(absRPE * 2, 3);
    return Math.min(baseImportance * (1 + boost), 10);
}

/**
 * Get decay multiplier based on surprise.
 * Unsurprising → faster decay (1.5x). Very surprising → slower (0.5x).
 */
export function surpriseDecayMultiplier(rpe: number): number {
    try {
        const native = loadNative();
        if (native) return native.surpriseDecayMultiplier(rpe);
    } catch { /* */ }

    const absRPE = Math.abs(rpe);
    if (absRPE < 0.2) return 1.5;  // Boring → faster decay
    if (absRPE > 0.5) return 0.5;  // Very surprising → slower decay
    return 1.0;
}

/**
 * Process a batch of memories for surprise-gated consolidation.
 * Used during dreaming/reflection to update memory importance.
 */
export function batchSurpriseAnalysis(
    memories: Array<{ id: number; importance: number; accessCount: number; daysOld: number }>,
    predictions: number[],
    outcomes: number[]
): SurpriseResult[] {
    try {
        const native = loadNative();
        if (native) {
            const nativeMemories = memories.map(m => ({
                id: m.id,
                content: "",
                importance: m.importance,
                access_count: m.accessCount,
                days_old: m.daysOld,
            }));
            return native.batchSurpriseScores(nativeMemories, predictions, outcomes);
        }
    } catch { /* */ }

    // JS fallback
    const n = Math.min(memories.length, predictions.length, outcomes.length);
    const results: SurpriseResult[] = [];

    for (let i = 0; i < n; i++) {
        const rpe = computeRPE(predictions[i], outcomes[i]);
        results.push({
            memoryId: memories[i].id,
            rpe,
            newImportance: surpriseImportanceBoost(memories[i].importance, rpe),
            isSurprising: Math.abs(rpe) >= 0.2,
            decayMultiplier: surpriseDecayMultiplier(rpe),
        });
    }

    return results;
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
