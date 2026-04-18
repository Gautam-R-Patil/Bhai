// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Metacognitive Layer ──────────────────────────
 * Wraps the agent execution loop with self-monitoring.
 * Inspired by SOFAI-LM (AAAI 2026) dual-process metacognition.
 *
 * After each tool-call iteration, assesses:
 *  - Confidence in current approach (0-1)
 *  - Whether the agent is stuck in a loop
 *  - Whether to escalate, replan, invoke critics, or ask the user
 *
 * Uses native Rust module for hot-path pattern matching and scoring.
 */

// ── Types ─────────────────────────────────────

export interface MetaSignals {
    iteration: number;
    errorCount: number;
    toolCallCount: number;
    consecutiveErrors: number;
    recentToolNames: string[];
    alreadyEscalated: boolean;
    lastResponseLength: number;
    avgResponseLength: number;
    clarificationCount: number;
    emptyToolResults: number;
}

export interface MetaAssessment {
    confidence: number;
    struggleDetected: boolean;
    loopDetected: boolean;
    intervention: "none" | "escalate" | "replan" | "critics" | "ask_user";
    reasoning: string;
}

export interface MetacognitionState {
    signals: MetaSignals;
    assessmentHistory: MetaAssessment[];
    responseLengths: number[];
}

// ── Create State ──────────────────────────────

export function createMetacognitionState(): MetacognitionState {
    return {
        signals: {
            iteration: 0,
            errorCount: 0,
            toolCallCount: 0,
            consecutiveErrors: 0,
            recentToolNames: [],
            alreadyEscalated: false,
            lastResponseLength: 0,
            avgResponseLength: 0,
            clarificationCount: 0,
            emptyToolResults: 0,
        },
        assessmentHistory: [],
        responseLengths: [],
    };
}

// ── Update Signals ────────────────────────────

export function updateSignals(
    state: MetacognitionState,
    update: {
        toolName?: string;
        hadError?: boolean;
        responseLength?: number;
        wasEmpty?: boolean;
        askedClarification?: boolean;
        wasEscalated?: boolean;
    }
): void {
    state.signals.iteration++;

    if (update.toolName) {
        state.signals.toolCallCount++;
        state.signals.recentToolNames.push(update.toolName);
        // Keep last 20 tool names
        if (state.signals.recentToolNames.length > 20) {
            state.signals.recentToolNames.shift();
        }
    }

    if (update.hadError) {
        state.signals.errorCount++;
        state.signals.consecutiveErrors++;
    } else if (update.toolName) {
        state.signals.consecutiveErrors = 0; // Reset on success
    }

    if (update.responseLength !== undefined) {
        state.signals.lastResponseLength = update.responseLength;
        state.responseLengths.push(update.responseLength);
        state.signals.avgResponseLength =
            state.responseLengths.reduce((a, b) => a + b, 0) / state.responseLengths.length;
    }

    if (update.wasEmpty) state.signals.emptyToolResults++;
    if (update.askedClarification) state.signals.clarificationCount++;
    if (update.wasEscalated) state.signals.alreadyEscalated = true;
}

// ── Assess ────────────────────────────────────

/**
 * Run metacognitive assessment on current iteration state.
 * Uses native Rust module when available for pattern matching performance.
 */
export function assess(state: MetacognitionState): MetaAssessment {
    // Try native module first
    try {
        const native = loadNative();
        if (native) {
            const result = native.computeConfidence({
                iteration: state.signals.iteration,
                error_count: state.signals.errorCount,
                tool_call_count: state.signals.toolCallCount,
                consecutive_errors: state.signals.consecutiveErrors,
                recent_tool_names: state.signals.recentToolNames,
                already_escalated: state.signals.alreadyEscalated,
                last_response_length: state.signals.lastResponseLength,
                avg_response_length: state.signals.avgResponseLength,
                clarification_count: state.signals.clarificationCount,
                empty_tool_results: state.signals.emptyToolResults,
            });

            const assessment: MetaAssessment = {
                confidence: result.confidence,
                struggleDetected: result.struggle_detected,
                loopDetected: result.loop_detected,
                intervention: result.intervention as MetaAssessment["intervention"],
                reasoning: result.reasoning,
            };

            state.assessmentHistory.push(assessment);
            return assessment;
        }
    } catch { /* native not available */ }

    // JS fallback
    return assessJS(state);
}

