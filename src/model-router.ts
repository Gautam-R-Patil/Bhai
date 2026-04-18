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

const CODING_TOOL_NAMES: ReadonlySet<string> = new Set([
    "read", "edit", "write", "grep", "glob", "shell_exec",
    "code_action", "code_execute", "repo_map",
]);

function maybeEscalateForCoding(
    base: ModelSelection,
    message: string,
    errorCount: number,
    lastToolCalls?: Array<{ function: { name: string } }>,
): ModelSelection | null {
    // Only escalate when the base pick is light-tier (not already Sonnet/Opus).
    if (base.taskType === "vision" || base.taskType === "research") return null;
    const currentTier = MODEL_REGISTRY[base.modelId]?.tier ?? 0;
    // Tiers: 1=Haiku-class, 2=Sonnet-class, 3=Opus-class. Don't downgrade or
    // re-escalate if already >= Sonnet.
    if (currentTier >= 2) return null;

    // Signal 1: explicit multi-file/refactor intent in the message.
    const multiFile = CODING_MULTIFILE_PATTERNS.some((p) => p.test(message));

    // Signal 2: debugging-intensive session (many errors + coding tools).
    const inCodingLoop = !!lastToolCalls && lastToolCalls.some((t) => CODING_TOOL_NAMES.has(t.function.name));
    const errorDense = errorCount >= 3 && inCodingLoop;

    if (!multiFile && !errorDense) return null;

    // Find a tier-2 model in the registry (prefer the existing Sonnet).
    const sonnet = Object.values(MODEL_REGISTRY).find((m) => m.tier === 2 && m.supportsTools);
    if (!sonnet) return null;

    return {
        ...base,
        modelId: sonnet.id,
        displayName: sonnet.displayName,
        reason: `${base.reason} → coding escalation (${multiFile ? "multi-file intent" : "error-dense coding loop"})`,
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

export function selectForSubAgent(message?: string, iteration?: number, errorCount?: number): ModelSelection {
    return selectModel({
        taskType: "sub_agent",
        message,
        iteration,
        errorCount,
    });
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
