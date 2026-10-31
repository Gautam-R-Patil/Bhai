// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
    // C: per-iteration (taskType, modelTier) the calibrator keys on. Stamped by
    // the agent loop before assess(); absent → global calibrator fallback.
    calibrationCtx?: { taskType?: string; modelTier?: string };
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

// C: stamp the (taskType, modelTier) the calibrator keys on. Called by the
// agent loop before assess(); cheap, fail-open, no-op effect on behavior.
export function setCalibrationContext(state: MetacognitionState, ctx: { taskType?: string; modelTier?: string }): void {
    state.calibrationCtx = ctx;
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

            const final = finalizeAssessment(state, assessment);
            state.assessmentHistory.push(final);
            return final;
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

// ── Shared post-processor (B1 VOC + C calibration chokepoint) ──
// Both assess() (native) and assessJS() funnel their raw assessment through
// finalizeAssessment in ONE fixed order so the three P5 layers compose
// deterministically and neither path can drift:
//   calibrate (C, shadow) → applyContentAwareLoop (A1) → applyVocThreshold (B1)
// calibrate runs first so the loop/VOC layers see the (eventually) calibrated
// confidence; in shadow mode it is identity. VOC runs last so it can suppress
// expensive arms after A1 has had its say. P5.3's judge override does NOT live
// here — it overrides metaCheck.intervention in the agent.ts nudge block.
export function finalizeAssessment(state: MetacognitionState, a: MetaAssessment): MetaAssessment {
    return applyVocThreshold(state, applyContentAwareLoop(state, calibrate(state, a)));
}

// ── B1 (VOC): cost-aware intervention re-threshold τ = 1 − c_l/c_w ──
// Credit tiers mirror convex/credit_cost.ts (Light 0.25 / Pro 1 / Heavy 3) —
// hardcoded as scalars because intervention arms map to a COST CLASS, not a
// model ID (MODEL_COSTS in llm-middleware.ts is USD/1M-tok, wrong units; and
// credit_cost.ts is server-only Convex code we must not couple to the client).
const INTERVENTION_CREDIT_COST: Record<MetaAssessment["intervention"], number> = {
    none: 0,
    ask_user: 0,
    escalate: 1,
    replan: 1,
    critics: 3,
};
const RISK_COST = { read_only: 2, mutating: 3, irreversible: 12 } as const;
const IRREVERSIBLE_TOOLS = new Set([
    "delete_file",
    "trash_manager",
    "app_manager",
    "git_op",
    "shell_exec",
    "shell_exec_background",
    "wifi_control",
]);
const READ_ONLY_TOOLS = new Set([
    "read",
    "read_file",
    "list_files",
    "grep",
    "glob",
    "web_search",
    "codebase_query",
    "system_info",
    "get_current_time",
    "browser_extract",
]);

// Cost-of-acting-wrong proxy keyed on the most recent tool (best zero-cost
// proxy for the pending action). Empty history → medium (mutating) bucket.
function pendingRiskCost(recentToolNames: string[]): number {
    const next = recentToolNames[recentToolNames.length - 1];
    if (!next) return RISK_COST.mutating;
    if (IRREVERSIBLE_TOOLS.has(next)) return RISK_COST.irreversible;
    if (READ_ONLY_TOOLS.has(next)) return RISK_COST.read_only;
    return RISK_COST.mutating;
}

// τ is the confidence above which paying for the expensive arm is not worth it.
// Pending read-only work → high τ-headroom → downgrade expensive arms unless
// confidence is genuinely low. Destructive pending → keep firing unless very
// confident (P≥0.9). Pure arithmetic, ZERO LLM. Gate: BHAI_NO_META_VOC.
function applyVocThreshold(state: MetacognitionState, a: MetaAssessment): MetaAssessment {
    if (process.env.BHAI_NO_META_VOC === "true") return a;
    if (a.intervention === "none" || a.intervention === "ask_user") return a;
    const cL = INTERVENTION_CREDIT_COST[a.intervention];
    const cW = pendingRiskCost(state.signals.recentToolNames);
    const tau = 1 - cL / cW;
    const P = a.confidence;
    if (cW >= RISK_COST.irreversible) {
        return P >= 0.9 ? downgrade(a, "very confident on irreversible action") : a;
    }
    if (P >= tau) return downgrade(a, `P=${P.toFixed(2)} ≥ τ=${tau.toFixed(2)} (c_l=${cL}/c_w=${cW})`);
    return a;
}

// Downgrade ladder: critics/replan → escalate (free-ish); escalate → none.
function downgrade(a: MetaAssessment, why: string): MetaAssessment {
    const next: MetaAssessment["intervention"] =
        a.intervention === "critics" || a.intervention === "replan" ? "escalate" : "none";
    return { ...a, intervention: next, reasoning: `${a.reasoning}; VOC↓ ${a.intervention}→${next} (${why})` };
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

    const final = finalizeAssessment(state, assessment);
    state.assessmentHistory.push(final);
    return final;
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
// the value-gate audit-log pattern. Disable with BHAI_NO_METACOG_LOG=true.
export function logOutcome(
    state: MetacognitionState,
    taskCompleted: boolean,
    meta: { taskType?: string; modelTier?: string } = {},
): void {
    if (process.env.BHAI_NO_METACOG_LOG === "true") return;
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
        const fs = nodeFs;
        const path = nodePath;
        const dir = getDataDir();
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
// Kill switch: BHAI_NO_META_INTERVENTIONS=true reverts to today's pure
// nudge-only behavior (the same env already gates the nudge cooldown-repeat).

import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { getDataDir } from "../config/paths.js";
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
    if (process.env.BHAI_NO_META_INTERVENTIONS === "true") return;
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
    // Opus only for real struggle; merely having used tools isn't struggling.
    const struggledHard = ctx.assessment.struggleDetected || ctx.assessment.confidence < 0.25;
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
    const budgetMs = Number(process.env.BHAI_POST_SYNTHESIS_BUDGET_MS ?? "90000");
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

// ── C: Shadow-mode confidence calibration ─────
// Reads a nightly-fit calibrator (data/metacog-calibrators.json) and, in shadow
// mode (DEFAULT), computes + logs calibratedP vs the raw confidence WITHOUT
// changing the returned assessment — proving zero behavior change before anyone
// acts on it. Behavior only changes when BHAI_METACOG_SHADOW=false AND a
// calibrator that beat its baseline exists. Pure TS stats + one JSONL append;
// ZERO LLM, ZERO native. Mirrors the value-gate shadow pattern (sqlite.ts).

export type CalibratorKind = "platt" | "isotonic" | "identity";

export interface Calibrator {
    kind: CalibratorKind;
    a?: number; // platt: sigmoid(a*x+b)
    b?: number;
    knots?: Array<{ x: number; y: number }>; // isotonic: ≤16 monotone knots
    n: number;
    fitTs: string;
}

export interface BinCalibrationStats {
    n: number;
    ece: number; // expected calibration error (10 equal-width bins)
    brier: number; // mean (p − y)^2
    baselineRate: number; // mean(y)
    baselineBrier: number; // brier of predicting the constant base rate
}

export interface CalibratorBundle {
    version: 1;
    builtTs: string;
    global: Calibrator | null;
    perKey: Record<string, Calibrator>; // key = `${taskType}|${tierBucket(modelTier)}`
    diagnostics: Record<string, BinCalibrationStats>;
}

// Coarse tier so per-key cells aren't sparse (16 taskTypes × 4 buckets max).
export function tierBucket(modelTier: string | null): "heavy" | "pro" | "light" | "other" {
    const m = (modelTier ?? "").toLowerCase();
    if (m.includes("opus") || m.includes("gpt-5.4")) return "heavy";
    if (m.includes("sonnet") || m.includes("gemini-3") || m.includes("gpt-5.3") || m.includes("nova-pro")) return "pro";
    if (m.includes("haiku") || m.includes("flash") || m.includes("nano") || m.includes("mini")) return "light";
    return "other";
}

// Apply a fitted calibrator to a raw confidence; clamps to [0,1]. Identity
// passthrough on the degenerate/cold-start sentinel kind.
export function applyCalibrator(cal: Calibrator, qRaw: number): number {
    if (cal.kind === "identity") return qRaw;
    if (cal.kind === "platt") {
        const a = cal.a ?? 1;
        const b = cal.b ?? 0;
        const p = 1 / (1 + Math.exp(-(a * qRaw + b)));
        return Math.max(0, Math.min(1, p));
    }
    const knots = cal.knots;
    if (!knots || knots.length === 0) return qRaw;
    if (qRaw <= knots[0].x) return clamp01(knots[0].y);
    if (qRaw >= knots[knots.length - 1].x) return clamp01(knots[knots.length - 1].y);
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (knots[mid].x <= qRaw) lo = mid;
        else hi = mid;
    }
    const span = knots[hi].x - knots[lo].x;
    const t = span > 0 ? (qRaw - knots[lo].x) / span : 0;
    return clamp01(knots[lo].y + t * (knots[hi].y - knots[lo].y));
}

function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x));
}

