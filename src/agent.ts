// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { checkAccountStatus, getKnownCreditBalance, getSessionCreditStats } from "./account-guard.js";
import { injectSystemReminder } from "./agent/system-reminders.js";
import {
    recordFailure as cbRecordFailure,
    recordNoProgress as cbRecordNoProgress,
    recordProgress as cbRecordProgress,
    createCircuitBreaker,
    getStatusMessage,
    shouldTrip,
    tryHalfOpen,
} from "./agents/circuit-breaker.js";
import { classifyComplexity } from "./agents/complexity-classifier.js";
import { listActiveLongTasks } from "./agents/long-task.js";
import { assess, createMetacognitionState, updateSignals } from "./agents/metacognition.js";
import {
    enterPlanMode,
    filterToolsForAwaitingApproval,
    filterToolsForPlanMode,
    filterToolsForSpecMode,
    isAwaitingApproval,
    isPlanMode,
    isSpecMode,
    planModeReminderBody,
} from "./agents/plan-mode.js";
import { offloadIfLarge } from "./agents/tool-output-offload.js";
import type { ChatCompletionMessageParam, LLMClient, ThinkingLevel } from "./llm.js";
import { MODEL_DISPLAY, MODELS } from "./llm.js";
import { getLocationSnippet, getTimezone } from "./location/index.js";
import { getAnticipationSnippet, trackSessionForAnticipation } from "./memory/anticipation.js";
import { generateMemoryBriefing, USE_MEMORY_BRIEFING } from "./memory/briefing.js";
import { classifyQuery } from "./memory/classifier.js";
import { pruneContext } from "./memory/context-pruning.js";
import { getEmotionalContextSnippet } from "./memory/emotional.js";
import { getEpisodicSnippet } from "./memory/episodic.js";
import { createGoal, detectGoalFromMessage, getGoalsSnippet } from "./memory/goals.js";
import { getIdentityPromptSnippet } from "./memory/identity.js";
import { findEntities, getKnowledgeGraphDB } from "./memory/knowledge-graph.js";
import { getProjectMemorySnippet } from "./memory/project-memory.js";
import { runReflection } from "./memory/reflection.js";
import { getRelationshipSnippet } from "./memory/relationship.js";
import { getSelfModelSnippet, recordOutcome as recordSelfModelOutcome } from "./memory/self-model.js";
import { getSelfStateSnippet } from "./memory/self-state.js";
import { appendTurn, getSessionSummary, shouldReflect, touchSession } from "./memory/session.js";
// ── Dynamic Context Injections ────────────────
import { getCoreMemory, recall, recallConversation, remember } from "./memory/sqlite.js";
import { getStrategyContext, saveStrategy } from "./memory/strategy-library.js";
import { getTaskLearningsContext } from "./memory/task-learnings.js";
import { getTraitsForInjection, resetSessionTraitCaps } from "./memory/traits.js";
import { getUserModelSnippet } from "./memory/user-model.js";
import { getWMSnippet, reflect as wmReflect, retain as wmRetain } from "./memory/working-memory.js";
import { recordFailure as recordWorldFailure, recordSuccess as recordWorldSuccess } from "./memory/world-model.js";
import {
    getCascadeNext,
    type ModelSelection,
    recordQualityFailure,
    selectForAgent,
    selectForFinalAnswer,
    shouldCascadeEscalate,
    updateToolStats,
} from "./model-router.js";
import { detectTaskType } from "./prompts/dynamic-assembler.js";
import {
    clearToolRouterState,
    getLastIntent,
    handleToolRequest,
    isRequestToolsCall,
    selectTools,
    selectToolsFast,
} from "./tool-router.js";
import {
    getPreferredTools,
    recordIntentToolUsage,
    recordToolFailure,
    recordToolRecovery,
    recordToolSuccess,
} from "./tool-router-analytics.js";
import { autoSaveSession, getBrowserContext, trackBrowserStep } from "./tools/browser-memory.js";
import { clearCache, executeTool, resetRateLimits } from "./tools/index.js";
import { startTrace, finalizeTrace, recordToolsSelected, recordContextSources, recordMemoryHit } from "./harness/trace-store.js";
import { runWithEvalTraceId } from "./agents/evaluator.js";
import { getDimensionValue } from "./harness/registry.js";

// ── Music fast-path helpers ──────────────────────
// Short-circuits the Sonnet orchestrator + heavy memory briefing when the LLM
// classifier is highly confident the user is asking for simple music playback.
// Fails open: any misfire falls through to the normal agent path.

// Match the classifier's actual intent labels for music playback. Handles spaces
// OR underscores (e.g. "play music track" and "play_music_track"). Covers the
// common variants observed in production: play_music, play_song, music_playback,
// music_control, play, pause, resume, next/previous/skip, volume, shuffle,
// repeat, now_playing.
const MUSIC_INTENT_PATTERN =
    /^(play[_ ]?music|play[_ ]?song|music[_ ]?(playback|control|play)|play$|play[_ ]|pause|resume|next|previous|skip|volume|shuffle|repeat|now[_ ]?playing)/i;
const MUSIC_POSSESSIVE_PATTERN = /\b(my|our|the one|that|favorite|fav|usual|go[- ]?to|mine)\b/i;
const SPOTIFY_URI_PATTERN = /spotify:(track|album|playlist|artist):[A-Za-z0-9]+/;

interface MusicFastPathContext {
    musicMemoryHint?: string;
    resolvedUri?: string;
}

/**
 * True iff the current turn is a simple, high-confidence music-playback command.
 * When this returns true, the agent skips the Sonnet orchestrator, the
 * full memory briefing, and the auto-verification loop.
 */
function isMusicFastPathEligible(opts: {
    userMessage: string;
    iteration: number;
    inPlanMode: boolean;
    classification: { intent: string; specific_tools: string[]; confidence: number; categories: string[] } | null;
}): boolean {
    if (opts.iteration !== 1) return false; // only first iteration of a turn
    if (opts.inPlanMode) return false;

    const trimmed = opts.userMessage.trim();
    if (trimmed.length === 0 || trimmed.length > 80) return false;

    const cls = opts.classification;
    if (!cls) return false; // structural fallback fired — not confident enough
    if (cls.confidence < 0.9) return false;
    if (!MUSIC_INTENT_PATTERN.test(cls.intent)) return false;

    const tools = cls.specific_tools || [];
    if (tools.length !== 1) return false;
    if (tools[0] !== "spotify" && tools[0] !== "music_control") return false;

    return true;
}

/**
 * Cheap, bounded memory lookup for possessive/reference music queries
 * ("play my favorite song"). Returns a hint to inject into the agent's system
 * context — or an empty context if nothing useful was found or the budget
 * exceeded.
 */
async function musicMemoryPeek(userMessage: string, llmForRecall: LLMClient): Promise<MusicFastPathContext> {
    if (!MUSIC_POSSESSIVE_PATTERN.test(userMessage)) return {};

    try {
        const searchPromise = recall(`${userMessage} music song`, 3, llmForRecall, "llm_only");
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500));
        const results = await Promise.race([searchPromise, timeoutPromise]);
        if (!results || !Array.isArray(results) || results.length === 0) return {};

        const snippets: string[] = [];
        let resolvedUri: string | undefined;
        for (const r of results) {
            const content = typeof r.content === "string" ? r.content : "";
            if (!content) continue;
            const uriMatch = content.match(SPOTIFY_URI_PATTERN);
            if (uriMatch && !resolvedUri) resolvedUri = uriMatch[0];
            snippets.push(content.substring(0, 160));
            if (snippets.join(" ").length > 300) break;
        }

        if (resolvedUri) {
            return {
                musicMemoryHint: `[Music Memory Hint] User has previously tagged this: ${resolvedUri}. Pass it directly as uri.\n${snippets.join("\n").substring(0, 260)}`,
                resolvedUri,
            };
        }
        if (snippets.length > 0) {
            return { musicMemoryHint: `[Music Memory Hint]\n${snippets.join("\n").substring(0, 300)}` };
        }
        return {};
    } catch {
        return {};
    }
}

// Cheap synchronous heuristic used BEFORE the LLM classifier has run. It's used
// only to skip the expensive memory briefing — any false positive here just
// means the user gets a lighter memory context on a non-music turn, not a
// broken agent. Keep it conservative to minimise those misses.
const MUSIC_HEURISTIC_PATTERN =
    /\b(play|pause|resume|skip|next|previous|shuffle|repeat|queue|playlist|spotify|apple[- ]?music|song|track|album|artist|now[- ]?playing|volume up|volume down)\b/i;

function isLikelyMusicCommand(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (trimmed.length === 0 || trimmed.length > 120) return false;
    return MUSIC_HEURISTIC_PATTERN.test(trimmed);
}

// ── Constants ─────────────────────────────────

/** Hermes Agent periodic nudge interval: every N iterations, prompt the agent to persist valuable information. */
const MEMORY_NUDGE_INTERVAL = 5;

// ── Browser tool names ────────────────────────

const BROWSER_TOOLS = new Set([
    "browser_navigate",
    "browser_click_at",
    "browser_type",
    "browser_scan",
    "browser_extract",
    "browser_back",
    "browser_scroll",
    "browser_analyze",
    "browser_run_js",
    "browser_wait",
    "browser_select",
    "browser_right_click",
    "browser_hold_click",
    "browser_drag",
    "browser_hover",
    "browser_keyboard",
    "browser_switch_tab",
    "browser_upload_file",
    "browser_save_strategy",
    "browser_recall_strategy",
    "browser_parallel_tabs",
    "browser_parallel_actions",
    "browser_multi_action",
]);

const HARD_DECISION_TOOLS = new Set(["web_search", "shell_exec", "memory_store"]);

/** Tools whose results don't affect conversation flow — executed in background, synthetic success returned immediately */
const DEFERRABLE_TOOLS = new Set(["memory_store"]);

/** Strip internal debug tags and LLM artifacts from responses before returning to channels */
function sanitizeAgentResponse(text: string): string {
    return text
        .replace(/<system_log>[\s\S]*?<\/system_log>/g, "")
        .replace(/<tool_log[\s\S]*?<\/tool_log>/g, "")
        .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
        .replace(/\[NO_REPLY\]/gi, "")
        .replace(/\[no_reply\]/gi, "")
        .replace(/\[SOURCE:.*?\]/gs, "")
        .trim();
}

// ── Milestone tool descriptions ───────────────

const MILESTONE_DESCRIPTIONS: Record<string, (args: Record<string, unknown>) => string> = {
    browser_navigate: (a) => `🌐 Opening ${((a.url as string) || "").substring(0, 60)}...`,
    web_search: (a) => `🔍 Searching: "${a.query || ""}"`,
    shell_exec: (a) => `⚙️ Running command: ${((a.command as string) || "").substring(0, 50)}`,
    browser_scan: () => `🔍 Scanning the active browser page DOM...`,
    browser_analyze: () => `🔎 Analyzing page elements...`,
    browser_run_js: () => `📊 Extracting data from the page...`,
    browser_save_strategy: (a) => `💾 Saving strategy: "${a.task_pattern || ""}"`,
    write: (a) => `📝 Writing file: ${a.file_path || ""}`,
    edit: (a) => `✏️  Editing: ${a.file_path || ""}`,
    read: (a) => `📖 Reading: ${a.file_path || ""}`,
    append_file: (a) => `➕ Appending to: ${a.file_path || ""}`,
    grep: (a) => `🔎 Searching: "${a.pattern || ""}"`,
    glob: (a) => `📂 Finding files: "${a.pattern || ""}"`,
    memory_store: (a) => `🧠 Remembering: "${((a.content as string) || "").substring(0, 40)}"`,
    browser_parallel_tabs: (a) =>
        `🔀 Processing ${Array.isArray(a.tab_actions) ? a.tab_actions.length : 0} tabs in parallel...`,
};

// ── Tool Result Truncation ────────────────────
// Prevent bloated context from verbose tool outputs (browser scans, extracts, etc.)

const TOOL_RESULT_LIMITS: Record<string, number> = {
    browser_scan: 2000,
    browser_extract: 3000,
    browser_analyze: 2500,
    browser_run_js: 3000,
    shell_exec: 4000,
    read: 5000,
    grep: 4000,
    glob: 2000,
    deep_research: 6000,
};
const DEFAULT_RESULT_LIMIT = 4000;

function truncateToolResult(toolName: string, result: string): string {
    const limit = TOOL_RESULT_LIMITS[toolName] ?? DEFAULT_RESULT_LIMIT;
    if (result.length <= limit) return result;
    return `${result.substring(0, limit)}\n[... truncated from ${result.length} chars]`;
}

// ── Turn ID for offload grouping ─────────────
// A monotonic string identifier incremented each time runAgent is called.
// Used to group offloaded tool outputs on disk by conversation turn.
let _turnCounter = 0;
let _currentTurnId = `boot-${Date.now()}`;
function currentTurnId(): string {
    return _currentTurnId;
}
function nextTurnId(): string {
    _turnCounter++;
    _currentTurnId = `turn-${Date.now()}-${_turnCounter}`;
    return _currentTurnId;
}

// ── Diff preview formatter ───────────────────
// After `edit`/`write` completes, surface a compact preview so the user
// can see what changed. Returns null for tools that don't produce diffs,
// or when the result lacks a usable preview.

const DIFF_PREVIEW_LINE_CAP = 20;

function formatDiffPreview(toolName: string, result: string): string | null {
    try {
        if (toolName !== "edit" && toolName !== "write") return null;
        const parsed = JSON.parse(result);
        if (!parsed || typeof parsed !== "object" || parsed.success !== true) return null;
        const filePath = typeof parsed.path === "string" ? parsed.path : undefined;

        if (toolName === "edit") {
            const preview = typeof parsed.preview === "string" ? parsed.preview : "";
            if (!preview) return null;
            const lines = preview.split("\n");
            const shown = lines.slice(0, DIFF_PREVIEW_LINE_CAP).join("\n");
            const tail =
                lines.length > DIFF_PREVIEW_LINE_CAP
                    ? `\n... (${lines.length - DIFF_PREVIEW_LINE_CAP} more lines)`
                    : "";
            return `📝 Edited ${filePath || "file"}\n\`\`\`diff\n${shown}${tail}\n\`\`\``;
        }

        // write
        const bytes = Number(parsed.bytes) || 0;
        const created = parsed.created === true;
        return `${created ? "✨ Created" : "📝 Rewrote"} ${filePath || "file"} (${bytes} bytes)`;
    } catch {
        return null;
    }
}

