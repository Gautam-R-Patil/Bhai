// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Model Router (Thin JS Wrapper) ──────────────
// Core logic is compiled to native Rust binary via napi-rs.
// This file provides the TypeScript interface and loads the native module.

import type { ThinkingLevel } from "./llm.js";

// ── Types (re-exported for consumers) ────────────

export interface ModelInfo {
    id: string;
    displayName: string;
    inputCostPer1M: number;
    outputCostPer1M: number;
    tier: number;
    speed: "slow" | "medium" | "fast" | "very_fast" | "ultra_fast";
    strengths: string[];
    maxTokens: number;
    supportsTools: boolean;
    supportsVision: boolean;
    provider: "anthropic" | "google" | "openai" | "amazon";
    supportsParallelTools: boolean;
}

export type TaskType =
    | "classify" | "simple_chat" | "complex_chat" | "tool_loop"
    | "coding" | "planning" | "synthesis" | "final_answer"
    | "research" | "sub_agent" | "audio_analysis" | "vision"
    | "first_iteration" | "error_recovery";

export interface ConversationContext {
    recentScores: number[];
    currentMood: "casual" | "focused" | "emotional" | "urgent";
    escalatedThisSession: boolean;
    dominantTaskType: TaskType | null;
    toolCallsThisSession: number;
    turnsThisSession: number;
    lastModelUsed: string | null;
}

export interface ModelSelection {
    modelId: string;
    displayName: string;
    thinkingLevel: ThinkingLevel;
    reason: string;
    complexityScore: number;
    taskType: TaskType;
    estimatedCostPerCall: number;
}

export interface CascadeResult {
    shouldEscalate: boolean;
    reason: string;
}

// ── Load Native Module ──────────────────────────

import path from "node:path";
import { fileURLToPath } from "node:url";

interface NativeModelRouter {
    selectModel(
        message: string,
        iteration: number,
        errorCount: number,
        hasMedia: boolean,
        taskType: string | null,
        modelHint: string | null,
        urgency: string | null,
        lastToolCallNames: string[] | null,
    ): {
        model_id: string;
        display_name: string;
        thinking_level: string;
        reason: string;
        complexity_score: number;
        task_type: string;
        estimated_cost_per_call: number;
    };
    selectForClassify(): any;
    selectForAgent(message: string, iteration: number, errorCount: number, modelHint: string | null, lastToolCallNames: string[] | null, hasMedia: boolean): any;
    selectForFinalAnswer(taskType: string | null): any;
    selectForSynthesis(): any;
    selectForPlanning(): any;
    selectForSubAgent(): any;
    selectForResearch(): any;
    updateModelStats(modelId: string, latencyMs: number, success: boolean, inputTokensEst: number, outputTokensEst: number, httpStatus: number | null): void;
    updateToolStats(modelId: string, success: boolean, taskType: string | null): void;
    recordQualityFailure(modelId: string, taskType: string, reason: string): void;
    getSessionCostSummary(): string;
    resetSessionStats(): void;
    shouldCascadeEscalate(response: string, originalMessage: string, currentModelId: string): { should_escalate: boolean; reason: string };
    getCascadeNext(currentModelId: string): string | null;
    getHorizontalFailover(modelId: string): string | null;
    isCircuitOpenNapi(modelId: string): boolean;
    getProviderOrder(modelId: string): string[] | null;
    getConversationContext(): any;
    updateConversationContext(updatesJson: string): void;
    resetConversationContext(): void;
    computeComplexityScore(signalsJson: string): number;
    scoreToThinking(score: number, taskType: string): string;
    getModelInfo(modelId: string): any;
    getAllModelIds(): string[];
}

let native: NativeModelRouter | null = null;

try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const nativePath = path.resolve(__dirname, "../native/index.js");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const mod = require(nativePath);
    if (mod?.selectModel) {
        native = mod;
        console.log("⚡ Native model router loaded");
    }
} catch {
    // Native module not available, will use JS fallback
}

// ── Helper: convert native result to TypeScript types ──

const VALID_THINKING: Set<string> = new Set(["off", "low", "medium", "high", "max"]);
const VALID_TASK_TYPES: Set<string> = new Set([
    "classify", "simple_chat", "complex_chat", "tool_loop", "coding",
    "planning", "synthesis", "final_answer", "research", "sub_agent",
    "audio_analysis", "vision", "first_iteration", "error_recovery",
]);