// ── C: calibrator fitting (pure stats, used by the nightly reflection pass) ──

export interface CalibratorRow {
    finalConfidence: number | null;
    taskCompleted: boolean;
    taskType: string | null;
    modelTier: string | null;
}

// ECE over 10 equal-width bins + Brier + the subtractive (constant base-rate)
// baseline the calibrator must beat to be trusted.
export function computeBinStats(rows: CalibratorRow[]): BinCalibrationStats {
    const pts = rows
        .filter((r) => r.finalConfidence != null && Number.isFinite(r.finalConfidence))
        .map((r) => ({ p: clamp01(r.finalConfidence as number), y: r.taskCompleted ? 1 : 0 }));
    const n = pts.length;
    if (n === 0) return { n: 0, ece: 0, brier: 0, baselineRate: 0, baselineBrier: 0 };
    const baselineRate = pts.reduce((s, q) => s + q.y, 0) / n;
    const brier = pts.reduce((s, q) => s + (q.p - q.y) ** 2, 0) / n;
    const baselineBrier = pts.reduce((s, q) => s + (baselineRate - q.y) ** 2, 0) / n;
    const bins = Array.from({ length: 10 }, () => ({ sumP: 0, sumY: 0, n: 0 }));
    for (const q of pts) {
        const idx = Math.min(9, Math.floor(q.p * 10));
        bins[idx].sumP += q.p;
        bins[idx].sumY += q.y;
        bins[idx].n++;
    }
    let ece = 0;
    for (const b of bins) {
        if (b.n === 0) continue;
        ece += (b.n / n) * Math.abs(b.sumY / b.n - b.sumP / b.n);
    }
    return { n, ece, brier, baselineRate, baselineBrier };
}