// ── Types ─────────────────────────────────────

export type ProgressCallback = (message: string) => Promise<void>;

export interface AgentResponse {
    text: string;
    toolCalls: number;
}

export interface ChannelContext {
    channel:
        | "telegram"
        | "whatsapp"
        | "discord"
        | "slack"
        | "overlay"
        | "email"
        | "matrix"
        | "web-widget"
        | "chrome-extension"
        | string;
    userId: string;
    userName?: string;
    isOwner: boolean;
    contactProfile?: any; // WhatsApp ContactProfile
}

// ── Session State ─────────────────────────────

let conversationHistory: ChatCompletionMessageParam[] = [];
const MAX_CONVERSATION_HISTORY = 200; // Hard cap to prevent unbounded memory growth
let _thinkingLevel: ThinkingLevel = "low"; // Default: always think

export function setThinkingLevel(level: string): void {
    _thinkingLevel = level as ThinkingLevel;
}

export function getConversationCount(): number {
    return conversationHistory.filter((m) => m.role === "user").length;
}

export function clearConversation(): void {
    conversationHistory = [];
    clearCache(); // Flush stale tool result cache
    resetRateLimits(); // Reset rate limit buckets
    clearToolRouterState(); // Reset tool router requested categories
}

export function getConversationHistory(): ChatCompletionMessageParam[] {
    return conversationHistory;
}

export function setConversationHistory(msgs: ChatCompletionMessageParam[]): void {
    conversationHistory = msgs;
}

// ── Conversation Context for Tool Router ─────
// Builds a short summary of recent turns so the tool router can disambiguate
// references like "open the file manager" (OS app vs website button).

function buildToolRouterContext(messages: ChatCompletionMessageParam[]): string {
    // Take last 6 messages (~3 user/assistant pairs) — enough context without bloating the classifier prompt
    const recent = messages.slice(-6);
    const lines: string[] = [];
    for (const msg of recent) {
        if (msg.role === "user" && typeof msg.content === "string") {
            // Strip overlay source tags for cleaner context
            const clean = msg.content.replace(/\[SOURCE:.*?\]/gs, "").trim();
            lines.push(`User: ${clean.substring(0, 100)}`);
        } else if (msg.role === "assistant" && typeof msg.content === "string") {
            // Only first sentence of assistant response — keep it compact
            const first = msg.content
                .replace(/<[^>]+>/g, "")
                .split(/[.!?\n]/)[0]
                ?.trim()
                .substring(0, 80);
            if (first) lines.push(`Assistant: ${first}`);
        }
        // Skip tool_call/tool_result messages — too verbose for the classifier
    }
    return lines.join("\n");
}

// ── Smart Model Selection ─────────────────────
// Uses the intelligent model router for optimal cost/quality/speed

function chooseModel(
    iteration: number,
    lastToolCalls?: Array<{ function: { name: string } }>,
    errorCount: number = 0,
    modelHint?: "simple" | "complex",
    userMessage?: string,
    hasMedia?: boolean,
): ModelSelection {
    // Browser/OS tool override is handled by the Rust router (model_router.rs:1488-1501)
    // No need to duplicate it here — the router checks circuit breaker state too
    return selectForAgent(userMessage || "", iteration, errorCount, modelHint, lastToolCalls, hasMedia);
}

// ── Progress Helpers ──────────────────────────

function getMilestoneMessage(toolName: string, args: Record<string, unknown>): string | null {
    const fn = MILESTONE_DESCRIPTIONS[toolName];
    return fn ? fn(args) : null;
}

function getErrorMessage(toolName: string, result: string): string | null {
    try {
        const parsed = JSON.parse(result);
        if (parsed.error) {
            return `⚠️ ${toolName} failed: ${(parsed.error as string).substring(0, 80)}. Trying another approach...`;
        }
    } catch {
        /* not JSON */
    }
    return null;
}

// ── Tool Execution Helpers ────────────────────

interface ToolCallResult {
    toolCallId: string;
    fnName: string;
    fnArgs: Record<string, unknown>;
    result: string;
    finalContent: string | Array<Record<string, unknown>>;
    isBrowser: boolean;
    isError: boolean;
}

/**
 * Create a synthetic success result for a deferred (fire-and-forget) tool call.
 */
function createSyntheticDeferredResult(toolCall: {
    id: string;
    function: { name: string; arguments: string };
}): ToolCallResult {
    const fnName = toolCall.function.name;
    let fnArgs: Record<string, unknown> = {};
    try {
        fnArgs = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
        fnArgs = {};
    }
    const result = JSON.stringify({ success: true, deferred: true, message: "Saved." });
    return { toolCallId: toolCall.id, fnName, fnArgs, result, finalContent: result, isBrowser: false, isError: false };
}

/**
 * Execute a single tool call and process the result (screenshot extraction, error detection).
 */
async function executeAndProcessToolCall(
    toolCall: { id: string; function: { name: string; arguments: string } },
    onToolRequest?: (request: { capability: string; reason: string }) => Promise<string>,
    userMessage?: string,
    toolAllowlist?: string[],
): Promise<ToolCallResult> {
    const fnName = toolCall.function.name;
    let fnArgs: Record<string, unknown> = {};
    try {
        fnArgs = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
        fnArgs = {};
    }

    // ── Hard block: reject tools not in the allowlist (defense-in-depth) ──
    if (toolAllowlist && toolAllowlist.length > 0 && !new Set(toolAllowlist).has(fnName)) {
        return {
            toolCallId: toolCall.id,
            fnName,
            fnArgs,
            result: JSON.stringify({ error: `Tool "${fnName}" is restricted in this context.` }),
            finalContent: JSON.stringify({ error: `Tool "${fnName}" is restricted in this context.` }),
            isBrowser: false,
            isError: true,
        };
    }

    // Inject original user prompt for tools that support continuation (e.g. deep_research)
    if (fnName === "deep_research" && userMessage) {
        fnArgs._originalPrompt = userMessage;
    }

    // ── Handle request_tools meta-tool (bidirectional router communication) ──
    if (isRequestToolsCall(fnName) && onToolRequest) {
        const result = await onToolRequest({
            capability: (fnArgs.capability as string) || "",
            reason: (fnArgs.reason as string) || "",
        });
        console.log(`  🔧 Tool call: ${fnName}`, JSON.stringify(fnArgs));
        console.log(`  ✅ Tool result: ${result.substring(0, 500)}`);
        return {
            toolCallId: toolCall.id,
            fnName,
            fnArgs,
            result,
            finalContent: result,
            isBrowser: false,
            isError: false,
        };
    }

    console.log(`  🔧 Tool call: ${fnName}`, JSON.stringify(fnArgs));
    let rawResult = await executeTool(fnName, fnArgs);

    // ── Self-heal: if tool failed with a dependency error, auto-fix and retry ──
    let isError = false;
    try {
        const p = JSON.parse(rawResult);
        if (p.error) isError = true;
    } catch {
        /* not json */
    }
    if (isError) {
        try {
            const { attemptSelfHeal } = await import("./agents/self-heal.js");
            const heal = await attemptSelfHeal(rawResult);
            if (heal.fixed) {
                console.log(`  🔧 Self-healed (${heal.action}) — retrying ${fnName}`);
                rawResult = await executeTool(fnName, fnArgs);
                isError = false;
                try {
                    const p = JSON.parse(rawResult);
                    if (p.error) isError = true;
                } catch {
                    /* not json */
                }
            }
        } catch {
            /* self-heal module not loaded — continue normally */
        }
    }

    // Large-output offload: if the raw result is over the offload threshold,
    // save the full content to disk and replace it with a preview + file path.
    // The `read` tool can fetch the full file later if the model needs it.
    let workingResult = rawResult;
    try {
        const offloaded = offloadIfLarge(fnName, toolCall.id, currentTurnId(), rawResult);
        workingResult = offloaded.content;
    } catch {
        /* offload failure leaves workingResult = rawResult */
    }

    const result = truncateToolResult(fnName, workingResult);
    console.log(`  ✅ Tool result: ${result.substring(0, 500)}`);

    const isBrowser = BROWSER_TOOLS.has(fnName);

    // Treat screenshot payload as native image block
    let finalContent: string | Array<Record<string, unknown>> = result;
    try {
        const parsed = JSON.parse(result);
        if (parsed.screenshot_base64) {
            const b64 = parsed.screenshot_base64;
            const mimeType = parsed.mime_type || "image/png";
            delete parsed.screenshot_base64;
            delete parsed.mime_type;
            parsed.image_attached = true;

            finalContent = [
                { type: "text", text: JSON.stringify(parsed) },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
            ];
        }
    } catch {
        /* not json */
    }

    return { toolCallId: toolCall.id, fnName, fnArgs, result, finalContent, isBrowser, isError };
}

/**
 * Execute a batch of tool calls with intelligent parallelization.
 * Browser tools run sequentially (shared page state).
 * Non-browser tools run in parallel for speed.
 */
async function executeToolCallsBatch(
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
    ctx: {
        sendProgress: (msg: string) => Promise<void>;
        trackBrowserFn: (fnName: string, fnArgs: Record<string, unknown>, success: boolean) => void;
        onError: () => void;
        onToolComplete: (count: number) => Promise<void>;
        onToolRequest?: (request: { capability: string; reason: string }) => Promise<string>;
        userMessage?: string;
        toolAllowlist?: string[];
    },
): Promise<ToolCallResult[]> {
    // Separate browser, non-browser, and deferrable tool calls while preserving order
    const browserCalls: typeof toolCalls = [];
    const nonBrowserCalls: typeof toolCalls = [];
    const deferrableCalls: typeof toolCalls = [];

    for (const tc of toolCalls) {
        const fnName = tc.function.name;
        if (BROWSER_TOOLS.has(fnName)) {
            browserCalls.push(tc);
        } else if (DEFERRABLE_TOOLS.has(fnName)) {
            deferrableCalls.push(tc);
        } else {
            nonBrowserCalls.push(tc);
        }
    }

    const results: ToolCallResult[] = [];

    // Fire deferrable tools in background (don't await — synthetic results returned immediately)
    const deferredResults: ToolCallResult[] = [];
    for (const tc of deferrableCalls) {
        console.log(`  🔧 Tool call: ${tc.function.name} (deferred)`, tc.function.arguments?.substring(0, 200));
        // Track the promise to prevent unhandled rejections
        const promise = executeAndProcessToolCall(tc, ctx.onToolRequest, ctx.userMessage, ctx.toolAllowlist)
            .then((r) => {
                const preview = r.result ? r.result.substring(0, 200) : "(empty)";
                console.log(`  ✅ Deferred tool ${r.fnName} completed: ${preview}`);
            })
            .catch((err) => console.error(`  ❌ Deferred tool ${tc.function.name} failed: ${(err as Error).message}`));
        // Ensure the promise is tracked to avoid unhandled rejection warnings
        void promise;
        deferredResults.push(createSyntheticDeferredResult(tc));
    }

    // Fire all non-browser tools in parallel (with 120s safety timeout)
    const TOOL_BATCH_TIMEOUT_MS = 120_000;
    const nonBrowserPromise =
        nonBrowserCalls.length > 0
            ? Promise.race([
                  Promise.all(
                      nonBrowserCalls.map((tc) =>
                          executeAndProcessToolCall(tc, ctx.onToolRequest, ctx.userMessage, ctx.toolAllowlist),
                      ),
                  ),
                  new Promise<ToolCallResult[]>((_, reject) =>
                      setTimeout(
                          () => reject(new Error(`Tool batch timed out after ${TOOL_BATCH_TIMEOUT_MS / 1000}s`)),
                          TOOL_BATCH_TIMEOUT_MS,
                      ),
                  ),
              ]).catch((err) => {
                  console.error(`  ⚠️ Non-browser tool batch error: ${(err as Error).message}`);
                  return nonBrowserCalls.map((tc) => ({
                      toolCallId: tc.id,
                      fnName: tc.function.name,
                      fnArgs: {} as Record<string, unknown>,
                      result: JSON.stringify({ error: (err as Error).message }),
                      finalContent: JSON.stringify({ error: (err as Error).message }),
                      isBrowser: false,
                      isError: true,
                  }));
              })
            : Promise.resolve([] as ToolCallResult[]);

    // Run browser tools sequentially (they share a page)
    const browserResults: ToolCallResult[] = [];
    for (const tc of browserCalls) {
        const fnArgs: Record<string, unknown> = {};
        try {
            Object.assign(fnArgs, JSON.parse(tc.function.arguments || "{}"));
        } catch {
            /* */
        }
        const milestone = getMilestoneMessage(tc.function.name, fnArgs);
        if (milestone) await ctx.sendProgress(milestone);

        const r = await executeAndProcessToolCall(tc, ctx.onToolRequest, undefined, ctx.toolAllowlist);
        browserResults.push(r);

        // Track browser step immediately
        ctx.trackBrowserFn(r.fnName, r.fnArgs, !r.isError);
        if (r.isError) ctx.onError();
    }

    // Await non-browser tools (may already be done)
    const nonBrowserResults = await nonBrowserPromise;

    // Send milestones for non-browser tools (after they complete)
    for (const r of nonBrowserResults) {
        const milestone = getMilestoneMessage(r.fnName, r.fnArgs);
        if (milestone) await ctx.sendProgress(milestone);

        // Diff preview for edit/write: surface the change so the user can
        // see what happened. Not a blocking approval gate (which would
        // require two-way channel coordination) — this is pure visibility.
        if (process.env.ENABLE_DIFF_PREVIEW !== "false" && !r.isError) {
            const previewMsg = formatDiffPreview(r.fnName, r.result);
            if (previewMsg) await ctx.sendProgress(previewMsg);
        }

        if (r.isError) ctx.onError();
    }

    // Merge results back in the original tool call order
    const resultMap = new Map<string, ToolCallResult>();
    for (const r of [...browserResults, ...nonBrowserResults, ...deferredResults]) {
        resultMap.set(r.toolCallId, r);
    }
    for (const tc of toolCalls) {
        const r = resultMap.get(tc.id);
        if (r) results.push(r);
    }

    return results;
}

