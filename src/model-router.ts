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
    | "first_iteration" | "error_recovery"
    | "tool_synthesis";

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
import { createRequire as _modelCreateRequire } from "node:module";
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
    getHorizontalFailoverExcluding(modelId: string, exclude: string[]): string | null;
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
    // process.cwd() = project root in dev, BOT_DIR in production Electron build.
    // This works whether the code runs as individual dist/ files or as a single bundle.
    const nativePath = path.join(process.cwd(), "native", "index.js");
    const require = _modelCreateRequire(import.meta.url);
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
    "tool_synthesis",
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

let warnedAboutMissingExclude = false;
export function getHorizontalFailoverModel(modelId: string, exclude?: string[]): string | null {
    if (native) {
        if (exclude && exclude.length > 0) {
            if (native.getHorizontalFailoverExcluding) {
                return native.getHorizontalFailoverExcluding(modelId, exclude);
            }
            if (!warnedAboutMissingExclude) {
                warnedAboutMissingExclude = true;
                console.warn("⚠️  native router missing getHorizontalFailoverExcluding — rebuild native module to restore full fallback chain");
            }
        }
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
    let result: ModelSelection;
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
        result = convertSelection(raw);
    } else {
        // Native model router is required. Return Haiku as a minimum-cost safe default
        // and log a clear error so misconfigured builds are immediately visible.
        console.error("[ModelRouter] Native module unavailable — falling back to Haiku. Run: npm run build:native");
        result = {
            modelId: "anthropic/claude-haiku-4.5",
            displayName: "Haiku 4.5 (native-unavailable fallback)",
            thinkingLevel: "off" as ThinkingLevel,
            reason: "fallback:native_required",
            complexityScore: 10,
            taskType: opts.taskType || "simple_chat",
            estimatedCostPerCall: 0.001,
        };
    }

    // tool_synthesis ⇒ always Pro tier (Sonnet) unless ATLAS_NO_SYNTHESIS_ESCALATION
    // is set. Native router may not yet recognize the new task type (Task 7
    // adds it), so this TS-side guard keeps the contract intact.
    if (opts.taskType === "tool_synthesis") {
        try {
            const escalated = maybeEscalateForSynthesis(result, false);
            if (escalated) return escalated;
        } catch { /* additive — fall through */ }
    }
    return result;
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

    // ── Synthesis escalation ──
    // When the agent is about to invoke create_tool (or just did), bump to
    // Pro tier so the Forge verifier loop runs against Sonnet. Disable with
    // ATLAS_NO_SYNTHESIS_ESCALATION=true. Runs FIRST — most specific match wins.
    try {
        if (lastToolCalls?.some((t) => t.function.name === "create_tool")) {
            const escalated = maybeEscalateForSynthesis(base, false);
            if (escalated) return escalated;
        }
    } catch { /* additive — fall through */ }

    // ── Browser automation escalation ──
    // Browser tasks (multi-step form fill, CAPTCHA, design tools like Figma/Canva)
    // need Pro tier (Sonnet) for spatial reasoning, and Opus when stuck.
    // Runs BEFORE coding escalation — browser detection is more specific.
    try {
        if (process.env.ATLAS_NO_BROWSER_ESCALATION !== "true") {
            const escalated = maybeEscalateForBrowser(base, message, iteration, errorCount, lastToolCalls);
            if (escalated) return escalated;
        }
    } catch { /* additive — fall through */ }

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

// Multi-file / refactor / architectural changes always deserve Pro-tier.
// These patterns catch explicit mentions of scope beyond one-liner work.
const CODING_MULTIFILE_PATTERNS: RegExp[] = [
    /\brefactor(?:ing|ed|s)?\b/i,
    /\bmigrate\s+(?:all|the|my)\b/i,
    /\b(?:update|change|replace)\s+(?:all|every|across|throughout)\b/i,
    /\bacross\s+(?:all|multiple)\s+files?\b/i,
    /\bmulti[- ]?file\b/i,
    /\brename\s+.*\b(?:across|globally|everywhere|throughout)\b/i,
    /\bextract\s+(?:to|into)\s+.*(?:module|file|class|package)\b/i,
    /\bsplit\s+.*\s+into\s+.*(?:modules?|files?|classes?|packages?)\b/i,
    /\bmerge\s+.*\s+(?:module|file|class)s?\b/i,
    /\bmove\s+.*\s+(?:to|into|from)\s+.*(?:file|module|directory|folder|package)\b/i,
    /\bwhole\s+(?:project|codebase|repo)\b/i,
];

// Non-trivial coding intent — anything beyond a one-liner tweak. If the
// message shows any of these signals, default is Pro tier (Sonnet/Opus/
// Gemini-Pro). Expanded beyond the multi-file list because "fix this
// race condition in auth.ts" is single-file but definitely not a
// one-liner — it still needs real reasoning.
const CODING_INTENT_PATTERNS: RegExp[] = [
    // Debugging / fixing
    /\b(?:debug|diagnose|fix|solve|resolve|troubleshoot|investigate)\s+(?:this|the|a|an|my)?\s*(?:bug|issue|error|problem|crash|failure|race|deadlock|leak)\b/i,
    /\bwhy\s+(?:is|isn'?t|does(?:n'?t)?|won'?t|can'?t)\b/i,
    /\bnot\s+working\b/i,
    // Building
    /\b(?:implement|build|create|add|write|design|architect)\s+(?:a|an|the|new)?\s*(?:feature|system|service|endpoint|api|function|class|module|component|page|hook|cli|daemon|worker|middleware|pipeline|handler|resolver)\b/i,
    // Tests
    /\b(?:write|add)\s+(?:a\s+)?tests?\s+for\b/i,
    /\bunit\s+tests?\b/i,
    // Performance
    /\b(?:optimize|improve)\s+(?:the|this|my)?\s*(?:performance|latency|speed|memory|throughput)\b/i,
    // Integration
    /\bintegrate\s+(?:with|into)\b/i,
    /\b(?:hook|wire)\s+(?:up|into)\b/i,
    // Review / audit
    /\b(?:review|audit|explain)\s+(?:this|the|my)\s+code\b/i,
    // Generic but coding-specific
    /\bmake\s+.*\s+(?:work|pass|compile|run)\b/i,
];

