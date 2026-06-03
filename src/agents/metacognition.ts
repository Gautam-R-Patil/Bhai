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

// ── A2: Intervention Dispatcher ───────────────
// Makes MetaAssessment.intervention ACT instead of being a dead enum. The
// nudge block in agent.ts only ever read loopDetected/struggleDetected; the
// computed escalate/replan/critics/ask_user value went nowhere. This dispatch
// turns each enum value into a concrete, cooldown-gated, fail-open action.
//
// Hot-loop safety: on a healthy turn intervention === "none" → early return,
// ZERO added cost. The paid arms (replan = one Pro call; critics = multi-critic)
// fire at most once per their cooldown window and only when free struggle/loop
// signals already flagged sustained trouble. escalate/ask_user are zero-cost
// (next iteration runs a higher tier / a rephrase nudge — both already budgeted).
//
// Kill switch: ATLAS_NO_META_INTERVENTIONS=true reverts to today's pure
// nudge-only behavior (the same env already gates the nudge cooldown-repeat).

import { MODELS } from "../llm.js";

export interface InterventionContext {
    llm: import("../llm.js").LLMClient;
    assessment: MetaAssessment;
    iterations: number;
    totalToolCalls: number;
    originalRequest: string;
    // Live LLM message array — push system/user nudges here.
    messages: import("../llm.js").ChatCompletionMessageParam[];
    recentToolNames: string[];
    taskType?: string;
    onProgress?: (m: string) => Promise<void> | void;
    state: InterventionState;
}

export interface InterventionState {
    forcedModel: string | null; // consumed by agent.ts at the model pick
    lastReplanIter: number;
    lastEscalateIter: number;
    lastCriticsIter: number;
    askUserNudges: number;
    lastAskUserIter: number;
}

export function createInterventionState(): InterventionState {
    return {
        forcedModel: null,
        lastReplanIter: -100,
        lastEscalateIter: -100,
        lastCriticsIter: -100,
        askUserNudges: 0,
        lastAskUserIter: -100,
    };
}

const ESCALATE_COOLDOWN = 5;
const REPLAN_COOLDOWN = 6;
const CRITICS_COOLDOWN = 8;
const MAX_ASK_USER_NUDGES = 2;

export async function applyIntervention(ctx: InterventionContext): Promise<void> {
    // GATE: env DISABLES the real dispatch and reverts to nudge-only.
    if (process.env.ATLAS_NO_META_INTERVENTIONS === "true") return;
    const iv = ctx.assessment.intervention;
    // ZERO added cost on a healthy turn.
    if (iv === "none") return;
    try {
        switch (iv) {
            case "escalate":
                return escalateArm(ctx);
            case "replan":
                return await replanArm(ctx);
            case "critics":
                return await criticsArm(ctx);
            case "ask_user":
                return await askUserArm(ctx);
        }
    } catch {
        /* fail-open — never break a turn over an intervention */
    }
}

// escalate — ZERO extra LLM call. Threads a higher-tier model into the NEXT
// model pick via the existing modelOverride path. Cooldown-gated.
function escalateArm(ctx: InterventionContext): void {
    if (ctx.iterations - ctx.state.lastEscalateIter < ESCALATE_COOLDOWN) return;
    const struggledHard =
        ctx.assessment.struggleDetected || ctx.assessment.confidence < 0.25 || ctx.recentToolNames.length > 0;
    const target = struggledHard ? MODELS.PRO : MODELS.SONNET;
    ctx.state.forcedModel = target;
    ctx.state.lastEscalateIter = ctx.iterations;
    ctx.messages.push({
        role: "system",
        content: `[SYSTEM — ESCALATE] Sustained struggle detected (${ctx.assessment.reasoning}). The next step runs on a higher-tier model — reconsider the approach carefully.`,
    });
}