// ── Agent Loop ────────────────────────────────

export interface MediaAttachment {
    type: "image" | "video" | "audio";
    base64: string;
    mimeType: string;
}

export async function runAgent(
    llm: LLMClient,
    userMessage: string,
    onProgress?: ProgressCallback,
    media?: MediaAttachment[],
    signal?: AbortSignal,
    historyFork?: ChatCompletionMessageParam[],
    modelHint?: "simple" | "complex",
    toolAllowlist?: string[],
    channelContext?: ChannelContext,
): Promise<AgentResponse> {
    const isForked = !!historyFork;
    // Skip tracing for forked calls; enter ALS context for owner calls so evaluate()
    // reads the right trace ID even when multiple channels run concurrently.
    if (!isForked) {
        const _earlyTraceId = startTrace(channelContext?.channel || "default",
            userMessage.replace(/\n*\[SOURCE:.*\]$/s, "").trim(), 0);
        return runWithEvalTraceId(_earlyTraceId, () => _runAgentBody(
            llm, userMessage, onProgress, media, signal, historyFork, modelHint, toolAllowlist, channelContext, _earlyTraceId
        )).catch((err: unknown) => {
            // Ensure trace is finalized even on uncaught exceptions
            if (_earlyTraceId) finalizeTrace(_earlyTraceId, false);
            throw err;
        });
    }
    return _runAgentBody(llm, userMessage, onProgress, media, signal, historyFork, modelHint, toolAllowlist, channelContext, null);
}