// Trivially-simple coding: one-off small edits that legitimately do not
// need Pro reasoning. Matches act as a DOWNGRADE permission even when
// the taskType is coding — callers that ask for "add a console.log",
// "rename foo to bar", "fix this typo" shouldn't burn Opus.
const CODING_TRIVIAL_PATTERNS: RegExp[] = [
    /\badd\s+(?:a\s+)?console\.log\b/i,
    /\badd\s+(?:a\s+)?print\s+statement\b/i,
    /\badd\s+(?:a\s+)?debug\s+log\b/i,
    /\bfix\s+(?:a\s+|the\s+|this\s+)?typo\b/i,
    // `rename x to y` is trivial ONLY when no cross-file scope follows.
    // "rename foo to bar across all files" → fall through to intent pattern.
    /\brename\s+\w+\s+to\s+\w+\b(?!.*\b(?:across|globally|everywhere|throughout|all\s+(?:files|callers|usages|references)))/i,
    /\b(?:change|update|bump)\s+(?:the\s+)?version\b/i,
    /\bcomment\s+out\b/i,
    /\bremove\s+(?:the\s+|this\s+)?(?:console\.log|print|debug|comment)\b/i,
    /\badd\s+(?:a\s+)?(?:todo|fixme|note)\b/i,
    /\bformat\s+(?:this|the)\s+(?:file|code)\b/i,
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
// Action verbs that indicate BUILD intent (not debug). Anchor for the
// high-stakes-domain gate: "implement auth" → complex (full design-docs),
// "debug auth" → standard (no PRD, just fix it).
const CODING_BUILD_VERB = /\b(?:implement|build|create|design|architect|write|develop|construct|scaffold|set\s+up|stand\s+up|spin\s+up)\b/i;

const CODING_COMPLEX_PATTERNS: RegExp[] = [
    // Multi-file / full-system indicators
    /\b(?:new|entire|whole|full)\s+(?:system|service|platform|pipeline|framework|backend|frontend|application|app)\b/i,
    /\b(?:refactor|migrate|rewrite)\s+(?:the|my|our)?\s*(?:entire|whole|full|major|large)\b/i,
    /\bfrom\s+scratch\b/i,
    /\bgreenfield\b/i,
    // Architecture-level
    /\b(?:design|architect|redesign)\s+(?:the|a|an|new)?\s*(?:system|service|architecture|schema|database|api)\b/i,
    /\bmicroservices?\b/i,
    /\bevent[- ]driven\b/i,
    // Heavy scope markers
    /\bproduction[- ]ready\b/i,
    /\bend[- ]to[- ]end\b/i,
    // User explicitly asking for the ceremony
    /\b(?:prd|spec|design\s+doc|design\s+document|technical\s+doc|architecture\s+doc)\b/i,
];

// High-stakes domains — only complex when combined with a build verb.
// "debug auth middleware" stays standard; "implement auth" goes complex.
const CODING_HIGH_STAKES_DOMAINS: RegExp[] = [
    /\b(?:auth|authn|authz|authentication|authorization|login|oauth|jwt|session|rbac|iam)\b/i,
    /\b(?:payment|billing|checkout|stripe|subscription|invoice|tax)\b/i,
    /\b(?:schema|migration|database|postgres|mysql|sqlite|dynamodb|mongodb)\b/i,
    /\b(?:encryption|crypto|kdf|tls|ssl|hash(?:ing)?|hmac)\b/i,
    /\b(?:security|pentest|vulnerabilit(?:y|ies)|exploit|injection|xss|csrf|ssrf)\b/i,
    /\bdata\s+privacy\b/i,
    /\bpii\b/i,
    /\bgdpr\b/i,
    /\b(?:kubernetes|k8s|helm|terraform|deployment|infra(?:structure)?|ci\s*\/?\s*cd)\b/i,
    /\bobservability\b/i,
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
    // 1. Trivial — short, clearly one-liner edits. Skip design-docs ceremony.
    if (isTriviallySimpleCoding(message)) return "trivial";
    // 2. Complex — matches a scope/architecture pattern, OR a BUILD verb +
    //    high-stakes domain + long message (>400 chars = user giving real
    //    context). "debug auth" (no build verb) stays standard.
    if (CODING_COMPLEX_PATTERNS.some((p) => p.test(message))) return "complex";
    if (message.length > 400 && CODING_BUILD_VERB.test(message) &&
        CODING_HIGH_STAKES_DOMAINS.some((p) => p.test(message))) {
        return "complex";
    }
    // 3. Default: standard — Pro tier, no PRD ceremony.
    return "standard";
}

const CODING_TOOL_NAMES: ReadonlySet<string> = new Set([
    "read", "edit", "write", "grep", "glob", "shell_exec",
    "code_action", "code_execute", "repo_map",
]);

// Browser tool names that require real reasoning — visual analysis, form
// fill, multi-step CAPTCHA, Figma/Canva, complex SPA navigation.
// When the agent is in a browser loop using these tools, escalate to Pro.
const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
    "browser_navigate", "browser_scan", "browser_click_at", "browser_click",
    "browser_type", "browser_scroll", "browser_hover", "browser_keyboard",
    "browser_extract", "browser_run_js", "browser_multi_action",
    "browser_video_control", "browser_handle_captcha", "browser_batch_fetch",
    "browser_intercept_start", "browser_intercept_read", "browser_extract_article",
    "browser_auto_scroll",
]);

