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
    // Content-aware loop signal (A1): hashes of (toolName + canonical args)
    // for the last N calls, so identical-args spirals are visible where pure
    // tool-name matching is blind. Kept TS-side; native scorer is unchanged.
    recentStepKeys: string[];
    // Max times any single step key repeated consecutively this turn.
    maxIdenticalStepRepeats: number;
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
            recentStepKeys: [],
            maxIdenticalStepRepeats: 0,
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
        // Content-aware step key (A1): hash of toolName + canonical args.
        stepKey?: string;
    },
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

    if (update.stepKey) {
        const keys = state.signals.recentStepKeys;
        keys.push(update.stepKey);
        if (keys.length > 20) keys.shift();
        // Track the longest run of the SAME step key (identical tool+args).
        let run = 1;
        for (let i = keys.length - 2; i >= 0 && keys[i] === update.stepKey; i--) run++;
        if (run > state.signals.maxIdenticalStepRepeats) {
            state.signals.maxIdenticalStepRepeats = run;
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

            const boosted = applyContentAwareLoop(state, assessment);
            state.assessmentHistory.push(boosted);
            return boosted;
        }
    } catch {
        /* native not available */
    }

    // JS fallback
    return assessJS(state);
}

// A1: the native/JS scorers detect loops by tool NAME only. This OR-s in a
// content-aware signal — the same tool called with identical args several times
// in a row — which name-matching is blind to. Runs on every assess() path so the
// signal exists regardless of whether the native module loaded.
const IDENTICAL_STEP_LOOP_AT = 3;

function applyContentAwareLoop(state: MetacognitionState, a: MetaAssessment): MetaAssessment {
    const repeats = state.signals.maxIdenticalStepRepeats;
    if (repeats < IDENTICAL_STEP_LOOP_AT) return a;
    const confidence = Math.max(0, Math.min(a.confidence, 0.3));
    return {
        ...a,
        confidence,
        loopDetected: true,
        struggleDetected: true,
        intervention: a.intervention === "none" ? "replan" : a.intervention,
        reasoning: `${a.reasoning}; identical tool+args repeated ${repeats}×`,
    };
}

function assessJS(state: MetacognitionState): MetaAssessment {
    const s = state.signals;

    if (s.iteration < 3) {
        return {
            confidence: 0.7,
            struggleDetected: false,
            loopDetected: false,
            intervention: "none",
            reasoning: "Too early",
        };
    }

    let confidence = 1.0;
    const reasons: string[] = [];

    // Error ratio
    const errorRatio = s.toolCallCount > 0 ? s.errorCount / s.toolCallCount : 0;
    if (errorRatio > 0.4) {
        confidence -= 0.3;
        reasons.push(`High error ratio: ${(errorRatio * 100).toFixed(0)}%`);
    } else if (errorRatio > 0.2) {
        confidence -= 0.15;
    }

    // Consecutive errors
    if (s.consecutiveErrors >= 3) {
        confidence -= 0.25;
        reasons.push(`${s.consecutiveErrors} consecutive errors`);
    } else if (s.consecutiveErrors >= 2) {
        confidence -= 0.1;
    }

    // Empty results
    if (s.emptyToolResults > 2) {
        confidence -= 0.15;
        reasons.push(`${s.emptyToolResults} empty tool results`);
    }

    // High iteration count
    if (s.iteration > 15) {
        confidence -= 0.2;
        reasons.push(`High iteration count (${s.iteration})`);
    } else if (s.iteration > 10) {
        confidence -= 0.1;
    }

    // Loop detection
    const loopDetected = detectLoopJS(s.recentToolNames);
    if (loopDetected) {
        confidence -= 0.25;
        reasons.push("Repeating tool-call pattern");
    }

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
        reasoning:
            reasons.length > 0
                ? `Confidence ${confidence.toFixed(2)} — ${reasons.join("; ")}`
                : `Confidence ${confidence.toFixed(2)} — OK`,
    };

    const boosted = applyContentAwareLoop(state, assessment);
    state.assessmentHistory.push(boosted);
    return boosted;
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
                state.assessmentHistory.filter((a) => a.intervention === "escalate").length,
                state.assessmentHistory.filter((a) => a.intervention === "replan").length,
                taskCompleted,
            );
        }
    } catch {
        /* */
    }

    // JS fallback
    if (!taskCompleted) return 0.2;
    const efficiency = 1 - Math.min(state.signals.iteration / 50, 1);
    const errorRate = state.signals.errorCount / Math.max(state.signals.toolCallCount, 1);
    return Math.max(0, Math.min(1, 0.6 + efficiency * 0.15 + (1 - errorRate) * 0.15));
}

// ── A3: Outcome log ───────────────────────────
// Persist one row per turn so confidence/intervention quality can be analyzed
// and (later) calibrated against real outcomes — the signal computeReasoningQuality
// produced was previously never recorded. Append-only JSONL, fail-open, mirrors
// the value-gate audit-log pattern. Disable with ATLAS_NO_METACOG_LOG=true.
export function logOutcome(
    state: MetacognitionState,
    taskCompleted: boolean,
    meta: { taskType?: string; modelTier?: string } = {},
): void {
    if (process.env.ATLAS_NO_METACOG_LOG === "true") return;
    try {
        const s = state.signals;
        const last = state.assessmentHistory[state.assessmentHistory.length - 1];
        const interventions = state.assessmentHistory.reduce<Record<string, number>>((acc, a) => {
            if (a.intervention !== "none") acc[a.intervention] = (acc[a.intervention] ?? 0) + 1;
            return acc;
        }, {});
        const row = {
            iterations: s.iteration,
            toolCalls: s.toolCallCount,
            errors: s.errorCount,
            maxConsecutiveErrors: s.consecutiveErrors,
            maxIdenticalStepRepeats: s.maxIdenticalStepRepeats,
            loopEverDetected: state.assessmentHistory.some((a) => a.loopDetected),
            finalConfidence: last ? Number(last.confidence.toFixed(3)) : null,
            interventions,
            qualityScore: Number(computeReasoningQuality(state, taskCompleted).toFixed(3)),
            taskCompleted,
            taskType: meta.taskType ?? null,
            modelTier: meta.modelTier ?? null,
        };
        // Lazy node:fs/path require keeps this module import-light (it is loaded
        // on the hot path) and avoids a top-level fs dependency in tests.
        const fs = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        const dir = path.join(process.cwd(), "data");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, "metacog-outcomes.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    } catch {
        /* outcome logging is best-effort — never break a turn over it */
    }
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
    } catch {
        return null;
    }
}