async function _runAgentBody(
    llm: LLMClient,
    userMessage: string,
    onProgress: ProgressCallback | undefined,
    media: MediaAttachment[] | undefined,
    signal: AbortSignal | undefined,
    historyFork: ChatCompletionMessageParam[] | undefined,
    modelHint: "simple" | "complex" | undefined,
    toolAllowlist: string[] | undefined,
    channelContext: ChannelContext | undefined,
    _injectedTraceId: string | null,
): Promise<AgentResponse> {
    const isForked = !!historyFork;

    // True when serving a non-owner contact (e.g. WhatsApp persona).
    // In this mode all owner-personal memory injection is skipped — the
    // historyFork already supplies the contact's context and we must not
    // leak the owner's identity, memories, location, or traits.
    const isContactAgent = isForked && channelContext?.isOwner === false;

    // Tag every runAgent invocation with a unique turn id so offloaded
    // tool outputs cluster per turn on disk.
    if (!isForked) nextTurnId();

    // Tell tools which channel produced this turn so they can deliver back
    // on the same channel. Cleared in finally below.
    if (channelContext?.channel) {
        const { setActiveChannel } = await import("./tools/channel-send.js");
        setActiveChannel(channelContext.channel);
    }

    // Trace ID injected by the outer runAgent wrapper (already started + in ALS context).
    const _harnessTraceId = _injectedTraceId;

    // ── Account Gate ──────────────────────────
    // Check if account is active and has credits before processing
    if (true) {
        const accountStatus = await checkAccountStatus();
        if (!accountStatus.allowed) {
            const errorMsg = `⛔ ${accountStatus.reason || "Your ATLAS account cannot process messages right now."}`;
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
            return { text: errorMsg, toolCalls: 0 };
        }
    }

    // Smart tool selection — dynamically updated each iteration
    let activeCategories: string[] | undefined;
    let requestedCategories: string[] | undefined;

    // Strip [SOURCE: ...] tags for classification/routing — the overlay appends
    // these to every message, inflating word count and breaking simple-message detection.
    // The full tagged message is still sent to the LLM for context.
    const rawUserMessage = userMessage.replace(/\n*\[SOURCE:.*\]$/s, "").trim();


    // ── Goal detection: check if user mentioned a goal ──
    try {
        const detectedGoal = detectGoalFromMessage(rawUserMessage);
        if (detectedGoal) {
            createGoal(detectedGoal.description, detectedGoal.deadline ?? undefined);
            console.log(`  🎯 Goal detected: "${detectedGoal.description}"`);
        }
    } catch {
        /* non-fatal */
    }

    // When running on a fork, use the fork instead of global history
    let workingHistory = historyFork || conversationHistory;

    // Helper: fire async reflection if needed (non-blocking)
    const maybeReflect = () => {
        if (!isForked && shouldReflect()) {
            console.log(`  🔄 Triggering async reflection (periodic)`);
            runReflection(llm, [...workingHistory]).catch((err) => console.error("Reflection error (non-fatal):", err));
        }
    };

    // Build user message — multimodal if media attached
    if (media && media.length > 0) {
        const content: Array<Record<string, unknown>> = [];
        if (userMessage) {
            content.push({ type: "text", text: userMessage });
        }
        for (const m of media) {
            if (m.type === "audio") {
                // Audio: use input_audio content part
                content.push({
                    type: "input_audio",
                    input_audio: { data: m.base64, format: m.mimeType.split("/")[1] || "ogg" },
                });
            } else {
                // Image/Video: use image_url with data URI
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${m.mimeType};base64,${m.base64}` },
                });
            }
        }
        workingHistory.push({ role: "user", content: content as unknown as string });

        // ── Multimodal Memory: store image embeddings for cross-modal retrieval ──
        try {
            const { storeImageEmbedding } = await import("./memory/multimodal-embedding.js");
            const { embedText } = await import("./memory/embeddings.js");
            for (const m of media) {
                if (m.type === "image") {
                    // Embed the text context associated with the image
                    const description = userMessage || "image attachment";
                    const embedding = await embedText(description, "document");
                    const imageId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    storeImageEmbedding(imageId, embedding, description);
                    console.log(`  📸 Stored multimodal embedding for image: ${imageId}`);
                }
            }
        } catch (mmErr) {
            console.warn("[AGENT] Multimodal memory storage failed (non-fatal):", (mmErr as Error).message);
        }
    } else {
        workingHistory.push({ role: "user", content: userMessage });
    }

    // Hard cap: prevent conversationHistory from growing unbounded (memory leak prevention)
    if (!isForked && workingHistory.length > MAX_CONVERSATION_HISTORY) {
        // Keep system messages at the start, then trim oldest non-system messages
        const systemMsgs = workingHistory.filter((m) => m.role === "system");
        const nonSystemMsgs = workingHistory.filter((m) => m.role !== "system");
        const keepCount = MAX_CONVERSATION_HISTORY - systemMsgs.length;
        const trimmed = nonSystemMsgs.length - keepCount;
        // ── Auto-flush: save key facts from messages being dropped ──
        const droppedMsgs = nonSystemMsgs.slice(0, nonSystemMsgs.length - keepCount);
        for (const msg of droppedMsgs) {
            try {
                if (msg.role !== "user" && msg.role !== "tool") continue;
                const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
                if (!text || text.length < 50) continue;
                if (text.startsWith("{") && text.endsWith("}")) continue;
                const content = text.length > 500 ? `${text.substring(0, 497)}...` : text;
                remember(content, "auto_flush", "hard_cap,auto", 5, "tool");
            } catch {
                /* auto-flush non-fatal */
            }
        }
        workingHistory = [...systemMsgs, ...nonSystemMsgs.slice(-keepCount)];
        conversationHistory = workingHistory;
        console.log(
            `  ✂️ Hard-capped conversation history: dropped ${trimmed} oldest messages (limit: ${MAX_CONVERSATION_HISTORY})`,
        );
    }

    if (!isForked) {
        const pruneResult = await pruneContext(workingHistory, llm);
        if (pruneResult.pruned > 0) {
            conversationHistory = pruneResult.messages;
            workingHistory = conversationHistory;
            console.log(`  ✂️ Pruned ${pruneResult.pruned} old messages`);
        }
    }

    const messages: ChatCompletionMessageParam[] = workingHistory;

    let iterations = 0;
    let totalToolCalls = 0;
    let lastToolCalls: Array<{ function: { name: string } }> | undefined;
    let usedBrowserTools = false;
    let lastProgressTime = 0;
    let lastUsedModel: string | undefined; // Track model for credit deduction

    // ── Auto Plan Mode (coding intent only) ──
    // Off by default — opt in with ATLAS_AUTO_PLAN_MODE=true.
    // Never triggers for sub-agent calls (historyFork) or non-coding tasks.
    // Fail-open: any classifier error leaves plan mode untouched.
    try {
        if (!isForked && process.env.ATLAS_AUTO_PLAN_MODE === "true" && !isPlanMode() && rawUserMessage) {
            const taskType = detectTaskType(rawUserMessage);
            if (taskType === "coding") {
                const complexity = classifyComplexity(rawUserMessage);
                if (complexity.score >= 0.3) {
                    console.log(
                        `[AGENT] auto-entering plan mode (score=${complexity.score.toFixed(2)}, signals=${complexity.signals.join(",")})`,
                    );
                    enterPlanMode(`auto: coding + complexity ${complexity.score.toFixed(2)}`, "auto");
                }
            }
        }
    } catch (err) {
        console.warn(`[AGENT] auto-plan-mode skipped: ${(err as Error).message}`);
    }

    // Helper to send progress (non-blocking, throttled)
    const sendProgress = async (msg: string) => {
        if (!onProgress) return;
        const now = Date.now();
        if (now - lastProgressTime < 3000) return;
        lastProgressTime = now;
        try {
            await onProgress(msg);
        } catch {
            /* don't let progress errors kill the agent */
        }
    };

    let errorCount = 0;

    // ── Plan-Then-Execute Detection ──
    // When the message contains multiple independent URLs or task markers,
    // inject a planning hint so the LLM plans upfront rather than going one-by-one.
    const urlMatches = rawUserMessage.match(/https?:\/\/[^\s)"'>]+/g);
    const uniqueUrls = urlMatches ? [...new Set(urlMatches)] : [];
    const taskMarkers = (rawUserMessage.match(/\band also\b|\bthen do\b|\balso do\b|\band\s+https?:/gi) || []).length;

    if (uniqueUrls.length >= 3 || taskMarkers >= 2) {
        const planningHint = `\n\n[MULTI-TASK DETECTED — ${uniqueUrls.length} URLs, ${taskMarkers} task markers]
STRATEGY: Use browser_parallel_tabs to open all URLs simultaneously. The system auto-limits concurrency based on available RAM/CPU. Plan your approach:
1. Group all independent URLs into ONE browser_parallel_tabs call
2. Extract content from each tab in parallel
3. Then process each tab's content (switch between tabs with browser_switch_tab)
Do NOT process URLs one-by-one — that wastes iterations. Parallel first, then sequential per-tab work.`;
        workingHistory.push({ role: "system", content: planningHint });
        console.log(
            `  📋 Plan-then-execute: detected ${uniqueUrls.length} URLs, ${taskMarkers} task markers — injecting planning hint`,
        );
    }

    // Detect OS/app interaction tasks and inject planning hint
    const osTaskPatterns =
        /\b(open|launch|send|type|click|navigate|go to|switch to|play|edit|cut|trim|paste|copy|save|export|import|record|delete|search|find|message|call|email)\b/i;
    const isOsAppTask =
        osTaskPatterns.test(rawUserMessage) &&
        !rawUserMessage.includes("http") &&
        rawUserMessage.split(/\s+/).length > 3;

    if (isOsAppTask) {
        const planHint = `\n\n[OS TASK — Plan all steps upfront, minimize tool calls]
STRATEGY: Execute in as few tool calls as possible.
1. Use os_scan ONCE to see all elements on screen
2. Use os_multi_action to batch clicks, types, and key presses in ONE call
3. Only screenshot AFTER the full sequence to verify the end result
4. Use os_click_element (by label number) instead of coordinate clicking
5. Prefer keyboard shortcuts over mouse clicks — they're faster and more reliable
6. For known apps: you already know the layout, don't screenshot to "check"`;
        workingHistory.push({ role: "system", content: planHint });
    }

    // Cascade escalation: only one attempt per agent invocation
    let cascadeAttempted = false;

    // Empty response retry: if LLM produces empty text after tool calls, nudge and retry
    let emptyResponseRetries = 0;
    const MAX_EMPTY_RETRIES = 2;

    // Metacognition state — self-monitoring for loop/struggle detection
    const metaState = createMetacognitionState();
    let metaNudged = false;

    // Circuit breaker — trips after sustained failures or no-progress
    const circuitBreaker = createCircuitBreaker();

    while (true) {
        // Metacognition-driven nudge: replaces the old fixed ITERATION_NUDGE_THRESHOLD
        if (!metaNudged && iterations > 3) {
            const metaCheck = assess(metaState);
            if (metaCheck.loopDetected || metaCheck.struggleDetected) {
                metaNudged = true;
                const nudge = `[SYSTEM — METACOGNITION] ${metaCheck.reasoning}. You have been running for ${iterations} iterations and ${totalToolCalls} tool calls. ${metaCheck.loopDetected ? "A repeating tool-call pattern was detected." : "You appear to be struggling."} Please reflect: are you stuck in a loop or making actual progress? If you are stuck, summarize what you have accomplished so far and present it to the user. If you are making real progress, continue with a different approach.`;
                messages.push({ role: "system", content: nudge });
                console.warn(`  ⚠️ Metacognition nudge: ${metaCheck.reasoning} (iteration ${iterations})`);
            }
            // Low confidence can inform cascade escalation
            if (metaCheck.confidence < 0.3 && !cascadeAttempted) {
                console.log(
                    `  🧠 Metacognition: low confidence (${metaCheck.confidence.toFixed(2)}) — may trigger cascade escalation`,
                );
            }
        }

        // ── Circuit Breaker Check ─────────────────
        // Check if the breaker has tripped due to sustained failures/no-progress
        if (iterations > 1) {
            const tripResult = shouldTrip(circuitBreaker);
            if (tripResult.trip) {
                // Try transitioning to HALF-OPEN for one probe attempt
                if (tryHalfOpen(circuitBreaker)) {
                    console.log(`  [CIRCUIT-BREAKER] Half-open: one probe attempt with highest-tier model`);
                    // Force the highest-tier model for the probe (handled below via modelOverride)
                    messages.push({
                        role: "system" as const,
                        content: `[SYSTEM — CIRCUIT BREAKER HALF-OPEN] The agent has been stuck. This is a recovery probe. Take a completely different approach to complete the task. Summarize what has been tried so far and attempt one final strategy.`,
                    });
                } else if (circuitBreaker.state === "open") {
                    // Still in cooldown — notify user and exit
                    const statusMsg = getStatusMessage(circuitBreaker);
                    console.warn(`  [CIRCUIT-BREAKER] ${statusMsg}`);
                    if (onProgress) {
                        try {
                            await onProgress(`\u26a0\ufe0f ${statusMsg}`);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    const partialResponses = messages
                        .filter(
                            (m) => m.role === "assistant" && typeof (m as { content?: string }).content === "string",
                        )
                        .map((m) => (m as { content: string }).content)
                        .filter(Boolean);
                    const partialText =
                        partialResponses.length > 0 ? partialResponses[partialResponses.length - 1] : null;
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                    return {
                        text:
                            partialText ||
                            `I've been having trouble completing this task (${tripResult.reason}). Please try again or try a different approach.`,
                        toolCalls: totalToolCalls,
                    };
                }
            }
        }

        // Check for cancellation
        if (signal?.aborted) {
            console.log(`  🛑 Task cancelled by user`);
            workingHistory.push({ role: "assistant", content: "Task cancelled by user." });
            // Credit already deducted per-API-call, just return
            const stats = getSessionCreditStats();
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
            return { text: `✅ Task stopped. (${stats.creditsUsed} credits used)`, toolCalls: totalToolCalls };
        }

        // ── Mid-session credit check (every 5 tool calls) ──
        // If credits run out while working, stop gracefully instead of continuing
        if (totalToolCalls > 0 && totalToolCalls % 5 === 0) {
            try {
                const midCheck = await checkAccountStatus();
                if (!midCheck.allowed) {
                    console.log(`[AccountGuard] Credits exhausted mid-task after ${totalToolCalls} tool calls`);
                    const exhaustedMsg = `⛔ ${midCheck.reason || "Your AI credits have run out."} Task stopped after ${totalToolCalls} steps.`;
                    workingHistory.push({ role: "assistant", content: exhaustedMsg });
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                    return { text: exhaustedMsg, toolCalls: totalToolCalls };
                }
            } catch {
                // Non-fatal: if check fails, let the task continue (fail-open for active work)
            }
        }

        iterations++;

        // ── Hermes Agent Periodic Memory Nudge ──
        // Every N iterations, nudge the agent to self-evaluate what's worth remembering.
        // This ensures important facts/decisions/preferences are persisted during long
        // conversations, not just at session end.
        if (iterations > 1 && iterations % MEMORY_NUDGE_INTERVAL === 0) {
            const nudge = `[Memory nudge] Review the conversation so far. If any important facts, decisions, user preferences, or task learnings have emerged that aren't yet stored, use memory_store to persist them now. Focus on information that would be valuable in future conversations.`;
            messages.push({ role: "system", content: nudge });
            console.log(`  🧠 Memory nudge injected (iteration ${iterations})`);
        }

        // Only pass hasMedia on first iteration — subsequent iterations are tool loops,
        // not vision tasks. Without this, screenshots cause all iterations to use Vision routing.
        const hasMediaThisIter = iterations === 1 && !!(media && media.length > 0);
        const selection = chooseModel(
            iterations,
            lastToolCalls,
            errorCount,
            modelHint,
            rawUserMessage,
            hasMediaThisIter,
        );
        // Circuit breaker half-open: force highest-tier model for recovery probe
        const model = circuitBreaker.state === "half-open" ? MODELS.PRO : selection.modelId;
        if (iterations <= 3 || iterations % 5 === 0) {
            console.log(`  🧠 Iteration ${iterations} using ${selection.displayName} [${selection.reason}]`);
        }

        // Auto-inject relevant memory and strategies on the first iteration of a user's prompt
        let activeInjection = "";
        // Music fast-path state. Phase-1 is set BEFORE the tool-selection await
        // (heuristic only — skips the heavy memory briefing). Phase-2 is set
        // AFTER the await when the LLM classifier has populated its output.
        let musicFastPathPhase1 = false; // heuristic match — skip briefing only
        let musicFastPathActive = false; // full classifier match — skip orchestrator + verification + auto-reply
        let musicFastPathHint: string | undefined;
        let toolSelectionPromise: Promise<Awaited<ReturnType<typeof selectTools>>> | null = null;
        if (iterations === 1 && userMessage) {
            const parts: string[] = [];

            // ── Live datetime context (always first) ──
            const now = new Date();
            const tz = getTimezone();
            const timeStr = now.toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
                timeZone: tz,
            });
            const dateStr = now.toLocaleDateString("en-IN", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: tz,
            });
            // Parse local hour from the formatted time string (not system-local hours)
            const localHour =
                parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }), 10) || 0;
            const greeting =
                localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";
            parts.push(`🕐 CURRENT CONTEXT:\n- Date: ${dateStr}\n- Time: ${timeStr} (${tz})\n- Period: ${greeting}`);

            // ── 0. Touch session (track turns) ───────
            // Capture pre-expiry history BEFORE touchSession clears session state
            const preSessionHistory = [...workingHistory];
            const { isNew, expiredSession } = touchSession(userMessage);
            if (isNew) {
                console.log(`  📋 New session started`);
                resetSessionTraitCaps("new");

                // Fire reflection for expired session — use pre-expiry history, not current (mostly empty) workingHistory
                if (expiredSession && expiredSession.turn_count > 3) {
                    console.log(
                        `[MEMORY][REFLECTION] Session expired — triggering reflection (${expiredSession.turn_count} turns)`,
                    );
                    // Await reflection so its DB writes complete before memory retrieval runs
                    await runReflection(llm, preSessionHistory).catch((err) =>
                        console.error("[MEMORY][REFLECTION] Expired session reflection failed:", err),
                    );
                }
            }

            // ── 1. Classify query to decide retrieval depth ──
            const queryMode = classifyQuery(rawUserMessage);
            console.log(`[MEMORY][RETRIEVE] Query mode: ${queryMode}`);

            // ── Build conversation context for tool router ──
            // Gives the tool selector awareness of recent conversation turns so it
            // can disambiguate references like "open the file manager" (OS app vs. website button)
            const convCtx = buildToolRouterContext(workingHistory);

            // ── Start tool selection in parallel with memory injection ──
            // For llm_only (greetings/acks): use fast-path (no embeddings, instant)
            // For everything else: start async embedding now, await later
            toolSelectionPromise =
                queryMode === "llm_only"
                    ? Promise.resolve(selectToolsFast())
                    : selectTools({
                          message: rawUserMessage,
                          recentToolCalls: lastToolCalls?.map((tc) => tc.function.name),
                          iteration: iterations,
                          requestedCategories,
                          conversationContext: convCtx,
                      });

            // ── 2. Identity profile + onboarding detection ──
            // Skipped for contact agents: the identity snippet says "your user is Dheeraj,
            // working on Midnight Library..." — injecting it causes the LLM to describe the
            // OWNER whenever a contact asks "do you know me?". The owner's name is already
            // present in the contact system prompt; the full demographic profile must not leak.
            let isFirstTime = false;
            if (!isContactAgent) {
                try {
                    const identitySnippet = getIdentityPromptSnippet();
                    if (identitySnippet) {
                        parts.push(identitySnippet);
                    } else {
                        isFirstTime = true;
                    }
                } catch {
                    isFirstTime = true;
                }

                // ── Location context — owner-private, skip for contact agents ──
                try {
                    const locationSnippet = getLocationSnippet();
                    if (locationSnippet) parts.push(locationSnippet);
                } catch {
                    /* location not initialized */
                }
            }

            // ── Project memory (ATLAS.md walk-up) ──
            // Only for coding-classified queries to avoid injecting
            // project conventions into chat/research flows.
            try {
                if (detectTaskType(rawUserMessage) === "coding") {
                    const projectMemory = getProjectMemorySnippet();
                    if (projectMemory) parts.push(projectMemory);
                }
            } catch {
                /* project memory not available */
            }

            // ── Repo map (structural symbol summary) ──
            // Token-budgeted structural overview for coding queries so the agent
            // knows "what's where" without reading every file. Kept tight at 1500
            // tokens to avoid crowding the rest of the context injection.
            // ── repo_map + codebase index architecture injection (parallel) ──
            // For coding tasks, run the repo_map walk and the codebase-index
            // + architecture extraction concurrently. They hit disjoint caches
            // so parallelism roughly halves first-iteration cold latency
            // compared to the previous serial flow.
            if (detectTaskType(rawUserMessage) === "coding") {
                const cwd = process.cwd();
                const repoMapTask = (async () => {
                    if (process.env.ATLAS_NO_REPO_MAP === "true") return null;
                    try {
                        const { generateRepoMap } = await import("./tools/repo-map.js");
                        const map = await generateRepoMap(cwd, {
                            maxTokens: 1500,
                            maxFiles: 200,
                            maxSymbolsPerFile: 8,
                        });
                        return map && !map.startsWith("[No source") ? `<repo_map>\n${map}\n</repo_map>` : null;
                    } catch (err) {
                        console.warn("[AGENT] repo_map injection failed (non-fatal):", (err as Error).message);
                        return null;
                    }
                })();
                const archTask = (async () => {
                    try {
                        const { ensureIndexForCoding, getArchitectureSnippet } = await import(
                            "./memory/codebase-index.js"
                        );
                        await ensureIndexForCoding(cwd);
                        return (await getArchitectureSnippet(cwd)) || null;
                    } catch (err) {
                        console.warn("[AGENT] architecture injection failed (non-fatal):", (err as Error).message);
                        return null;
                    }
                })();
                const [repoMap, arch] = await Promise.all([repoMapTask, archTask]);
                if (repoMap) parts.push(repoMap);
                if (arch) parts.push(arch);
            }

            // ── Platform capabilities (injected once per session) ──
            // Tells the LLM which shell, screenshot engine, clipboard engine, OCR
            // tool, and automation helpers are actually available at runtime so it
            // avoids calling tools that will fail on this platform.
            if (process.env.ATLAS_NO_CAPABILITY_INJECTION !== "true") {
                try {
                    const { getPlatformCapabilities, formatCapabilitiesForContext } = await import(
                        "./utils/platform-capabilities.js"
                    );
                    const caps = await getPlatformCapabilities();
                    const capsText = formatCapabilitiesForContext(caps);
                    parts.push(`<platform_capabilities>\n${capsText}\n</platform_capabilities>`);
                } catch {
                    /* non-fatal */
                }
            }

            // ── Past coding-strategy recall (Phase 4E read side) ──
            // For coding tasks, surface the code-category task-learnings ahead
            // of the general recall so previously-validated patterns aren't
            // crowded out by browser/os/app entries when the top-3 is shared.
            try {
                if (detectTaskType(rawUserMessage) === "coding") {
                    const codingLearnings = getTaskLearningsContext(userMessage, "code");
                    if (codingLearnings) parts.push(codingLearnings);
                }
            } catch {
                /* task-learnings not initialized */
            }

            // ── Coding complexity classification ──
            // Inject a short reminder telling the agent which flow to
            // follow: trivial skips design-docs, standard implements
            // directly with Pro tier, complex triggers the full PRD →
            // approval → walkthrough ceremony.
            try {
                if (detectTaskType(rawUserMessage) === "coding") {
                    const { classifyCodingComplexity } = await import("./model-router.js");
                    const c = classifyCodingComplexity(userMessage);
                    if (c === "complex") {
                        parts.push(
                            '<coding_complexity level="complex">\n' +
                                "This task is classified as COMPLEX (multi-file / architectural / new-system / high-stakes).\n" +
                                "YOU MUST follow the full flow in prompts/coding.md §Complex coding:\n" +
                                "  1. generate_design_docs → auto-enters awaiting_approval mode\n" +
                                "  2. render_md_to_pdf (TG/WA) or deliver MD (overlay/Discord/Slack)\n" +
                                "  3. Wait for the user to approve, then call approve_design_docs\n" +
                                "  4. Implement on Pro tier\n" +
                                "  5. demo_project (if runnable) → generate_walkthrough → deliver with screenshots/recording\n" +
                                "Do NOT skip Phase 1 — the tool machinery will refuse code edits until approval lands.\n" +
                                "</coding_complexity>",
                        );
                    } else if (c === "trivial") {
                        parts.push(
                            '<coding_complexity level="trivial">\n' +
                                "This is a trivial edit (one-liner / typo / rename / log statement). Skip the design-docs flow and implement directly. Light tier is acceptable.\n" +
                                "</coding_complexity>",
                        );
                    } else {
                        parts.push(
                            '<coding_complexity level="standard">\n' +
                                "Standard-scope coding task: debug / single feature / targeted fix. Implement directly on Pro tier. Skip design docs, but still finish with a short recap of what changed.\n" +
                                "</coding_complexity>",
                        );
                    }
                }
            } catch {
                /* classifier unavailable — don't block the agent */
            }

            // ── 3. Behavioral traits (token-budgeted, relevance-scored) ──
            try {
                const traitsSnippet = getTraitsForInjection(userMessage, 600);
                if (traitsSnippet) parts.push(traitsSnippet);
            } catch {
                /* traits not initialized */
            }

            // ── 4. Session context (rolling summary) ──
            const sessionSummary = getSessionSummary();
            if (sessionSummary) parts.push(sessionSummary);

            // ── 5. Self-state behavioral modifiers ──
            try {
                const selfStateSnippet = getSelfStateSnippet();
                if (selfStateSnippet) parts.push(selfStateSnippet);
            } catch {
                /* */
            }

            // ── 6. Emotional context ──
            try {
                const emotionalSnippet = getEmotionalContextSnippet();
                if (emotionalSnippet) parts.push(emotionalSnippet);
            } catch {
                /* */
            }

            // ── 7. Episodic milestones ──
            try {
                const episodicSnippet = getEpisodicSnippet();
                if (episodicSnippet) parts.push(episodicSnippet);
            } catch {
                /* */
            }

            // ── 8. Relationship tone modulation ──
            try {
                const relationshipSnippet = getRelationshipSnippet();
                if (relationshipSnippet) parts.push(relationshipSnippet);
            } catch {
                /* */
            }

            // ── 9. Anticipation (proactive, gated — skip for simple greetings) ──
            if (queryMode !== "llm_only") {
                try {
                    const anticipationSnippet = getAnticipationSnippet();
                    if (anticipationSnippet) parts.push(anticipationSnippet);
                } catch {
                    /* */
                }
            }

            // ── 10. User model (aggregated profile: projects, routines, style) ──
            if (queryMode !== "llm_only") {
                try {
                    const userModelSnippet = await getUserModelSnippet();
                    if (userModelSnippet) parts.push(userModelSnippet);
                } catch {
                    /* user model not initialized */
                }
            }

            try {
                // Core Identity & Important Facts (Always injected)
                const coreMems = getCoreMemory(getDimensionValue<number>("memory.coreMemory.k") ?? 10);
                if (coreMems && coreMems.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    parts.push(
                        `🧠 CORE MEMORY (Always remember these facts about the user):\n${coreMems.map((m: any) => `- (${m.category}) ${m.content}`).join("\n")}`,
                    );
                }

                // 6. Query-specific recall — only for modes that need semantic search
                if (queryMode === "retrieve" || queryMode === "llm_with_traits") {
                    const recallK = getDimensionValue<number>("memory.recall.k") ?? 10;
                    const convRecallK = getDimensionValue<number>("memory.conversationRecall.k") ?? 3;
                    // Enrich recall query with recent user messages for better semantic matching
                    const recentUserMsgs = workingHistory
                        .filter((m) => m.role === "user" && typeof m.content === "string")
                        .slice(-3)
                        .map((m) => (m.content as string).substring(0, 150));
                    const enrichedQuery =
                        recentUserMsgs.length > 1 ? `${recentUserMsgs.join(" ")} ${userMessage}` : userMessage;

                    const [queriedMems, pastConvos, learningsCtx] = await Promise.all([
                        recall(enrichedQuery, recallK, llm, queryMode).catch(() => []),
                        Promise.resolve().then(() => {
                            try {
                                return recallConversation(userMessage, convRecallK);
                            } catch {
                                return [];
                            }
                        }),
                        Promise.resolve().then(() => {
                            try {
                                return getTaskLearningsContext(userMessage);
                            } catch {
                                return null;
                            }
                        }),
                    ]);

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const uniqueMems = queriedMems.filter((q: any) => !coreMems.some((c: any) => c.id === q.id));
                    // Record memory hits for harness traces
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const topScore = queriedMems.length > 0 ? (queriedMems[0] as any).score ?? 0 : 0;
                    if (_harnessTraceId) recordMemoryHit(_harnessTraceId, uniqueMems.length, topScore);
                    if (uniqueMems && uniqueMems.length > 0) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        parts.push(
                            `🧠 RELEVANT RECALLED MEMORIES (Based on current prompt):\n${uniqueMems.map((m: any) => `- (${m.category}) ${m.content}`).join("\n")}`,
                        );
                    }

                    // Knowledge graph entity lookup (sync — fast SQLite)
                    try {
                        const kgDb = getKnowledgeGraphDB();
                        if (kgDb) {
                            const entities = findEntities(kgDb, userMessage);
                            if (entities.length > 0) {
                                const entityLines = entities
                                    .slice(0, 5)
                                    .map(
                                        (e) =>
                                            `- [${e.type}] ${e.name}${e.properties && Object.keys(e.properties).length > 0 ? ` (${JSON.stringify(e.properties)})` : ""}`,
                                    );
                                parts.push(`🔗 RELATED ENTITIES:\n${entityLines.join("\n")}`);
                            }
                        }
                    } catch {
                        /* KG not initialized */
                    }

                    if (pastConvos.length > 0) {
                        const convoLines = pastConvos.map((c) => `- [${c.created_at}] ${c.summary}`);
                        parts.push(`💬 PAST CONVERSATIONS:\n${convoLines.join("\n")}`);
                    }

                    // Task learnings (already fetched in parallel above)
                    if (learningsCtx) parts.push(learningsCtx);
                }
            } catch {
                /* DB not initialized */
            }

            const browserCtx = getBrowserContext(userMessage);
            if (browserCtx) parts.push(browserCtx);

            // ── Chrome Extension Context ──
            // If the Chrome extension is connected, tell the agent what the user is viewing
            // so it can decide whether to use the real Chrome or headless Playwright.
            try {
                const { isExtensionConnected, getExtensionTabs, getCurrentMode } = await import(
                    "./tools/browser/index.js"
                );
                if (isExtensionConnected()) {
                    const tabs = await getExtensionTabs();
                    const activeTab = tabs.find((t: { active: boolean }) => t.active);
                    const mode = getCurrentMode();
                    let chromeCtx = `[CHROME EXTENSION CONNECTED] User has ${tabs.length} tab(s) open. Current browser mode: ${mode}.`;
                    if (activeTab) {
                        chromeCtx += `\n  Active tab: "${activeTab.title}" — ${activeTab.url}`;
                    }
                    chromeCtx += `\n  Use browser_set_mode("chrome") to interact with the user's real Chrome, or "playwright" for independent research.`;
                    parts.push(chromeCtx);
                }
            } catch {
                /* chrome bridge not initialized */
            }

            // ── Working memory (active context from recent tool results & facts) ──
            try {
                await wmReflect(rawUserMessage);
                const wmSnippet = getWMSnippet();
                if (wmSnippet) parts.push(wmSnippet);
            } catch {
                /* working memory not initialized */
            }

            // ── Self-model (capability confidence) ──
            try {
                const selfSnippet = getSelfModelSnippet();
                if (selfSnippet) parts.push(selfSnippet);
            } catch {
                /* self-model not ready */
            }

            // ── Active goals ──
            try {
                const goalsSnippet = getGoalsSnippet();
                if (goalsSnippet) parts.push(goalsSnippet);
            } catch {
                /* goals not ready */
            }

            // ── Credit awareness context ──
            // Let the LLM know remaining credits so it can optimize its approach.
            // Does NOT mean reject tasks — only prefer efficient strategies when low.
            const creditBalance = getKnownCreditBalance();
            if (creditBalance !== null) {
                const { creditsUsed } = getSessionCreditStats();
                let creditHint = `💰 CREDITS: ${creditBalance} remaining (${creditsUsed} used this session).`;
                if (creditBalance < 10) {
                    creditHint += ` Credits are LOW — be efficient: prefer browser_parallel_tabs over sequential navigation, use browser_multi_action to batch steps, and minimize redundant browser_scan calls. Never refuse a task due to low credits — keep working until credits run out.`;
                }
                parts.push(creditHint);
            }

            // ── Active background tasks awareness ──
            // Inject status of all long-tasks so the agent always knows what's happening
            try {
                const allBgTasks = listActiveLongTasks();
                if (allBgTasks.length > 0) {
                    const runningTasks = allBgTasks.filter((t) => t.status === "running");
                    const completedTasks = allBgTasks.filter((t) => t.status === "completed" || t.status === "failed");

                    const lines: string[] = [];

                    for (const t of runningTasks) {
                        const phase = `phase ${t.currentPhase + 1}/${t.phases.length}`;
                        const elapsed =
                            t.totalDurationMs > 0 ? `${(t.totalDurationMs / 1000).toFixed(0)}s` : "just started";
                        const currentDesc = t.phases[t.currentPhase]?.description?.substring(0, 80) || "running";
                        lines.push(`  ▶ [${t.id}] RUNNING — ${phase} (${elapsed}): ${currentDesc}`);
                    }

                    for (const t of completedTasks) {
                        const elapsed = `${(t.totalDurationMs / 1000).toFixed(0)}s`;
                        const lastPhaseId = t.phases[t.phases.length - 1]?.id;
                        const lastOutput = lastPhaseId ? (t.checkpointData[lastPhaseId] || "").substring(0, 120) : "";
                        const statusIcon = t.status === "completed" ? "✅" : "❌";
                        lines.push(
                            `  ${statusIcon} [${t.id}] ${t.status.toUpperCase()} (${t.phases.length} phases, ${elapsed})${lastOutput ? `: ${lastOutput}` : ""}`,
                        );
                    }

                    let instructions: string;
                    if (runningTasks.length > 0) {
                        instructions =
                            "These tasks are running autonomously in the background. Do NOT redo their work. If the user asks about progress, use check_long_task. If they ask for something new, handle it normally.";
                    } else {
                        instructions =
                            "All background tasks have finished. Use check_long_task to get full results if the user asks about them.";
                    }

                    parts.push(
                        `🔄 BACKGROUND TASKS (${runningTasks.length} running, ${completedTasks.length} finished):\n${lines.join("\n")}\n${instructions}`,
                    );
                }
            } catch {
                /* non-fatal if long-task module not loaded */
            }

            // ── Onboarding nudge for first-time users ──
            if (isFirstTime) {
                parts.push(`🆕 FIRST-TIME USER — you have zero memory. This is your very first chat with this person.
- Introduce yourself casually ONCE: "hey! I'm A.T.L.A.S 👋" — keep it short and warm.
- Naturally get to know them through conversation (name, what they do, what they're building). DON'T interrogate.
- Save info as you learn it: identity_update for name/role/company, trait_update for preferences.
- After this chat, you'll remember everything. Never re-introduce or re-ask.`);
            }

            // Contact agents: drain ALL owner memory that was just collected and
            // replace with only the contact's own profile. The LLM must not have
            // the owner's identity, projects, episodic history, or remembered facts
            // in its context — that is what causes it to describe the owner when
            // contacts ask "do you know me?". PA tools (google_calendar, ask_owner)
            // handle any on-demand owner lookups instead.
            if (isContactAgent) {
                const datetimePart = parts[0]; // preserve the clock context (always first)
                parts.length = 0;
                if (datetimePart) parts.push(datetimePart);

                const cp = channelContext?.contactProfile as any;
                if (cp) {
                    const contactName = cp.displayName || cp.pushName || "Contact";
                    const contactLines: string[] = [];
                    if (cp.context?.relation) contactLines.push(`Relation to owner: ${cp.context.relation}`);
                    if (cp.notes) contactLines.push(`Notes: ${cp.notes}`);
                    if (cp.messageCount > 0) contactLines.push(`Past messages: ${cp.messageCount}`);
                    if (cp.memories?.length) {
                        contactLines.push(
                            `Saved notes:\n${cp.memories.slice(-5).map((m: any) => `- ${m.content}`).join("\n")}`,
                        );
                    }
                    if (contactLines.length > 0) {
                        parts.push(`[CONTACT — ${contactName}]\n${contactLines.join("\n")}`);
                    }
                }
            }

            if (parts.length > 0) {
                // Record context sources for harness traces
                if (iterations === 1) {
                    if (_harnessTraceId) recordContextSources(_harnessTraceId, parts.map(p => p.split("\n")[0].substring(0, 60)));
                }

                // Cap total injected context — tunable via Meta-Harness registry
                const MAX_INJECTION_CHARS = getDimensionValue<number>("agent.contextCap") ?? 8000;
                let totalChars = 0;
                const cappedParts: string[] = [];
                for (const part of parts) {
                    if (totalChars + part.length > MAX_INJECTION_CHARS) {
                        // Truncate the last part that overflows
                        const remaining = MAX_INJECTION_CHARS - totalChars;
                        if (remaining > 100) cappedParts.push(`${part.substring(0, remaining)}...`);
                        break;
                    }
                    cappedParts.push(part);
                    totalChars += part.length;
                }

                // Phase-1 heuristic: if this looks like a simple music command, skip the
                // expensive memory briefing. False positives here are low-cost — the user
                // just gets a leaner context on a non-music turn.
                if (iterations === 1 && !isPlanMode() && isLikelyMusicCommand(rawUserMessage)) {
                    musicFastPathPhase1 = true;
                    console.log(`  ⚡ Music fast-path phase-1 (heuristic) — skipping memory briefing`);
                }

                // ── LLM Memory Briefing (Hermes pattern) ──
                // When enabled, synthesize raw memory fragments into a cohesive briefing
                // via a cheap Haiku call. Falls back to raw injection on failure.
                if (USE_MEMORY_BRIEFING && queryMode !== "llm_only" && !musicFastPathPhase1) {
                    try {
                        const rawMemories: Record<string, string> = {};
                        for (const part of cappedParts) {
                            // Extract section headers from the parts
                            const headerMatch = part.match(/^[^\n]+/);
                            const key = headerMatch
                                ? headerMatch[0]
                                      .replace(/[^a-zA-Z0-9_ ]/g, "")
                                      .trim()
                                      .substring(0, 40)
                                : "context";
                            rawMemories[key] = part;
                        }
                        const briefing = await generateMemoryBriefing(llm, rawMemories, rawUserMessage, 400);
                        if (briefing) {
                            activeInjection = `[Memory Briefing — synthesized from ${cappedParts.length} memory sources]\n${briefing}`;
                            console.log(
                                `  📋 Memory briefing generated (${briefing.length} chars from ${cappedParts.length} sources)`,
                            );
                        } else {
                            // Briefing returned null — fall back to raw injection
                            activeInjection = `[Auto-Injected Memory & Strategy Context]\n${cappedParts.join("\n\n")}`;
                        }
                    } catch {
                        // Briefing failed — fall back to raw injection (fail-open)
                        activeInjection = `[Auto-Injected Memory & Strategy Context]\n${cappedParts.join("\n\n")}`;
                    }
                } else if (!musicFastPathPhase1) {
                    // Briefing disabled or query is llm_only — fall back to raw injection.
                    activeInjection = `[Auto-Injected Memory & Strategy Context]\n${cappedParts.join("\n\n")}`;
                }
                // If musicFastPathPhase1 is true, we intentionally inject nothing here.
                // Phase-2 (after the tool-selection await) may still add a small
                // [Music Memory Hint] if the user used a possessive query.
            }

            // For simple casual messages, add a nudge for extra natural tone
            if (modelHint === "simple") {
                const casualNudge = `\n\n[CASUAL MODE — this is a simple/casual message. Respond like you're texting a close friend. Be spontaneous, not formulaic. Don't pad your response. If 2 words is enough, send 2 words. Match their energy exactly. Don't try to be impressive or add observations just to fill space.]`;
                activeInjection = (activeInjection || "") + casualNudge;
            }

            // Record user turn in session buffer
            appendTurn("user", userMessage);
            trackSessionForAnticipation();
        }

        // Smart thinking: use router's recommended thinking level
        // Override: skip thinking for simple messages (more spontaneous)
        // Sparse thinking: disable reasoning for simple repetitive OS tool loops (iterations 4+)
        const lastToolNames = lastToolCalls?.map((tc) => tc.function.name) || [];
        const isRepetitiveOsAction =
            iterations > 3 &&
            lastToolNames.length > 0 &&
            lastToolNames.every((name) => name.startsWith("os_") || name === "app_manager");

        const iterThinking: ThinkingLevel =
            iterations <= 1 && modelHint === "simple"
                ? "off"
                : iterations <= 1
                  ? selection.thinkingLevel
                  : isRepetitiveOsAction
                    ? "off"
                    : _thinkingLevel === "off"
                      ? "off"
                      : _thinkingLevel;

        // ── Await tool selection (started in parallel with memory injection above) ──
        let toolSelection: Awaited<ReturnType<typeof selectTools>>;
        if (iterations === 1 && userMessage) {
            // Use the promise started earlier
            toolSelection = await toolSelectionPromise!;
        } else {
            // Later iterations: run normally
            toolSelection = await selectTools({
                message: userMessage,
                recentToolCalls: lastToolCalls?.map((tc) => tc.function.name),
                iteration: iterations,
                requestedCategories,
                conversationContext: buildToolRouterContext(workingHistory),
            });
        }
        const tools = toolSelection.tools;
        activeCategories = toolSelection.categories;

        // ── Harness trace: record selected tools ──
        if (iterations === 1 && _harnessTraceId) {
            if (_harnessTraceId) recordToolsSelected(_harnessTraceId, tools.map(t => t.function?.name ?? String(t)).filter(Boolean));
        }

        // Phase-2 full fast-path gate (requires classifier output — threaded
        // through toolSelection.classification so it's guaranteed to reflect
        // THIS call's classifier result, immune to concurrent-call races and
        // to stale reads on cache hits).
        if (
            iterations === 1 &&
            isMusicFastPathEligible({
                userMessage: rawUserMessage,
                iteration: iterations,
                inPlanMode: isPlanMode(),
                classification: toolSelection.classification,
            })
        ) {
            musicFastPathActive = true;
            const peek = await musicMemoryPeek(rawUserMessage, llm);
            musicFastPathHint = peek.musicMemoryHint;
            console.log(
                `  ⚡ Music fast-path active${musicFastPathHint ? " (with memory hint)" : ""} — skipping orchestrator + auto-verification`,
            );
            if (musicFastPathHint) {
                activeInjection = `${activeInjection ? activeInjection + "\n\n" : ""}${musicFastPathHint}`;
            }
        }

        // Skill slugs are sent to the server for server-side injection
        const iterSkillSlugs = iterations === 1 ? toolSelection.skillSlugs : [];

        let iterationMessages = activeInjection
            ? [{ role: "system" as const, content: activeInjection }, ...messages]
            : [...messages];

        // ── Channel Context Injection ──
        // Inform the LLM which channel the message came from, who is speaking, and what channels are active
        if (channelContext) {
            // Build active channels list from boot state
            const activeChannels: string[] = ["overlay"]; // Always active
            if (process.env.TELEGRAM_BOT_TOKEN) activeChannels.push("telegram");
            if (process.env.WHATSAPP_ALLOWED_JIDS) activeChannels.push("whatsapp");
            if (process.env.DISCORD_BOT_TOKEN) activeChannels.push("discord");
            if (process.env.SLACK_BOT_TOKEN) activeChannels.push("slack");
            if (process.env.EMAIL_USER) activeChannels.push("email");
            if (process.env.MATRIX_HOMESERVER) activeChannels.push("matrix");

            const primaryChannel = process.env.PRIMARY_CHANNEL || "telegram";

            const ctxMsg = `[Channel: ${channelContext.channel} | User: ${channelContext.userName || channelContext.userId} | Role: ${channelContext.isOwner ? "owner" : "contact"} | Active channels: ${activeChannels.join(", ")} | Primary channel for notifications: ${primaryChannel}]`;
            iterationMessages.push({ role: "system", content: ctxMsg });
        }

        // ── Orchestrator Planning: Sonnet 4.6 generates execution plan for interactive tasks ──
        const needsPlanning = activeCategories.some((c) =>
            ["os_control", "app_management", "browser", "media", "communication", "scheduling"].includes(c),
        );
        if (iterations === 1 && needsPlanning && !musicFastPathActive) {
            try {
                const planStart = Date.now();
                // ALWAYS use Sonnet for orchestrator — Haiku guesses wrong on ambiguous tasks
                const planModel = MODELS.SONNET;
                console.log(`  📋 Orchestrator: Planning with Sonnet 4.6...`);

                // Build context from learned behavior + strategy library
                const intent = getLastIntent() || "general";
                const allMusicTools = ["spotify", "music_control"];
                const prefTools = getPreferredTools(intent, allMusicTools);
                const prefContext =
                    prefTools.length > 0 && prefTools[0] !== allMusicTools[0]
                        ? `\nUser's preferred tool for this intent: ${prefTools[0]}`
                        : "";
                // Get learned strategy from past tasks
                const strategyContext = getStrategyContext(rawUserMessage);

                // Build conversation context so orchestrator understands references like "this device", "do that thing"
                const recentPairs: string[] = [];
                const historySlice = messages.slice(-12); // last ~6 user/assistant pairs
                for (const msg of historySlice) {
                    if (msg.role === "user" && typeof msg.content === "string") {
                        recentPairs.push(`User: ${msg.content.substring(0, 150)}`);
                    } else if (msg.role === "assistant" && typeof msg.content === "string") {
                        recentPairs.push(`Assistant: ${msg.content.substring(0, 150)}`);
                    }
                }
                const conversationContext =
                    recentPairs.length > 0
                        ? `\n\nCONVERSATION CONTEXT (recent messages for reference):\n${recentPairs.join("\n")}`
                        : "";
                // Include memory context so orchestrator knows about ongoing topics
                const memoryContext = activeInjection
                    ? `\n\nMEMORY CONTEXT:\n${activeInjection.substring(0, 800)}`
                    : "";

                // Include session summary for cases where messages were pruned
                let sessionCtx = "";
                try {
                    const { getSessionSummary } = await import("./memory/session.js");
                    const summary = getSessionSummary();
                    if (summary) sessionCtx = `\n\n${summary}`;
                } catch {
                    /* session not initialized */
                }

                const planResponse = await llm.chat({
                    messages: [
                        {
                            role: "user" as const,
                            content: `Task: "${rawUserMessage}"${prefContext}${strategyContext}${conversationContext}${sessionCtx}${memoryContext}

You are the ORCHESTRATOR (Sonnet 4.6). Create a precise execution plan.

TOOLS:
- spotify: action='play' query="exact song name" (plays on Spotify via the spogo CLI — works on Free + Premium without the public Web API). action='now_playing' to verify. action='pause'/'resume'/'next'/'previous'/'volume'/'seek'/'shuffle'/'repeat'. Also: search, queue_add, queue_get, playlists, devices, saved_tracks, followed_artists. First-time use may prompt spogo install or auth_import (imports Spotify cookies from the user's browser).
- music_control: Same for Apple Music
- app_manager: activate app="AppName"
- os_nav: Lists clickable elements (~200ms). Run BEFORE clicking.
- os_click_element: text="song name" clicks by text match (MOST RELIABLE). Also: label=N, action=double_click
- os_type: text="hello" or key=Return or combo="command+f"
- os_scan: Screenshot+OCR (slow, only if os_nav fails)
- browser_navigate/browser_type/browser_click: Web tasks
- messages_tool: iMessage only. WhatsApp/Telegram → use app_manager + os_nav + os_click_element

CRITICAL RULES:
1. Search for EXACTLY what the user said. Do NOT add artist names unless user specified them. "play the song time" → query="Time", NOT "Time Pink Floyd".
2. If the query is AMBIGUOUS (common words like "Time", "Happy", "Stay", "Home"), your FIRST step MUST be: ASK_USER "Which 'Time'? Some options: Pink Floyd, MKJ, NF, Hans Zimmer (Inception). Which one?"
3. After playing a song, ALWAYS verify with spotify action='now_playing' — confirm the correct track is playing before saying "done".
4. os_click_element text="song name" is MORE RELIABLE than label numbers. Always prefer text=.
5. If search_play fails, fallback: os_nav → os_click_element text="song name" action=double_click

Write 3-8 numbered steps with exact tool calls.
PLAN:`,
                        },
                    ],
                    modelOverride: planModel,
                });
                const planText = planResponse?.choices?.[0]?.message?.content || "";

                if (planText.length > 20) {
                    // Check if orchestrator wants to ask the user a question
                    const firstLines = planText.split("\n").slice(0, 3).join(" ").toLowerCase();
                    const isAskingUser =
                        firstLines.includes("ask_user") ||
                        firstLines.includes("ask the user") ||
                        firstLines.includes("which ") ||
                        firstLines.includes("clarify");

                    if (isAskingUser) {
                        // Extract the question and inject as the agent's response
                        const questionMatch = planText.match(/(?:ASK_USER|ask the user)[:\s]*["']?([^"'\n]+)/i);
                        const question =
                            questionMatch?.[1] ||
                            planText.split("\n").find((l) => l.includes("?")) ||
                            "Could you clarify what you mean?";
                        iterationMessages.push({
                            role: "system" as const,
                            content: `[ORCHESTRATOR] The task is ambiguous. Ask the user this question before proceeding: "${question.trim()}"\nDo NOT guess or assume — relay this question to the user.`,
                        });
                        console.log(
                            `  📋 Orchestrator: Ambiguous task — asking user: ${question.trim().substring(0, 100)}`,
                        );
                    } else {
                        iterationMessages.push({
                            role: "system" as const,
                            content: `[ORCHESTRATOR PLAN — follow precisely]\n${planText}\n\n[EXECUTION RULES]\n- Follow the plan step by step\n- ALWAYS use os_click_element with text= (e.g., text="Perfect") — NOT label numbers\n- os_click_element auto-double-clicks in Spotify/Music apps (plays the song)\n- After playing a song: MUST call spotify action='now_playing' to VERIFY the correct track is actually playing\n- Do NOT say "Done" until now_playing confirms the correct song name\n- If a step fails, use os_nav + os_click_element text= as fallback`,
                        });
                    }
                    console.log(
                        `  📋 Orchestrator plan (Sonnet 4.6, ${Date.now() - planStart}ms): ${planText.substring(0, 150)}...`,
                    );
                }
            } catch (err) {
                console.warn(`  ⚠️ Orchestrator planning failed: ${(err as Error).message} — proceeding without plan`);
            }
        }

        // ── Tool Allowlist Filtering ──
        // When a toolAllowlist is provided, restrict the tools sent to the LLM
        // to only those in the list. This enforces channel-level tool restrictions.
        let finalTools = tools;
        if (toolAllowlist && toolAllowlist.length > 0) {
            const allowSet = new Set(toolAllowlist);
            finalTools = tools.filter((t) => allowSet.has(t.function.name));
            if (finalTools.length === 0) {
                // Keep at least get_current_time so the LLM can still function
                finalTools = tools.filter((t) => t.function.name === "get_current_time");
            }
        }

        // ── Plan/Spec Mode Gating ──
        // When plan / spec / awaiting_approval mode is active, filter the
        // tool schema and inject a reminder describing the current mode's
        // constraints. Spec mode (Phase 4I) allows plan reads + write to
        // the spec file only. Awaiting-approval (design-docs flow) allows
        // plan reads + write scoped to the design-docs dir + channel
        // senders + approve_design_docs exit.
        // Fail-open: any exception leaves finalTools / iterationMessages untouched.
        try {
            if (isSpecMode()) {
                finalTools = filterToolsForSpecMode(finalTools);
                const reminderBody = planModeReminderBody();
                if (reminderBody) iterationMessages = injectSystemReminder(iterationMessages, reminderBody);
            } else if (isAwaitingApproval()) {
                finalTools = filterToolsForAwaitingApproval(finalTools);
                const reminderBody = planModeReminderBody();
                if (reminderBody) iterationMessages = injectSystemReminder(iterationMessages, reminderBody);
            } else if (isPlanMode()) {
                finalTools = filterToolsForPlanMode(finalTools);
                const reminderBody = planModeReminderBody();
                if (reminderBody) iterationMessages = injectSystemReminder(iterationMessages, reminderBody);
            }
        } catch (err) {
            console.warn(`[AGENT] plan-mode gating skipped: ${(err as Error).message}`);
        }

        let response: Awaited<ReturnType<LLMClient["chat"]>> | undefined;
        try {
            response = await llm.chat({
                messages: iterationMessages,
                tools: finalTools,
                thinkingLevel: iterThinking,
                modelOverride: model,
                skillSlugs: iterSkillSlugs,
            });
        } catch (llmErr) {
            cbRecordFailure(circuitBreaker);
            console.error(`[AGENT] LLM call threw: ${(llmErr as Error).message} — attempting recovery`);
            // Try one more model before giving up this iteration
            const fallbackModel = getCascadeNext(model) || (model !== MODELS.PRO ? MODELS.PRO : MODELS.SONNET);
            try {
                response = await llm.chat({
                    messages: iterationMessages,
                    tools: finalTools,
                    thinkingLevel: iterThinking,
                    modelOverride: fallbackModel,
                    skillSlugs: iterSkillSlugs,
                });
                if (response?.choices?.length) {
                    console.log(`  ✅ LLM error recovered with fallback model ${fallbackModel}`);
                }
            } catch (fallbackErr) {
                console.warn(`  ⚠️ Fallback model also failed: ${(fallbackErr as Error).message}`);
            }
            if (!response?.choices?.length) {
                errorCount++;
                if (errorCount >= 3) {
                    console.error(`[AGENT] ${errorCount} consecutive LLM failures — returning partial results`);
                    // Guard against returning stale responses from previous turns.
                    // Only use a partial response if it was generated in THIS agent run (iterations > 0),
                    // not a leftover from conversation history.
                    const currentRunResponses = messages
                        .filter(
                            (m, idx) =>
                                m.role === "assistant" &&
                                typeof (m as { content?: string }).content === "string" &&
                                idx >= messages.length - iterations * 3,
                        )
                        .map((m) => (m as { content: string }).content)
                        .filter(Boolean);
                    const partialText = currentRunResponses.length > 0 ? currentRunResponses.pop() : null;
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                    return {
                        text: partialText || "I'm having trouble connecting right now. Please try again in a moment.",
                        toolCalls: totalToolCalls,
                    };
                }
                console.warn(`[AGENT] LLM error (attempt ${errorCount}/3) — retrying next iteration`);
                messages.push({
                    role: "system" as const,
                    content: "[SYSTEM] The LLM call failed. Retry with a different approach.",
                });
                continue;
            }
        }

        // ── Empty response recovery ──
        // If LLM returns empty/undefined, retry with escalating models before giving up.
        if (!response?.choices?.length) {
            console.warn(`[AGENT] LLM returned empty/undefined response from ${model} — attempting recovery`);
            const retryModels = [getCascadeNext(model), MODELS.PRO, MODELS.SONNET].filter(
                (m): m is string => !!m && m !== model,
            );
            // Deduplicate while preserving order
            const seen = new Set<string>();
            const uniqueRetryModels: string[] = [];
            for (const m of retryModels) {
                if (!seen.has(m)) {
                    seen.add(m);
                    uniqueRetryModels.push(m);
                }
            }

            let recovered = false;
            for (const retryModel of uniqueRetryModels) {
                console.log(`  🔄 Empty response retry: escalating to ${retryModel}`);
                try {
                    const retryResponse = await llm.chat({
                        messages: iterationMessages,
                        tools: finalTools,
                        thinkingLevel: iterThinking,
                        modelOverride: retryModel,
                        skillSlugs: iterSkillSlugs,
                    });
                    if (retryResponse?.choices?.length) {
                        response = retryResponse;
                        recovered = true;
                        console.log(`  ✅ Empty response recovered with ${retryModel}`);
                        break;
                    }
                } catch (retryErr) {
                    console.warn(`  ⚠️ Retry with ${retryModel} failed: ${(retryErr as Error).message}`);
                }
            }
            if (!recovered) {
                // Last resort: retry the original model once more (transient failure)
                console.log(`  🔄 Empty response: final retry with original model ${model}`);
                try {
                    const lastRetry = await llm.chat({
                        messages: iterationMessages,
                        tools: finalTools,
                        thinkingLevel: iterThinking,
                        modelOverride: model,
                        skillSlugs: iterSkillSlugs,
                    });
                    if (lastRetry?.choices?.length) {
                        response = lastRetry;
                        recovered = true;
                        console.log(`  ✅ Empty response recovered on final retry with ${model}`);
                    }
                } catch {
                    /* fall through to error */
                }
            }
            if (!recovered) {
                errorCount++;
                console.error(`[AGENT] All empty response retries exhausted — continuing loop`);
                messages.push({
                    role: "system" as const,
                    content:
                        "[SYSTEM] Previous LLM call returned empty. Take a different approach to complete the user's request.",
                });
                continue;
            }
        }
        const choice = response.choices[0];

        // ── Live Thinking Display ──
        // Fire reasoning content through onProgress so channels can show it live
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reasoning =
            (choice as any)?.message?.reasoning_content ||
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (choice as any)?.message?.reasoning;
        if (reasoning && typeof reasoning === "string" && onProgress) {
            try {
                await onProgress(`[THINKING] ${reasoning}`);
            } catch {
                /* non-fatal */
            }
        }

        const assistantMessage = choice.message;

        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
            const responseText = assistantMessage.content || "";
            const responseTextLower = responseText.toLowerCase();

            // ── Persistence Guard ──────────────────────────────────────────────
            // Smart nudge: only push the agent to continue when it genuinely
            // stopped too early on a complex multi-step task. The old logic was
            // too aggressive (threshold=15) and caused busywork on simple tasks.
            //
            // We bail out (do NOT nudge) if ANY of these are true:
            //  • The response is conversational / short (model is genuinely done)
            //  • The model is asking the user for input
            //  • The model is wrapping up / reporting completion
            //  • The user's last message was simple (greeting, ack, stop)
            //  • The agent was exploring its own codebase (ran out of real work)
            //  • The tool call count already >= 6 (most tasks finish in <6)

            // 1. Short / conversational response = model is done, not stuck
            const isConversational = responseText.length < 300 && !responseTextLower.includes("error");

            // 2. Asking the user for something?
            const isAskingUser =
                /\?\s*$/.test(responseText.trim()) ||
                responseTextLower.includes("would you like") ||
                responseTextLower.includes("do you want") ||
                responseTextLower.includes("could you") ||
                responseTextLower.includes("please provide") ||
                responseTextLower.includes("need your") ||
                responseTextLower.includes("what is your") ||
                responseTextLower.includes("enter the otp") ||
                responseTextLower.includes("waiting for") ||
                responseTextLower.includes("let me know") ||
                responseTextLower.includes("should i");

            // 3. Agent is wrapping up — it consciously stopped or completed the task
            // NOTE: "couldn't complete"/"wasn't able" are NOT valid wrapping up — they're giving up.
            // Those are handled by isDelegatingToUser to force continuation.
            const isWrappingUp =
                (responseTextLower.includes("task complete") && totalToolCalls >= 3) ||
                (responseTextLower.includes("all done") && totalToolCalls >= 2) ||
                responseTextLower.includes("here's the result") ||
                responseTextLower.includes("here is the result") ||
                responseTextLower.includes("here are the result") ||
                responseTextLower.includes("briefing") ||
                responseTextLower.includes("good morning") ||
                responseTextLower.includes("good night") ||
                responseTextLower.includes("phone verification") ||
                responseTextLower.includes("verification required") ||
                (responseTextLower.includes("verified") && responseTextLower.includes("success"));

            // 4. Agent was exploring its own codebase = ran out of work
            const selfCodebasePatterns = [
                "package.json",
                "src/",
                "tsconfig",
                "git status",
                "npm run build",
                "node_modules",
                "dist/",
            ];
            const codeCheckMessages = [...messages].slice(-10);
            const isExploringOwnCode = codeCheckMessages.some((m) => {
                if (m.role !== "tool" && m.role !== "assistant") return false;
                const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                return selfCodebasePatterns.some((p) => txt.includes(p));
            });

            // 5. User's last message is simple — greeting, acknowledgement, or stop
            const STOP_WORDS = [
                // Explicit stop signals
                "stop",
                "cancel",
                "no",
                "don't",
                "dont",
                "quit",
                "abort",
                "never mind",
                "nevermind",
                "enough",
                "leave it",
                // Short acknowledgements — task is done, don't re-trigger
                "ok",
                "okay",
                "got it",
                "got that",
                "thanks",
                "thank you",
                "cool",
                "great",
                "nice",
                "alright",
                "noted",
                "sounds good",
                "awesome",
                "perfect",
                "understood",
                "sure",
                "yep",
                "yup",
                "yeah",
                "good",
                "that's fine",
                "thats fine",
                // Greetings / casual — not a task request
                "hi",
                "hey",
                "hello",
                "hii",
                "yo",
                "sup",
                "hola",
                "good morning",
                "good night",
                "gm",
                "gn",
                "how are you",
                "what's up",
                "whats up",
                // Confirmations of completion
                "done",
                "thats it",
                "that's it",
                "all good",
                "looks good",
                "👍",
                "✅",
                "🫡",
                "🙌",
                "😊",
                "❤️",
                "🔥",
            ];
            const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
            const lastUserText = (typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "")
                .toLowerCase()
                .trim();
            const isUserStopping =
                STOP_WORDS.some((w) => lastUserText.includes(w)) && lastUserText.split(" ").length <= 10;

            // 6. Is the user's message simple enough that it probably doesn't need tool use?
            const isSimpleUserMessage = lastUserText.split(" ").length <= 6;

            // ── Smart Delegation Detection ─────────────────────────────
            // Instead of brittle regex, analyze the CONTEXT to determine if the
            // agent is genuinely asking for user input vs. giving up on a task.
            //
            // Key insight: if tools returned ERRORS and the agent is now asking
            // the user instead of trying alternative approaches → it's giving up.
            // If the agent is asking a DISAMBIGUATION question (no errors) → legitimate.

            // Check if recent tool results had errors/failures
            const recentToolMessages = [...messages].slice(-10);
            const recentToolErrors = recentToolMessages.filter((m) => {
                if (m.role !== "tool") return false;
                const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                return (
                    txt.includes('"error"') ||
                    txt.includes('"success":false') ||
                    txt.includes("NOT_PLAYING") ||
                    txt.includes("NO_RESULTS") ||
                    txt.includes("failed")
                );
            });
            const hadRecentToolFailure = recentToolErrors.length > 0;

            // Check if the user's original message was an action command
            const isActionTask =
                /\b(play|open|send|create|set|start|stop|run|install|build|find|show|take|click|type|write|download|upload|schedule|remind|pause|skip|next|search)\b/i.test(
                    lastUserText,
                );

            // Detect explicit delegation patterns
            const isDelegatingToUser =
                responseTextLower.includes("you can ") ||
                responseTextLower.includes("you should ") ||
                responseTextLower.includes("you need to ") ||
                responseTextLower.includes("you'll need to") ||
                responseTextLower.includes("go ahead and ") ||
                responseTextLower.includes("from there") ||
                responseTextLower.includes("i recommend you");

            // Detect "giving up" — agent had a tool failure and is now asking
            // instead of trying a different approach
            const isGivingUp =
                hadRecentToolFailure &&
                (responseTextLower.includes("want me to try") ||
                    responseTextLower.includes("shall i try") ||
                    responseTextLower.includes("something else?") ||
                    responseTextLower.includes("another way") ||
                    responseTextLower.includes("isn't finding") ||
                    responseTextLower.includes("not finding") ||
                    responseTextLower.includes("couldn't find") ||
                    responseTextLower.includes("not in your library") ||
                    responseTextLower.includes("not available") ||
                    responseTextLower.includes("something's off") ||
                    responseTextLower.includes("having trouble") ||
                    responseTextLower.includes("doesn't seem") ||
                    responseTextLower.includes("unable to"));

            // Determine if the agent should be forced to continue
            // TRUE = giving up after failure, or delegating to user on an action task
            // FALSE = legitimate question (disambiguation, missing info, no errors)
            // Guard: ONLY force retry if there were actual tool errors AND response is short
            // (substantial responses >200 chars are likely genuine instructions, not giving up)
            const shouldForceRetry =
                (isDelegatingToUser &&
                    isActionTask &&
                    hadRecentToolFailure &&
                    totalToolCalls < 15 &&
                    responseText.length < 200) ||
                (isGivingUp && totalToolCalls < 15);

            if (shouldForceRetry) {
                // Build context-aware continuation prompt based on what failed
                const failedTools = recentToolErrors
                    .map((m) => {
                        const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                        // Extract tool name from context if possible
                        return txt.substring(0, 100);
                    })
                    .join("; ");

                const hasVisualTools = toolSelection.categories.includes("os_control");
                const continuationHint = hasVisualTools
                    ? "Use os_screenshot to see what's on screen right now, then os_click/os_ocr_click to interact with the visible UI elements. You have full mouse+keyboard control."
                    : "Try a completely different approach — use request_tools if you need different capabilities, or try browser_navigate to accomplish it via the web.";

                console.log(
                    `  🔄 Anti-giving-up: agent stopped after tool failure (${recentToolErrors.length} errors) — forcing retry with visual fallback`,
                );
                messages.push({ role: "assistant", content: responseText });
                messages.push({
                    role: "user",
                    content: `Your previous approach didn't work, but the task is NOT done. Don't ask me — try a different approach yourself. ${continuationHint} If your dedicated tool failed, that's fine — you have dozens of other tools. Complete the task, then verify the result.`,
                });
                lastToolCalls = undefined;
                continue;
            }

            // ── Decision: should we nudge? ──
            // Only nudge if the agent made very few tool calls (< 6) AND none of the
            // bail-out signals fired AND the user's message looks like a real task.
            // If the agent made 3+ tool calls and gave a substantial response (>80 chars),
            // it likely completed its work — don't waste an iteration nudging.
            const hasSubstantialResponse = responseText.length > 80 && totalToolCalls >= 3;
            const shouldNudge =
                totalToolCalls > 0 &&
                totalToolCalls < 6 &&
                !hasSubstantialResponse &&
                !isConversational &&
                !isAskingUser &&
                !isWrappingUp &&
                !isUserStopping &&
                !isExploringOwnCode &&
                !isSimpleUserMessage;

            if (shouldNudge) {
                console.log(
                    `  🔄 Persistence nudge: model paused after ${totalToolCalls} tool calls — checking if more work needed`,
                );
                messages.push({ role: "assistant", content: responseText });
                messages.push({
                    role: "user",
                    content:
                        "It looks like there may be more steps to complete this task. If you are genuinely done, go ahead and give your final answer. Otherwise, continue working.",
                });
                // Force PRO model for the assessment (without polluting errorCount)
                // The next iteration will use PRO regardless of tool history
                lastToolCalls = undefined; // Clears FLASH routing, causes chooseModel to pick PRO
                continue;
            }
            // ─────────────────────────────────────────────────────────────────

            // Final response — use PRO for synthesis if needed
            // Note: if PRO itself wants to keep using tools, let the loop continue.
            if (totalToolCalls > 0 && model !== MODELS.PRO) {
                // Use router for final answer instead of hardcoding PRO
                const finalSelection = selectForFinalAnswer(selection.taskType);
                console.log(`  🧠 Switching to ${finalSelection.displayName} for final answer`);
                const finalResponse = await llm.chat({
                    messages: iterationMessages,
                    tools: finalTools,
                    thinkingLevel: finalSelection.thinkingLevel,
                    modelOverride: finalSelection.modelId,
                });
                const finalChoice = finalResponse.choices[0];
                if (finalChoice) {
                    if (finalChoice.message.tool_calls?.length) {
                        // PRO wants to keep working — push its message and loop
                        messages.push({
                            role: "assistant",
                            content: finalChoice.message.content || null,
                            tool_calls: finalChoice.message.tool_calls,
                        });
                        lastToolCalls = finalChoice.message.tool_calls.map((tc) => ({
                            function: { name: tc.function.name },
                        }));
                        const batchResults = await executeToolCallsBatch(
                            finalChoice.message.tool_calls as Array<{
                                id: string;
                                function: { name: string; arguments: string };
                            }>,
                            {
                                sendProgress,
                                trackBrowserFn: (fn, args, ok) => {
                                    usedBrowserTools = true;
                                    trackBrowserStep(fn, args, ok, 0);
                                },
                                onError: () => {
                                    errorCount++;
                                },
                                onToolComplete: async (count) => {
                                    if (count > 0 && count % 8 === 0)
                                        await sendProgress(`⏳ Still working... (${count} steps completed)`);
                                },
                                onToolRequest: async (req) => {
                                    const result = await handleToolRequest(req);
                                    requestedCategories = result.categories;
                                    return result.response;
                                },
                                userMessage,
                                toolAllowlist,
                            },
                        );
                        totalToolCalls += batchResults.length;
                        for (const r of batchResults) {
                            const errorMsg = getErrorMessage(r.fnName, r.result);
                            if (errorMsg) await sendProgress(errorMsg);
                            messages.push({
                                role: "tool",
                                tool_call_id: r.toolCallId,
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                content: r.finalContent as any,
                            });
                        }
                        continue;
                    }
                    const rawText = finalChoice.message.content || "";
                    const text = sanitizeAgentResponse(rawText) || "(empty response)";
                    // Retry if final model produced empty response after tool calls
                    if (
                        text === "(empty response)" &&
                        lastToolCalls &&
                        lastToolCalls.length > 0 &&
                        emptyResponseRetries < MAX_EMPTY_RETRIES
                    ) {
                        emptyResponseRetries++;
                        console.log(
                            `  🔄 Empty response from final model after tool calls — retry ${emptyResponseRetries}/${MAX_EMPTY_RETRIES}`,
                        );
                        messages.push({ role: "assistant", content: "" });
                        messages.push({
                            role: "user",
                            content: "You produced an empty response. Please provide a meaningful reply to the user.",
                        });
                        lastToolCalls = undefined;
                        continue;
                    }
                    messages.push({ role: "assistant", content: text });
                    appendTurn("assistant", text);
                    maybeReflect();
                    if (usedBrowserTools) autoSaveSession();
                    // Credits deducted per-API-call in llm.ts
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, true);
                    return { text, toolCalls: totalToolCalls };
                }
            }

            let text = sanitizeAgentResponse(responseText) || "(empty response)";

            // ── Empty response retry: nudge the LLM instead of returning "(empty response)" ──
            if (
                text === "(empty response)" &&
                lastToolCalls &&
                lastToolCalls.length > 0 &&
                emptyResponseRetries < MAX_EMPTY_RETRIES
            ) {
                cbRecordNoProgress(circuitBreaker);
                emptyResponseRetries++;
                console.log(
                    `  🔄 Empty response after tool calls — retry ${emptyResponseRetries}/${MAX_EMPTY_RETRIES}`,
                );
                messages.push({ role: "assistant", content: "" });
                messages.push({
                    role: "user",
                    content: "You produced an empty response. Please provide a meaningful reply to the user.",
                });
                lastToolCalls = undefined;
                continue;
            }

            // ── Cascade escalation: detect poor responses and re-try with a better model ──
            // Only attempt once per turn to avoid infinite loops, and only if not already on the best model
            if (model !== MODELS.PRO && !cascadeAttempted) {
                const cascadeCheck = shouldCascadeEscalate(text, rawUserMessage, model);
                if (cascadeCheck.shouldEscalate) {
                    const nextModel = getCascadeNext(model);
                    if (nextModel) {
                        cascadeAttempted = true;
                        console.log(
                            `  🔄 Cascade escalation: ${cascadeCheck.reason} → ${MODEL_DISPLAY[nextModel] || nextModel}`,
                        );
                        // Feed quality failure back to router for future routing decisions
                        recordQualityFailure(model, selection.taskType, cascadeCheck.reason);
                        try {
                            const escalatedResponse = await llm.chat({
                                messages: iterationMessages,
                                tools: finalTools,
                                thinkingLevel: selection.thinkingLevel,
                                modelOverride: nextModel,
                            });
                            const escalatedText = escalatedResponse.choices?.[0]?.message?.content;
                            if (escalatedText) {
                                text = sanitizeAgentResponse(escalatedText) || text;
                            }
                        } catch (err) {
                            console.warn(`  ⚠️ Cascade escalation failed: ${(err as Error).message}`);
                        }
                    }
                }
            }

            // Circuit breaker: meaningful final response = progress
            if (text && text !== "(empty response)" && text.length > 10) {
                cbRecordProgress(circuitBreaker);
            }

            messages.push({ role: "assistant", content: text });
            appendTurn("assistant", text);
            maybeReflect();
            if (usedBrowserTools) autoSaveSession();

            // Auto-save strategy when a multi-tool task completes
            if (totalToolCalls >= 2 && rawUserMessage) {
                try {
                    const intent = getLastIntent();
                    const pattern = intent ? intent.replace(/\s+/g, "_").toLowerCase() : "general_task";
                    saveStrategy({
                        pattern,
                        description: `Task: "${rawUserMessage.substring(0, 100)}" — completed with ${totalToolCalls} tool calls`,
                        steps: (lastToolCalls || []).map((tc) => tc.function.name).slice(0, 10),
                        success: true,
                        tags: activeCategories || [],
                    });
                } catch {
                    /* non-fatal */
                }
            }

            // Credits deducted per-API-call in llm.ts
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, true);
            return { text, toolCalls: totalToolCalls };
        }

        // Append assistant message with tool calls
        messages.push({
            role: "assistant",
            content: assistantMessage.content || null,
            tool_calls: assistantMessage.tool_calls,
        });

        // Execute tools
        lastToolCalls = assistantMessage.tool_calls.map((tc) => ({
            function: { name: tc.function.name },
        }));

        // ── Execute tools (parallel for non-browser, sequential for browser) ──
        const batchResults = await executeToolCallsBatch(
            assistantMessage.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>,
            {
                sendProgress,
                trackBrowserFn: (fn, args, ok) => {
                    usedBrowserTools = true;
                    trackBrowserStep(fn, args, ok, 0);
                },
                onError: () => {
                    errorCount++;
                },
                onToolComplete: async (count) => {
                    if (count > 0 && count % 8 === 0)
                        await sendProgress(`⏳ Still working... (${count} steps completed)`);
                },
                onToolRequest: async (req) => {
                    const result = await handleToolRequest(req);
                    requestedCategories = result.categories;
                    return result.response;
                },
                userMessage,
                toolAllowlist,
            },
        );
        totalToolCalls += batchResults.length;

        // Circuit breaker: tool calls completed = progress
        const batchHasSuccess = batchResults.some((r) => !r.isError);
        if (batchHasSuccess) {
            cbRecordProgress(circuitBreaker);
        } else if (batchResults.length > 0 && batchResults.every((r) => r.isError)) {
            cbRecordFailure(circuitBreaker);
        }

        // Record intent→tool preferences for personalization
        const usedToolNames = batchResults.map((r) => r.fnName);
        const currentIntent = getLastIntent();
        if (currentIntent && usedToolNames.length > 0) {
            recordIntentToolUsage(currentIntent, usedToolNames);
        }

        // Track tool failures and successes for the learning system
        let lastFailedTool: string | null = null;
        for (const r of batchResults) {
            const content = typeof r.finalContent === "string" ? r.finalContent : JSON.stringify(r.finalContent);
            const isFail = content.includes('"success":false') || content.includes('"error"');
            if (isFail) {
                recordToolFailure(r.fnName, content.substring(0, 200));
                lastFailedTool = r.fnName;
                // World model + self-model: track tool failure
                try {
                    recordWorldFailure(r.fnName, "tool");
                } catch {
                    /* non-fatal */
                }
                try {
                    recordSelfModelOutcome(r.fnName, false, 0);
                } catch {
                    /* non-fatal */
                }
            } else {
                recordToolSuccess(r.fnName);
                // World model + self-model: track tool success
                try {
                    recordWorldSuccess(r.fnName, "tool");
                } catch {
                    /* non-fatal */
                }
                try {
                    recordSelfModelOutcome(r.fnName, true, 0);
                } catch {
                    /* non-fatal */
                }
                // If previous tool failed and this one succeeded → record recovery
                if (lastFailedTool) {
                    recordToolRecovery(lastFailedTool, r.fnName, `${lastFailedTool} failed → ${r.fnName} succeeded`);
                    lastFailedTool = null;
                }
            }
        }

        for (const r of batchResults) {
            const errorMsg = getErrorMessage(r.fnName, r.result);
            if (errorMsg) await sendProgress(errorMsg);
            // Track tool success/failure per model per task type for adaptive routing
            updateToolStats(model, !errorMsg, selection.taskType);
            messages.push({
                role: "tool",
                tool_call_id: r.toolCallId,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                content: r.finalContent as any,
            });

            // ── Working memory: retain significant tool results ──
            try {
                const resultText = typeof r.finalContent === "string" ? r.finalContent : JSON.stringify(r.finalContent);
                const importance = r.isError ? 0.3 : resultText.length > 200 ? 0.7 : 0.5;
                const summary = resultText.length > 150 ? `${resultText.substring(0, 150)}...` : resultText;
                wmRetain(`tool_${r.toolCallId}`, "tool_result", `[${r.fnName}] ${summary}`, importance);
            } catch {
                /* working memory not initialized */
            }

            // ── Metacognition: update signals per tool call ──
            updateSignals(metaState, {
                toolName: r.fnName,
                hadError: r.isError,
                responseLength: r.result.length,
                wasEmpty: r.result.length === 0 || r.result === "{}",
            });
        }

        // ── Delegation Detection ──────────────────────────────────
        // If the agent just called start_long_task, the work is delegated to
        // background sub-agents. Exit immediately to avoid the main agent loop
        // competing with the long-task phases (doing the same work twice).
        const delegatedResult = batchResults.find((r) => r.fnName === "start_long_task" && !r.isError);
        if (delegatedResult) {
            try {
                const delegatedContent =
                    typeof delegatedResult.finalContent === "string"
                        ? delegatedResult.finalContent
                        : JSON.stringify(delegatedResult.finalContent);
                const parsed = JSON.parse(delegatedContent);
                const taskId = parsed.task_id || "unknown";
                const phaseCount = parsed.phases || 0;
                const delegationText = `I've started working on your task in the background (${phaseCount} phases). Task ID: ${taskId}. I'll keep you updated on progress — you can also ask me to check anytime.`;
                messages.push({ role: "assistant", content: delegationText });
                appendTurn("assistant", delegationText);
                if (_harnessTraceId) finalizeTrace(_harnessTraceId, true);
                return { text: delegationText, toolCalls: totalToolCalls };
            } catch {
                /* fall through to normal loop if parse fails */
            }
        }

        // ── Smart Completion Verification ──────────────────────────
        // Instead of hardcoded patterns, check if tool results indicate the task
        // is still in progress vs actually completed. Inject a verification nudge
        // that forces the agent to confirm success before declaring "done".
        const resultTexts = batchResults.map((r) =>
            typeof r.finalContent === "string" ? r.finalContent : JSON.stringify(r.finalContent),
        );
        const allResults = resultTexts.join(" ");

        // Detect states that need further action
        const hasToolFailure = allResults.includes('"success":false') || allResults.includes('"error"');
        const hasAppOpened = allResults.includes('"action":"activate"') || allResults.includes('"action":"launch"');
        const hasClick = allResults.includes('"clicked"') || allResults.includes("os_click");
        const hasSearch = allResults.includes("search_play") || allResults.includes("search_visible");
        const isPlaying = allResults.includes('"playing":true');

        // Key insight: if no verification tool was used in THIS batch, the task isn't done
        const usedVerification = batchResults.some((r) => {
            const content = typeof r.finalContent === "string" ? r.finalContent : JSON.stringify(r.finalContent);
            return (
                (r.fnName === "spotify" && content.includes("now_playing")) ||
                r.fnName === "os_visual_verify" ||
                r.fnName === "os_nav"
            );
        });

        if (
            (hasToolFailure || hasAppOpened || hasSearch || (hasClick && !isPlaying)) &&
            !usedVerification &&
            !musicFastPathActive
        ) {
            messages.push({
                role: "system",
                content: `[VERIFICATION REQUIRED] Your last action may not have completed the task. Before responding to the user:
1. VERIFY the result (e.g., spotify action='now_playing', os_nav to confirm state, os_visual_verify)
2. If verification shows the task isn't done, keep working — try alternative approaches
3. Only tell the user "done" after you have CONFIRMED the task succeeded
Do NOT assume success from a single click or tool call.`,
            });
        }
        if (musicFastPathActive && !hasToolFailure) {
            const sawSpotifyCall = batchResults.some((r) => r.fnName === "spotify" || r.fnName === "music_control");
            if (sawSpotifyCall) {
                messages.push({
                    role: "system",
                    content:
                        "[FAST_PATH_DONE] The music tool returned success. Reply briefly confirming the song is playing (one short sentence). Do NOT call now_playing or any other tool unless the user asks a follow-up question.",
                });
            }
        }

        // ── Periodic progress for long tasks ──
        if (totalToolCalls > 0 && totalToolCalls % 8 === 0) {
            // Build a richer progress message based on what tools were recently used
            const recentTools = lastToolCalls?.map((tc) => tc.function.name).slice(0, 3) || [];
            const toolHint = recentTools.length > 0 ? ` (last: ${recentTools.join(", ")})` : "";
            const tabCount = usedBrowserTools ? " 🌐" : "";
            await sendProgress(`⏳ Still working... (${totalToolCalls} steps done${toolHint}${tabCount})`);
        }
    }
}