// URLs / domains that always require vision + Pro tier
// (canvas-based design tools, maps, games — accessibility tree is nearly empty)
const VISION_ONLY_DOMAINS = /\b(figma\.com|canva\.com|miro\.com|lucid\.app|draw\.io|diagrams\.net|sketch\.com|framer\.com|webflow\.com|airtable\.com|notion\.so|retool\.com|linear\.app|maps\.google|earth\.google)\b/;

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

// ── Tool-synthesis escalation (Skill Forge) ──
// Tool synthesis is structurally a coding task: produce an exact JSON envelope
// with a working handler + tests. Forge's verifier loop runs against this
// LLM, so we pin it to Pro tier (Sonnet) by default; Track B opts into Opus
// for dream-replay batch synthesis via ATLAS_FORGE_DREAM_OPUS=true.
// Disable globally with ATLAS_NO_SYNTHESIS_ESCALATION=true.
export function maybeEscalateForSynthesis(
    base: ModelSelection,
    isDreamReplay: boolean = false,
): ModelSelection | null {
    if (process.env.ATLAS_NO_SYNTHESIS_ESCALATION === "true") return null;
    const tier = MODEL_REGISTRY[base.modelId]?.tier ?? 99;

    if (isDreamReplay) {
        // Track B — Sonnet + high thinking by default; ATLAS_FORGE_DREAM_OPUS opts into Opus + max.
        const wantOpus = process.env.ATLAS_FORGE_DREAM_OPUS === "true";
        const target = wantOpus
            ? Object.values(MODEL_REGISTRY).find((m) => m.tier === 0 && m.supportsTools !== false)
            : Object.values(MODEL_REGISTRY).find((m) => m.tier === 2 && m.supportsTools !== false);
        if (!target || tier <= target.tier) return null;
        const thinking = process.env.ATLAS_NO_SYNTHESIS_THINKING === "true"
            ? base.thinkingLevel
            : (wantOpus ? "max" : "high");
        return {
            ...base,
            modelId: target.id,
            displayName: target.displayName || target.id,
            thinkingLevel: thinking,
            reason: `${base.reason} → forge dream-replay (${target.displayName || target.id} + ${thinking})`,
        };
    }

    // Track A — Sonnet + high. Already Sonnet-or-better? Don't downgrade.
    if (tier <= 2) return null;
    const sonnet = Object.values(MODEL_REGISTRY).find((m) => m.tier === 2 && m.supportsTools !== false);
    if (!sonnet) return null;
    const thinking = process.env.ATLAS_NO_SYNTHESIS_THINKING === "true"
        ? base.thinkingLevel
        : "high";
    return {
        ...base,
        modelId: sonnet.id,
        displayName: sonnet.displayName || sonnet.id,
        thinkingLevel: thinking,
        reason: `${base.reason} → forge synthesis escalation`,
    };
}