function assessJS(state: MetacognitionState): MetaAssessment {
    const s = state.signals;

    if (s.iteration < 3) {
        return { confidence: 0.7, struggleDetected: false, loopDetected: false, intervention: "none", reasoning: "Too early" };
    }

    let confidence = 1.0;
    const reasons: string[] = [];

    // Error ratio
    const errorRatio = s.toolCallCount > 0 ? s.errorCount / s.toolCallCount : 0;
    if (errorRatio > 0.4) { confidence -= 0.3; reasons.push(`High error ratio: ${(errorRatio * 100).toFixed(0)}%`); }
    else if (errorRatio > 0.2) { confidence -= 0.15; }

    // Consecutive errors
    if (s.consecutiveErrors >= 3) { confidence -= 0.25; reasons.push(`${s.consecutiveErrors} consecutive errors`); }
    else if (s.consecutiveErrors >= 2) { confidence -= 0.1; }

    // Empty results
    if (s.emptyToolResults > 2) { confidence -= 0.15; reasons.push(`${s.emptyToolResults} empty tool results`); }

    // High iteration count
    if (s.iteration > 15) { confidence -= 0.2; reasons.push(`High iteration count (${s.iteration})`); }
    else if (s.iteration > 10) { confidence -= 0.1; }

    // Loop detection
    const loopDetected = detectLoopJS(s.recentToolNames);
    if (loopDetected) { confidence -= 0.25; reasons.push("Repeating tool-call pattern"); }

    confidence = Math.max(0, Math.min(1, confidence));
    const struggleDetected = confidence < 0.5 || s.consecutiveErrors >= 3;

    let intervention: MetaAssessment["intervention"] = "none";
    if (confidence < 0.2) intervention = s.alreadyEscalated ? "ask_user" : "critics";
    else if (confidence < 0.35) intervention = s.alreadyEscalated ? "replan" : "escalate";
    else if (loopDetected) intervention = "replan";

    const assessment: MetaAssessment = {
        confidence,
        struggleDetected,
        loopDetected,
        intervention,
        reasoning: reasons.length > 0 ? `Confidence ${confidence.toFixed(2)} — ${reasons.join("; ")}` : `Confidence ${confidence.toFixed(2)} — OK`,
    };

    state.assessmentHistory.push(assessment);
    return assessment;
}

function detectLoopJS(tools: string[]): boolean {
    if (tools.length < 6) return false;
    const window = tools.slice(-6);

    // Check for repeated pairs
    for (let patternLen = 2; patternLen <= 3; patternLen++) {
        if (window.length < patternLen * 2) continue;
        const pattern = window.slice(-patternLen);
        let reps = 0;
        let pos = window.length - patternLen;

        while (pos >= patternLen) {
            pos -= patternLen;
            const candidate = window.slice(pos, pos + patternLen);
            if (candidate.every((v, i) => v === pattern[i])) reps++;
            else break;
        }

        if (reps >= 2) return true;
    }

    return false;
}

// ── Post-Session Quality ──────────────────────

export function computeReasoningQuality(state: MetacognitionState, taskCompleted: boolean): number {
    try {
        const native = loadNative();
        if (native) {
            return native.computeReasoningQuality(
                state.signals.iteration,
                state.signals.errorCount,
                state.signals.toolCallCount,
                state.assessmentHistory.filter(a => a.intervention === "escalate").length,
                state.assessmentHistory.filter(a => a.intervention === "replan").length,
                taskCompleted
            );
        }
    } catch { /* */ }

    // JS fallback
    if (!taskCompleted) return 0.2;
    const efficiency = 1 - Math.min(state.signals.iteration / 50, 1);
    const errorRate = state.signals.errorCount / Math.max(state.signals.toolCallCount, 1);
    return Math.max(0, Math.min(1, 0.6 + efficiency * 0.15 + (1 - errorRate) * 0.15));
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