function convertSelection(raw: any): ModelSelection {
    const thinkRaw = ((raw.thinking_level ?? raw.thinkingLevel ?? "off") as string).toLowerCase();
    const taskRaw = (raw.task_type ?? raw.taskType ?? "first_iteration") as string;

    return {
        modelId: raw.model_id ?? raw.modelId,
        displayName: raw.display_name ?? raw.displayName,
        thinkingLevel: (VALID_THINKING.has(thinkRaw) ? thinkRaw : "off") as ThinkingLevel,
        reason: raw.reason,
        complexityScore: raw.complexity_score ?? raw.complexityScore ?? 50,
        taskType: (VALID_TASK_TYPES.has(taskRaw) ? taskRaw : "first_iteration") as TaskType,
        estimatedCostPerCall: raw.estimated_cost_per_call ?? raw.estimatedCostPerCall ?? 0.009,
    };
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API — delegates to native Rust when available
// ══════════════════════════════════════════════════════════════════════════

// Re-export MODEL_REGISTRY for backward compatibility
export const MODEL_REGISTRY: Record<string, ModelInfo> = {};

// Populate from native if available, otherwise hardcode
if (native) {
    const ids = native.getAllModelIds();
    for (const id of ids) {
        const info = native.getModelInfo(id);
        if (info) {
            MODEL_REGISTRY[id] = {
                id: info.id,
                displayName: info.display_name,
                inputCostPer1M: info.input_cost_per_1m,
                outputCostPer1M: info.output_cost_per_1m,
                tier: info.tier,
                speed: info.speed?.toLowerCase().replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() || "medium",
                strengths: info.strengths || [],
                maxTokens: info.max_tokens,
                supportsTools: info.supports_tools,
                supportsVision: info.supports_vision,
                provider: info.provider?.toLowerCase() || "anthropic",
            } as ModelInfo;
        }
    }
} else {
    // Inline fallback if native not available (development only)
    console.warn("[ModelRouter] Native module not available, using JS fallback");
}

export function getConversationContext(): ConversationContext {
    if (native) {
        const raw = native.getConversationContext();
        return {
            recentScores: raw.recent_scores || [],
            currentMood: raw.current_mood || "casual",
            escalatedThisSession: raw.escalated_this_session || false,
            dominantTaskType: raw.dominant_task_type || null,
            toolCallsThisSession: raw.tool_calls_this_session || 0,
            turnsThisSession: raw.turns_this_session || 0,
            lastModelUsed: raw.last_model_used || null,
        };
    }
    return { recentScores: [], currentMood: "casual", escalatedThisSession: false, dominantTaskType: null, toolCallsThisSession: 0, turnsThisSession: 0, lastModelUsed: null };
}

export function updateConversationContext(updates: Partial<ConversationContext>): void {
    if (native) {
        native.updateConversationContext(JSON.stringify(updates));
    }
}

export function resetConversationContext(): void {
    if (native) {
        native.resetConversationContext();
    }
}

export function updateModelStats(modelId: string, latencyMs: number, success: boolean, inputTokensEst: number, outputTokensEst: number, httpStatus?: number): void {
    if (native) {
        native.updateModelStats(modelId, latencyMs, success, inputTokensEst, outputTokensEst, httpStatus ?? null);
    }
}

export function getSessionCostSummary(): string {
    if (native) {
        return native.getSessionCostSummary();
    }
    return "Model router not loaded";
}

export function resetSessionStats(): void {
    if (native) {
        native.resetSessionStats();
    }
}

export function isCircuitOpen(modelId: string): boolean {
    if (native) {
        return native.isCircuitOpenNapi(modelId);
    }
    return false;
}

export function getHorizontalFailoverModel(modelId: string): string | null {
    if (native) {
        return native.getHorizontalFailover(modelId);
    }
    return null;
}

export function updateToolStats(modelId: string, success: boolean, taskType?: string): void {
    if (native) {
        native.updateToolStats(modelId, success, taskType || null);
    }
}

export function recordQualityFailure(modelId: string, taskType: string, reason: string): void {
    if (native) {
        native.recordQualityFailure(modelId, taskType, reason);
    }
}

export function selectModel(opts: {
    taskType?: TaskType;
    message?: string;
    iteration?: number;
    errorCount?: number;
    hasMedia?: boolean;
    modelHint?: "simple" | "complex";
    lastToolCalls?: Array<{ function: { name: string } }>;
    urgency?: "realtime" | "background";
} = {}): ModelSelection {
    if (native) {
        const toolNames = opts.lastToolCalls?.map(tc => tc.function.name) || null;
        const raw = native.selectModel(
            opts.message || "",
            opts.iteration || 1,
            opts.errorCount || 0,
            opts.hasMedia || false,
            opts.taskType || null,
            opts.modelHint || null,
            opts.urgency || null,
            toolNames,
        );
        return convertSelection(raw);
    }
    // Fallback: complexity-aware routing using Claude models for personality
    const isSimple = opts.modelHint === "simple"
        || opts.taskType === "simple_chat"
        || opts.taskType === "classify";

    if (isSimple) {
        return {
            modelId: "anthropic/claude-haiku-4.5",
            displayName: "Haiku 4.5 (fallback)",
            thinkingLevel: "off" as ThinkingLevel,
            reason: "fallback:simple_message",
            complexityScore: 10,
            taskType: opts.taskType || "simple_chat",
            estimatedCostPerCall: 0.001,
        };
    }
    return {
        modelId: "anthropic/claude-sonnet-4.6",
        displayName: "Sonnet 4.6",
        thinkingLevel: "off",
        reason: "fallback:native_unavailable",
        complexityScore: 50,
        taskType: opts.taskType || "first_iteration",
        estimatedCostPerCall: 0.009,
    };
}

export function shouldCascadeEscalate(response: string, originalMessage: string, currentModelId: string): CascadeResult {
    if (native) {
        const raw = native.shouldCascadeEscalate(response, originalMessage, currentModelId);
        return { shouldEscalate: raw.should_escalate, reason: raw.reason };
    }
    return { shouldEscalate: false, reason: "native_unavailable" };
}

export function getCascadeNext(currentModelId: string): string | null {
    if (native) return native.getCascadeNext(currentModelId);
    return null;
}

export function getHorizontalFailover(modelId: string): string | null {
    if (native) return native.getHorizontalFailover(modelId);
    return null;
}

export function getProviderOrder(modelId: string): string[] | undefined {
    if (native) {
        const result = native.getProviderOrder(modelId);
        return result || undefined;
    }
    return undefined;
}

// ── Shortcut Functions ───────────────────────────

export function selectForClassify(): ModelSelection {
    return selectModel({ taskType: "classify" });
}

export function selectForAgent(
    message: string,
    iteration: number,
    errorCount: number,
    modelHint?: "simple" | "complex",
    lastToolCalls?: Array<{ function: { name: string } }>,
    hasMedia?: boolean,
): ModelSelection {
    let taskType: TaskType | undefined;
    if (hasMedia) taskType = "vision";
    else if (iteration > 1 && lastToolCalls && lastToolCalls.length > 0) taskType = "tool_loop";

    const base = selectModel({
        taskType,
        message,
        iteration,
        errorCount,
        hasMedia,
        modelHint,
        lastToolCalls,
    });

    // ── Complex-coding escalation (additive) ──
    // When the message looks like complex coding work — multi-file refactor,
    // debugging session with repeated errors, or a new-feature request — and
    // the base router picked a light-tier model, bump to Sonnet. Disable
    // with ATLAS_NO_CODING_ESCALATION=true if it ever mis-fires.
    try {
        if (process.env.ATLAS_NO_CODING_ESCALATION !== "true") {
            const escalated = maybeEscalateForCoding(base, message, errorCount, lastToolCalls);
            if (escalated) return escalated;
        }
    } catch {
        /* fall through to base — escalation is purely additive */
    }
    return base;
}

// ── Coding Escalation Helper ──────────────────

const CODING_MULTIFILE_PATTERNS: RegExp[] = [
    /\brefactor\b/i,
    /\bmigrate\b/i,
    /\bacross\s+(?:multiple|several|many)\s+files?\b/i,
    /\bfor each\s+file\b/i,
    /\bnew\s+feature\b/i,
    /\bimplement\s+a\s+(?:new\s+)?system\b/i,
    /\bwrite\s+(?:a\s+)?(?:new\s+)?module\b/i,
    /\bport\s+.*\s+to\b/i,
];

// Non-trivial coding intent — anything beyond a one-liner tweak. If the
// message shows any of these signals, default is Pro tier (Sonnet/Opus/
// Gemini-Pro). Expanded beyond the multi-file list because "fix this
// race condition in auth.ts" is single-file but definitely not a
// one-liner — it still needs real reasoning.
const CODING_INTENT_PATTERNS: RegExp[] = [
    /\b(implement|build|create|write|add|extend|wire|integrate)\s+(?!a?\s?(?:log|console|comment))/i,
    /\b(debug|diagnose|investigate|trace)\b/i,
    /\b(optimize|improve|speed\s*up|reduce|fix\s+perf)\b/i,
    /\b(race\s+condition|deadlock|memory\s+leak|flaky|intermittent)\b/i,
    /\b(schema|migration|api\s+endpoint|handler|middleware)\b/i,
    /\b(test|spec|failing|regression)\b/i,
    /\b(refactor|rename|restructure|extract|inline)\b/i,
    /\b(error|bug|issue|broken|doesn'?t\s+work|not\s+working)\b/i,
];

// Trivially-simple coding: one-off small edits that legitimately do not
// need Pro reasoning. Matches act as a DOWNGRADE permission even when
// the taskType is coding — callers that ask for "add a console.log",
// "rename foo to bar", "fix this typo" shouldn't burn Opus.
const CODING_TRIVIAL_PATTERNS: RegExp[] = [
    /^\s*(?:add|insert|put)\s+(?:a\s+)?(?:console\.log|print|log(?:\s+statement)?|comment|todo)\b/i,
    /^\s*(?:remove|delete|strip)\s+(?:unused|dead|commented|the)\s+/i,
    /^\s*(?:fix|correct)\s+(?:a\s+)?typo\b/i,
    /^\s*(?:rename|change)\s+\S+\s+to\s+\S+\s*$/i,
    /^\s*update\s+(?:the\s+)?(?:comment|docstring|readme|version)\b/i,
    /^\s*bump\s+(?:the\s+)?version\b/i,
];

function isTriviallySimpleCoding(message: string): boolean {
    if (!message) return false;
    // Long messages are rarely trivial — the user is explaining context.
    if (message.length > 140) return false;
    return CODING_TRIVIAL_PATTERNS.some((p) => p.test(message));
}

function hasCodingIntent(message: string): boolean {
    if (!message) return false;
    return CODING_INTENT_PATTERNS.some((p) => p.test(message));
}

// Signals a task deserves the full design-docs → approval → implement →
// walkthrough ceremony. Distinct from hasCodingIntent (which fires for
// any non-trivial coding) — "complex" specifically means multi-file,
// architectural, new-system, or high-stakes work where a PRD genuinely
// pays for itself.
// Action verbs that indicate the user wants us to BUILD something, not
// debug / investigate something that already exists. Used as an anchor
// for high-stakes-domain patterns (auth, payments, schema, etc.) so
// "debug auth middleware" classifies as standard instead of complex.
const CODING_BUILD_VERB = /\b(implement|build|create|design|add|introduce|set\s+up|ship)\b/i;

const CODING_COMPLEX_PATTERNS: RegExp[] = [
    /\brefactor\b/i,
    /\brewrite\b/i,
    /\bmigrate\b/i,
    /\bport\s+.*\s+to\b/i,
    /\bacross\s+(?:multiple|several|many)\s+files?\b/i,
    // "new <thing>" — broader so it catches "new rate limiter", "new
    // endpoint", "new worker", etc. beyond the original fixed noun list.
    /\ba?\s*new\s+\w+(?:\s+\w+){0,4}\s+(?:for|to|that|which)\b/i,
    /\bnew\s+(?:feature|system|module|service|tool|package|component|endpoint|handler|worker|limiter|queue|pipeline|flow|page|route|screen|dashboard|widget)\b/i,
    /\b(implement|build|create|design)\s+(?:a?\s?)?(?:full|complete|production|end.to.end)\b/i,
    /\b(re.?architect|system\s+design|distributed|microservice)\b/i,
    /\bend.to.end\b/i,
    /\b(schema\s+migration|add.*migration|change\s+the\s+schema)\b/i,
];

// High-stakes domains — only complex when combined with a build verb.
// "debug auth middleware" stays standard; "implement auth" goes complex.
const CODING_HIGH_STAKES_DOMAINS: RegExp[] = [
    /\bauth(?:entication|orization)?\b|\brbac\b|\bsso\b|\boauth\b|\bsaml\b/i,
    /\bdatabase\b|\bschema\b|\bmigration\b/i,
    /\bapi\s+endpoint\b|\brest\s+api\b|\bgraphql\b|\bwebsocket\s+server\b/i,
    /\bpipeline\b|\bworkflow\b|\betl\b|\bscheduler\b|\bqueue\b|\bpub.?sub\b/i,
    /\bpayment\b|\bbilling\b|\bsubscription\b|\bstripe\b|\bcheckout\s+flow\b/i,
    /\bsecurity\b|\bcryptograph\b|\bencrypt(?:ion)?\b|\baudit\s+log\b|\bcompliance\b/i,
];

export type CodingComplexity = "trivial" | "standard" | "complex";

/**
 * Classify a user's coding request so downstream layers can gate on it.
 *   trivial  → single-liner edits; skip design-docs ceremony, Light tier OK
 *   standard → focused debugging / single-feature work; Pro tier, no PRD
 *   complex  → architectural / new-system / high-stakes; full design-docs flow
 *
 * Best-effort heuristic — callers should treat the answer as a strong
 * default, not a verdict.
 */
export function classifyCodingComplexity(message: string): CodingComplexity {
    if (!message) return "standard";
    if (isTriviallySimpleCoding(message)) return "trivial";
    if (CODING_COMPLEX_PATTERNS.some((p) => p.test(message))) return "complex";
    // High-stakes domains only qualify as complex when combined with a
    // build verb — "implement auth" yes, "debug auth middleware" no.
    if (CODING_BUILD_VERB.test(message) && CODING_HIGH_STAKES_DOMAINS.some((p) => p.test(message))) {
        return "complex";
    }
    if (message.length > 400) return "complex"; // long detailed asks get the full flow
    return "standard";
}

const CODING_TOOL_NAMES: ReadonlySet<string> = new Set([
    "read", "edit", "write", "grep", "glob", "shell_exec",
    "code_action", "code_execute", "repo_map",
]);

// Tier numbering in MODEL_REGISTRY is inverted from intuition:
//   0 = Opus-class (top), 2 = Sonnet, 3 = Gemini Pro, 4 = Nova Pro,
//   5 = Haiku / Gemini Flash, 6-9 = lighter variants.
// So "Pro tier or better" = tier <= 4. Anything > 4 is Light and worth
// escalating for coding work.
const PRO_TIER_CEILING = 4;

function maybeEscalateForCoding(
    base: ModelSelection,
    message: string,
    errorCount: number,
    lastToolCalls?: Array<{ function: { name: string } }>,
): ModelSelection | null {
    // Never re-route vision / research — those have their own tier logic.
    if (base.taskType === "vision" || base.taskType === "research") return null;
    const currentTier = MODEL_REGISTRY[base.modelId]?.tier ?? 99;

    // Already on Pro-tier (Sonnet/Opus/Gemini-Pro) → no escalation needed.
    if (currentTier <= PRO_TIER_CEILING) return null;

    // Trivial coding explicitly opted out of Pro — "add a console.log",
    // "rename foo to bar", "fix typo". Keep Light tier; these are cheap
    // and the router's base pick is already sane.
    if (isTriviallySimpleCoding(message)) return null;

    // Signals that demand Pro:
    //   A. taskType was classified as coding upstream
    //   B. message matches a multi-file / refactor intent
    //   C. message has non-trivial coding intent (debug, build, fix bug...)
    //   D. error-dense coding loop (debugging session)
    const isCodingTask = base.taskType === "coding";
    const multiFile = CODING_MULTIFILE_PATTERNS.some((p) => p.test(message));
    const hasIntent = hasCodingIntent(message);
    const inCodingLoop = !!lastToolCalls && lastToolCalls.some((t) => CODING_TOOL_NAMES.has(t.function.name));
    const errorDense = errorCount >= 3 && inCodingLoop;

    if (!isCodingTask && !multiFile && !hasIntent && !errorDense) return null;

    // Find a tier-2 model in the registry (prefer the existing Sonnet).
    // Native registry sometimes leaves supportsTools undefined; treat that
    // as "supported" — only explicit false rules a model out.
    const sonnet = Object.values(MODEL_REGISTRY).find((m) => m.tier === 2 && m.supportsTools !== false);
    if (!sonnet) return null;
    const sonnetDisplay = sonnet.displayName || sonnet.id;

    // ── Phase 4F: extended thinking budget for complex coding ──
    // Gated by env so cost can be pulled without a redeploy. Lifts
    // the thinking budget when signals indicate architectural reasoning
    // would pay off; otherwise leaves base.thinkingLevel untouched.
    let thinkingLevel = base.thinkingLevel;
    if (process.env.ATLAS_NO_CODING_THINKING !== "true") {
        const ultra = /\b(refactor\s+architecture|design\s+system|re.?architect|port\s+.*\s+to)\b/i.test(message);
        const heavy = multiFile || (errorDense && errorCount >= 4);
        if (ultra) thinkingLevel = "max";
        else if (heavy) thinkingLevel = "high";
        else if (thinkingLevel === "off") thinkingLevel = "medium";
    }

    const trigger = multiFile
        ? "multi-file intent"
        : errorDense
          ? "error-dense coding loop"
          : hasIntent
            ? "non-trivial coding intent"
            : "coding task default";

    return {
        ...base,
        modelId: sonnet.id,
        displayName: sonnetDisplay,
        thinkingLevel,
        reason: `${base.reason} → coding escalation (${trigger}${thinkingLevel !== base.thinkingLevel ? `, thinking=${thinkingLevel}` : ""})`,
    };
}

export function selectForFinalAnswer(taskType?: TaskType): ModelSelection {
    if (taskType === "simple_chat") return selectModel({ taskType: "simple_chat" });
    return selectModel({ taskType: "final_answer" });
}

export function selectForSynthesis(message?: string): ModelSelection {
    return selectModel({ taskType: "synthesis", message });
}

export function selectForPlanning(message?: string): ModelSelection {
    return selectModel({ taskType: "planning", message });
}

export function selectForSubAgent(
    message?: string,
    iteration?: number,
    errorCount?: number,
    role?: string,
): ModelSelection {
    const base = selectModel({
        taskType: "sub_agent",
        message,
        iteration,
        errorCount,
    });
    // Coder sub-agents default to Pro tier — coding work is where wrong
    // tier hurts most. Trivial one-liners still downgrade via the
    // isTriviallySimpleCoding check inside maybeEscalateForCoding.
    if (role === "coder") {
        const currentTier = MODEL_REGISTRY[base.modelId]?.tier ?? 99;
        // Tier numbers go: 0=Opus, 2=Sonnet, 3=Gemini Pro, 4=Nova Pro,
        // 5+=Light. Pin coder to tier <= 4 unless task is trivially simple.
        if (currentTier > PRO_TIER_CEILING && !isTriviallySimpleCoding(message || "")) {
            const sonnet = Object.values(MODEL_REGISTRY).find((m) => m.tier === 2 && m.supportsTools !== false);
            if (sonnet) {
                return {
                    ...base,
                    modelId: sonnet.id,
                    displayName: sonnet.displayName || sonnet.id,
                    reason: `${base.reason} → coder sub-agent pinned to Pro tier`,
                };
            }
        }
    }
    return base;
}

export function selectForResearch(message?: string): ModelSelection {
    return selectModel({ taskType: "research", message });
}

// ── Backward compatibility: computeComplexityScore ──

export function computeComplexityScore(signals: {
    messageLength: number;
    questionComplexity: number;
    actionIntent: number;
    emotionalIntensity: number;
    technicalDensity: number;
    conversationDepth: number;
    mediaAttached: number;
    urgencySignal: number;
    iterationFactor: number;
    errorHistory: number;
}): number {
    if (native) {
        return native.computeComplexityScore(JSON.stringify(signals));
    }
    return Math.min(100, Math.max(0,
        signals.messageLength + signals.questionComplexity + signals.actionIntent +
        signals.emotionalIntensity + signals.technicalDensity + signals.conversationDepth +
        signals.mediaAttached + signals.urgencySignal + signals.iterationFactor + signals.errorHistory
    ));
}