export function selectForToolSynthesis(isDreamReplay: boolean = false): ModelSelection {
    const base = selectModel({ taskType: "tool_synthesis" });
    const escalated = maybeEscalateForSynthesis(base, isDreamReplay);
    return escalated ?? base;
}

/**
 * Browser automation escalation — parallel to maybeEscalateForCoding.
 *
 * Escalation logic:
 *   Light → Pro (Sonnet):   agent is in a browser tool loop (any browser_ tool call)
 *   Pro → Opus:             agent is stuck (20+ iterations OR 4+ errors in browser loop)
 *   Always Opus:            design-tool domains (Figma, Canva, Miro, etc.)
 *
 * Rationale: browser tasks require spatial reasoning (clicking correct elements),
 * multi-step planning (form flows, CAPTCHA, infinite scroll), and visual understanding
 * (Figma/Canva). Haiku routinely fails at these, wasting 30+ iterations before giving up.
 */
export function maybeEscalateForBrowser(
    base: ModelSelection,
    message: string,
    iteration: number,
    errorCount: number,
    lastToolCalls?: Array<{ function: { name: string } }>,
): ModelSelection | null {
    const currentTier = MODEL_REGISTRY[base.modelId]?.tier ?? 99;

    // Already on Opus — nothing to escalate to
    const isInBrowserLoop = !!lastToolCalls && lastToolCalls.some(t => BROWSER_TOOL_NAMES.has(t.function.name));
    const isDesignTool = VISION_ONLY_DOMAINS.test(message);

    // Not a browser task at all
    if (!isInBrowserLoop && !isDesignTool) return null;

    // Find Pro (Sonnet) and Heavy (Opus) models
    const sonnet = Object.values(MODEL_REGISTRY).find(m => m.tier === 2 && m.supportsTools !== false);
    const opus   = Object.values(MODEL_REGISTRY).find(m => m.tier === 0 && m.supportsTools !== false);

    // Design tools (Figma, Canva, Miro) → always Opus + vision task type
    // They have almost no accessibility tree; need visual grounding every step.
    if (isDesignTool) {
        const model = opus || sonnet;
        if (!model || currentTier <= (opus ? 0 : 2)) return null;
        return {
            ...base,
            modelId: model.id,
            displayName: model.displayName || model.id,
            taskType: "vision" as TaskType,
            thinkingLevel: "medium",
            reason: `${base.reason} → design-tool escalation (visual reasoning required)`,
        };
    }

    // Stuck browser loop — many iterations without resolution → Opus
    const isStuck = iteration >= 20 || errorCount >= 4;
    if (isStuck && (opus || sonnet)) {
        const model = (errorCount >= 4 ? opus : sonnet) || opus || sonnet;
        if (!model || currentTier <= (model.tier ?? 99)) return null;
        return {
            ...base,
            modelId: model.id,
            displayName: model.displayName || model.id,
            thinkingLevel: errorCount >= 4 ? "medium" : base.thinkingLevel,
            reason: `${base.reason} → browser stuck escalation (iter=${iteration}, errors=${errorCount})`,
        };
    }

    // Normal browser loop — Light → Pro (Sonnet)
    if (isInBrowserLoop && currentTier > PRO_TIER_CEILING && sonnet) {
        return {
            ...base,
            modelId: sonnet.id,
            displayName: sonnet.displayName || sonnet.id,
            reason: `${base.reason} → browser loop escalation`,
        };
    }

    return null;
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