// replan — exactly ONE gated Pro call. Builds a synthetic mesh-shaped summary
// so the mesh-oriented replan() can steer this single-agent turn.
async function replanArm(ctx: InterventionContext): Promise<void> {
    if (ctx.iterations - ctx.state.lastReplanIter < REPLAN_COOLDOWN) return;
    ctx.state.lastReplanIter = ctx.iterations;
    const { replan } = await import("./replanner.js");
    const recent = recentAssistantText(ctx.messages, 400);
    const completedResults = new Map<string, import("./sub-agent.js").SubAgentResult>([
        [
            "turn_progress",
            {
                id: "turn_progress",
                role: "general",
                success: true,
                output: recent || "(no assistant output yet)",
                toolCalls: ctx.totalToolCalls,
                durationMs: 0,
                estimatedCost: 0,
            },
        ],
    ]);
    const remainingSteps: import("./mesh.js").MeshStep[] = [
        { id: "remaining", role: "general", description: ctx.originalRequest, depends_on: [] },
    ];
    const decision = await replan(ctx.llm, ctx.originalRequest, completedResults, remainingSteps);
    ctx.messages.push({
        role: "system",
        content: `[SYSTEM — REPLAN] ${decision.reason} — revise your approach accordingly.`,
    });
}

// critics — existing multi-critic, ONLY with a tool-grounded verifier in scope.
// Otherwise downgrades to the free escalate arm.
async function criticsArm(ctx: InterventionContext): Promise<void> {
    const verifierInScope =
        ctx.recentToolNames.some((n) => n === "browser_verify" || n === "os_visual_verify") ||
        ctx.taskType === "coding";
    if (!verifierInScope) return escalateArm(ctx);
    if (ctx.iterations - ctx.state.lastCriticsIter < CRITICS_COOLDOWN) return;
    ctx.state.lastCriticsIter = ctx.iterations;
    const { runMultiCriticDebate } = await import("./multi-critic.js");
    const taskResult = recentAssistantText(ctx.messages, 3000) || "(no output produced yet)";
    const budgetMs = Number(process.env.ATLAS_POST_SYNTHESIS_BUDGET_MS ?? "90000");
    const adversarial = `Adversarially audit the work so far for the SPECIFIC failure the agent is stuck on. ORIGINAL REQUEST: ${ctx.originalRequest}`;
    const consensus = await Promise.race([
        runMultiCriticDebate(ctx.llm, adversarial, taskResult),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
    if (!consensus) return;
    const lines = [...consensus.key_issues, ...consensus.consensus_suggestions].filter(Boolean);
    if (lines.length === 0) return;
    ctx.messages.push({
        role: "system",
        content: `[SYSTEM — CRITICS] Adversarial audit found:\n- ${lines.join("\n- ")}\nAddress these before continuing.`,
    });
}

// ask_user — FEEDBACK-FIRST. The first <=2 arms are free rephrase nudges; only
// after the rephrase budget is spent do we surface a real clarifying question
// (via onProgress — still no LLM call).
async function askUserArm(ctx: InterventionContext): Promise<void> {
    ctx.state.lastAskUserIter = ctx.iterations;
    if (ctx.state.askUserNudges < MAX_ASK_USER_NUDGES) {
        ctx.state.askUserNudges++;
        ctx.messages.push({
            role: "system",
            content:
                "[SYSTEM] You appear stuck. Re-read the user's request, restate your current understanding in one line, and try a materially different approach. Do NOT ask the user yet.",
        });
        return;
    }
    await ctx.onProgress?.(
        `I'm having trouble with: ${ctx.assessment.reasoning}. Could you clarify what you're after, or should I summarize what I have so far?`,
    );
}

function recentAssistantText(messages: import("../llm.js").ChatCompletionMessageParam[], maxChars: number): string {
    const chunks: string[] = [];
    for (let i = messages.length - 1; i >= 0 && chunks.join(" ").length < maxChars; i--) {
        const m = messages[i];
        if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
            chunks.unshift(m.content.trim());
        }
    }
    return chunks.join("\n\n").slice(-maxChars);
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