const IDENTITY_CAL: Calibrator = { kind: "identity", n: 0, fitTs: "" };

// 1D logistic regression via gradient descent. Cold-start safe: all-one-class
// or n<10 → identity passthrough (the positive-only existing log demands this).
export function fitPlatt(rows: CalibratorRow[]): Calibrator {
    const pts = rows
        .filter((r) => r.finalConfidence != null && Number.isFinite(r.finalConfidence))
        .map((r) => ({ x: clamp01(r.finalConfidence as number), y: r.taskCompleted ? 1 : 0 }));
    if (pts.length < 10) return { ...IDENTITY_CAL };
    const classes = new Set(pts.map((q) => q.y));
    if (classes.size < 2) return { ...IDENTITY_CAL };
    let a = 1;
    let b = 0;
    const lr = 0.1;
    for (let iter = 0; iter < 200; iter++) {
        let ga = 0;
        let gb = 0;
        for (const q of pts) {
            const pred = 1 / (1 + Math.exp(-(a * q.x + b)));
            const err = pred - q.y;
            ga += err * q.x;
            gb += err;
        }
        a -= (lr * ga) / pts.length;
        b -= (lr * gb) / pts.length;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...IDENTITY_CAL };
    return { kind: "platt", a, b, n: pts.length, fitTs: new Date().toISOString() };
}

// Pool-Adjacent-Violators isotonic regression, downsampled to ≤16 knots.
export function fitIsotonic(rows: CalibratorRow[]): Calibrator {
    const pts = rows
        .filter((r) => r.finalConfidence != null && Number.isFinite(r.finalConfidence))
        .map((r) => ({ x: clamp01(r.finalConfidence as number), y: r.taskCompleted ? 1 : 0 }))
        .sort((p, q) => p.x - q.x);
    if (pts.length < 10) return { ...IDENTITY_CAL };
    if (new Set(pts.map((q) => q.y)).size < 2) return { ...IDENTITY_CAL };
    const blocks: Array<{ x: number; y: number; w: number }> = pts.map((q) => ({ x: q.x, y: q.y, w: 1 }));
    let i = 0;
    while (i < blocks.length - 1) {
        if (blocks[i].y > blocks[i + 1].y) {
            const w = blocks[i].w + blocks[i + 1].w;
            const y = (blocks[i].y * blocks[i].w + blocks[i + 1].y * blocks[i + 1].w) / w;
            blocks[i] = { x: blocks[i].x, y, w };
            blocks.splice(i + 1, 1);
            if (i > 0) i--;
        } else {
            i++;
        }
    }
    let knots = blocks.map((blk) => ({ x: blk.x, y: clamp01(blk.y) }));
    if (knots.length > 16) {
        const step = (knots.length - 1) / 15;
        const sampled: Array<{ x: number; y: number }> = [];
        for (let k = 0; k < 16; k++) sampled.push(knots[Math.round(k * step)]);
        knots = sampled;
    }
    return { kind: "isotonic", knots, n: pts.length, fitTs: new Date().toISOString() };
}

const ISOTONIC_MIN_SAMPLES = 200;

export function fitCalibrator(rows: CalibratorRow[]): Calibrator {
    return rows.length >= ISOTONIC_MIN_SAMPLES ? fitIsotonic(rows) : fitPlatt(rows);
}

// Subtractive-baseline gate: a calibrator only wins if it improves BOTH Brier
// (below the constant base-rate predictor) AND ECE.
export function calibratorBeatsBaseline(stats: BinCalibrationStats, calBrier: number, calEce: number): boolean {
    if (stats.n === 0) return false;
    return calBrier < stats.baselineBrier && calEce < stats.ece;
}

// Apply a calibrator over rows → its post-calibration ECE/Brier, so the runner
// can compare against the raw-confidence baseline before persisting.
export function scoreCalibrator(cal: Calibrator, rows: CalibratorRow[]): { ece: number; brier: number } {
    const recalibrated: CalibratorRow[] = rows.map((r) => ({
        ...r,
        finalConfidence: r.finalConfidence == null ? null : applyCalibrator(cal, clamp01(r.finalConfidence)),
    }));
    const s = computeBinStats(recalibrated);
    return { ece: s.ece, brier: s.brier };
}

let _calBundle: CalibratorBundle | null | undefined; // undefined=unloaded, null=absent
function loadCalibrators(): CalibratorBundle | null {
    if (_calBundle !== undefined) return _calBundle;
    try {
        const fs = nodeFs;
        const path = nodePath;
        const file = path.join(getDataDir(), "metacog-calibrators.json");
        const raw = fs.readFileSync(file, "utf8");
        _calBundle = JSON.parse(raw) as CalibratorBundle;
    } catch {
        _calBundle = null;
    }
    return _calBundle;
}

// Test hook — forces a bundle in-memory so the shadow/enforcing paths can be
// exercised without writing a fixture file. Pass null to clear.
export function __setCalibratorBundleForTesting(bundle: CalibratorBundle | null | undefined): void {
    _calBundle = bundle;
}

function logCalibrationShadow(row: {
    qRaw: number;
    calibratedP: number;
    taskType?: string;
    modelTier?: string;
    intervention: string;
}): void {
    if (process.env.BHAI_NO_METACOG_LOG === "true") return;
    try {
        const fs = nodeFs;
        const path = nodePath;
        const dir = getDataDir();
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
        fs.appendFileSync(path.join(dir, "metacog-calibration-shadow.jsonl"), `${line}\n`, "utf8");
    } catch {
        /* shadow log is best-effort */
    }
}

// FIRST step of finalizeAssessment. In shadow mode (default) it logs the
// calibrated probability but returns the assessment UNCHANGED. The (taskType,
// modelTier) context is stamped onto state.signals by the agent loop so the
// hot path stays a pure-state function; absent context → global calibrator.
function calibrate(state: MetacognitionState, a: MetaAssessment): MetaAssessment {
    const bundle = loadCalibrators();
    if (!bundle) return a;
    const ctx = state.calibrationCtx;
    const cal = bundle.perKey[`${ctx?.taskType ?? "?"}|${tierBucket(ctx?.modelTier ?? null)}`] ?? bundle.global;
    if (!cal) return a;
    let calibratedP: number;
    try {
        calibratedP = applyCalibrator(cal, a.confidence);
    } catch {
        return a;
    }
    logCalibrationShadow({
        qRaw: a.confidence,
        calibratedP,
        taskType: ctx?.taskType,
        modelTier: ctx?.modelTier,
        intervention: a.intervention,
    });
    const shadow = process.env.BHAI_METACOG_SHADOW !== "false"; // DEFAULT ON
    if (shadow) return a; // compute + log, DO NOT change behavior
    // ENFORCING (only after ECE/Brier proven to beat baseline): rerun the same
    // fixed cutoffs assessJS uses, against the calibrated probability.
    return reconcileInterventionWithConfidence(state, a, calibratedP);
}

function reconcileInterventionWithConfidence(state: MetacognitionState, a: MetaAssessment, p: number): MetaAssessment {
    const alreadyEscalated = state.signals.alreadyEscalated;
    let intervention: MetaAssessment["intervention"] = "none";
    if (p < 0.2) intervention = alreadyEscalated ? "ask_user" : "critics";
    else if (p < 0.35) intervention = alreadyEscalated ? "replan" : "escalate";
    else if (a.loopDetected) intervention = "replan";
    return {
        ...a,
        confidence: p,
        intervention,
        reasoning: `${a.reasoning}; calibrated P=${p.toFixed(2)}`,
    };
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const nativeRequire = createRequire(import.meta.url);
        _native = nativeRequire(nodePath.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch {
        return null;
    }
}
