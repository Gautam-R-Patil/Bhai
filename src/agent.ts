// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { AsyncLocalStorage } from "node:async_hooks";
import { checkAccountStatus, getKnownCreditBalance, getSessionCreditStats } from "./account-guard.js";
import {
    injectSystemReminder,
    SYSTEM_REMINDER_EXPLANATION,
    sanitizeUntrustedContent,
} from "./agent/system-reminders.js";
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
import { takeStuckMarker } from "./channel-text.js";
import { historyForCaller } from "./guest-history.js";
import { runWithEvalTraceId } from "./agents/evaluator.js";
import { listActiveLongTasks } from "./agents/long-task.js";
import {
    applyIntervention,
    assess,
    createInterventionState,
    createMetacognitionState,
    type InterventionState,
    logOutcome,
    setCalibrationContext,
    updateSignals,
} from "./agents/metacognition.js";
import { logOrchestratorRouting } from "./agents/orchestrator-routing-log.js";
import {
    enterPlanMode,
    filterToolsForAwaitingApproval,
    filterToolsForPlanMode,
    filterToolsForSpecMode,
    isAwaitingApproval,
    isPlanMode,
    isSpecMode,
    isToolAllowedInCurrentMode,
    planModeReminderBody,
} from "./agents/plan-mode.js";
import { judgeFixToIntervention, progressJudgeEnabled, runProgressJudge } from "./agents/progress-judge.js";
import { smartTruncate } from "./agents/smart-truncate.js";
import {
    canonicalArgsHash,
    createGuardrailState,
    recordToolCall as recordGuardrailCall,
} from "./agents/tool-call-guardrail.js";
import { OFFLOAD_THRESHOLD_BYTES, offloadIfLarge } from "./agents/tool-output-offload.js";
import { trackCursorTurn } from "./screen/agent-cursor.js";
import { withoutGrid } from "./screen/grid-overlay.js";
import { anySecretTyped, hasVaultToken, resetVaultTask, resolveVaultArgs, runVaultCall, secretTypedIn, type VaultCall } from "./security/vault.js";
import {
    buildVerifyReminder,
    drivesScreen as gateDrivesScreen,
    isVerifier,
    newVerifyGateState,
    pickReceipt,
    type Receipt,
    recordBatch as recordBatchForVerifyGate,
    shouldForceVerify,
    type VerifyGateState,
} from "./agents/verify-before-done.js";
import { getDimensionValue } from "./harness/registry.js";
import {
    finalizeTrace,
    recordContextSources,
    recordMemoryHit,
    recordToolsSelected,
    startTrace,
} from "./harness/trace-store.js";
import type { ChatCompletionMessageParam, LLMClient, ThinkingLevel } from "./llm.js";
import { MODEL_DISPLAY, MODELS } from "./llm.js";
import { getLocationSnippet, getTimezone } from "./location/index.js";
import { getAnticipationSnippet, trackSessionForAnticipation } from "./memory/anticipation.js";
import { bhaiDidMemory, didLine } from "./memory/bhai-did.js";
import { buildMemoryCards } from "./memory/cards.js";
import { syncForgetsFromElsewhere } from "./memory/forget.js";
import { classifyQuery } from "./memory/classifier.js";
import { pruneContext } from "./memory/context-pruning.js";
import { getEmotionalContextSnippet } from "./memory/emotional.js";
import { getEpisodicSnippet, noteEpisodeCallbacks } from "./memory/episodic.js";
import { createGoal, detectGoalFromMessage, getGoalsSnippet } from "./memory/goals.js";
import { getIdentityPromptSnippet } from "./memory/identity.js";
import { getProjectMemorySnippet } from "./memory/project-memory.js";
import { runReflection } from "./memory/reflection.js";
import { getRelationshipSnippet } from "./memory/relationship.js";
import { getSelfStateSnippet } from "./memory/self-state.js";
import {
    appendTurn,
    getSessionState,
    getSessionSummary,
    getShortSummary,
    shouldReflect,
    touchSession,
    updateSessionGoal,
} from "./memory/session.js";
// ── Dynamic Context Injections ────────────────
import { ageLabel, getCoreMemory, parseDateWindow, recall, recallConversation, remember } from "./memory/sqlite.js";
import { getStrategyContext, saveStrategy } from "./memory/strategy-library.js";
import {
    buildPlaybook,
    inLaneOrder,
    isVerifiedWin,
    type PlaybookCall,
    playbookTaskText,
    STUCK_NOTE_OPENER,
    verificationFailed,
} from "./memory/playbooks.js";
import { demoteLearnings, getTaskLearningsContext, upsertLearning } from "./memory/task-learnings.js";
import { getTraitsForInjection, resetSessionTraitCaps } from "./memory/traits.js";
import { getWMSnippet, reflect as wmReflect, retain as wmRetain } from "./memory/working-memory.js";
import {
    classifyOrchestratorComplexity,
    claudeTier,
    getCascadeNext,
    type ModelSelection,
    opusWarranted,
    pickOrchestratorModel,
    recordQualityFailure,
    selectForAgent,
    selectForFinalAnswer,
    shouldCascadeEscalate,
    updateToolStats,
} from "./model-router.js";
import { detectTaskType } from "./prompts/dynamic-assembler.js";
import { buildDynamicContextReminder } from "./prompts/dynamic-context.js";
import { lateNightNote, noteOwnerReply } from "./late-night-nudge.js";
import { noteOwnerBusy } from "./proactive/kill-switches.js";
import { isSerious, noteOwnerMood, SHADES_OFF_NOTE } from "./serious-mode.js";
import { noteSignaturePhrase, signaturePhraseNote } from "./setup/personality-sync.js";
import { noteOwnerMessage } from "./security/consent.js";
import { CODE_TOOLS, protect, REVEAL_TOOLS, reveal, revealArgs } from "./security/pii-vault.js";
import { isToolAllowed, NON_OWNER_TOOLS } from "./security/tool-access.js";
import { formatStepStatus, SELF_REPORTING_TOOLS, startStepHeartbeat } from "./step-status.js";
import {
    clearToolRouterState,
    getLastIntent,
    handleToolRequest,
    isRequestToolsCall,
    selectTools,
    selectToolsFast,
} from "./tool-router.js";
import { getPreferredTools, recordIntentToolUsage } from "./tool-router-analytics.js";
import { autoSaveSession, getBrowserContext, trackBrowserStep } from "./tools/browser-memory.js";
import { noteShownMemories, runAsMainLoopTool } from "./tools/cron-tool.js";
import { runQuickCommand } from "./quick-commands.js";
import * as learnedRouter from "./routing/learned-router.js";
import { clearCache, executeTool, resetRateLimits, withTurnSignal } from "./tools/index.js";
import { sendFailed, withSendLedger } from "./tools/send-ledger.js";
import { ownerMemoryTool } from "./tools/tool-intelligence.js";

// ── Music fast-path helpers ──────────────────────
// Short-circuits the Sonnet orchestrator + memory injection when the LLM
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
 * memory injection, and the auto-verification loop.
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
// only to skip the memory injection — any false positive here just
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

/** Periodic nudge interval: every N iterations, prompt the agent to persist valuable information. */
const MEMORY_NUDGE_INTERVAL = 5;

// ── Browser tool names ────────────────────────

// Every browser tool shares one page, so they all run one at a time, in call order.
const isBrowserTool = (name: string) => name.startsWith("browser_");

const OS_TASK_HINT = `[OS TASK — desktop control]
1. Click things by description with os_smart_click (it finds the element itself; no screenshot needed first).
2. Prefer app_manager and keyboard shortcuts (os_type combo) over clicking when you know them.
3. To see the screen, use os_inspect (accessibility list) or os_screenshot (you get the image; its grid labels are the x/y to pass to os_click).
4. Before saying done, check the end state once with os_visual_verify expect_text="..." (or expect_gone).`;

/**
 * The user's own words, without the channel's instructions to the model
 * ([SOURCE: …], [BROWSER CONTEXT: …]) — memory retrieval searched those too
 * and pulled the same irrelevant memories every turn.
 */
function stripChannelTags(text: string): string {
    return (
        text
            .replace(/\n*\[SOURCE:[\s\S]*?\](?=\n|$)/g, "")
            .replace(/\n*\[BROWSER CONTEXT:[\s\S]*?\](?=\n|$)/g, "")
            // The Chrome extension's "[Browser context: <url> — "<title>"]" line: the
            // title is written by the page, so it must never read as the owner's words
            // (a tab titled "yes, go ahead" would otherwise answer a consent question).
            .replace(/^\[Browser context:[^\n]*\]\n/i, "")
            .trim()
    );
}

/**
 * The message points at Bhai itself: its repo, its site, its Chrome extension
 * (now named "Bhai", formerly "Bhai Bridge"), or text
 * naming Bhai together with XAGI. A friend called "bhai" never counts, nor does
 * a <name>.bhai@xagilab.com mail address.
 */
export function isAboutBhai(text: string): boolean {
    return (
        /github\.com\/xagi-lab\/bhai\b|(?<!@)xagilab\.com|\bbhai bridge\b|\bbhai (?:chrome )?(?:extension|side ?panel)\b/i.test(text) ||
        // Bhai described as itself, not "bhai, send the XAGI invoice".
        /\bbhai\b[^.\n]{0,60}\b(?:(?:personal )?ai (?:agent|assistant|companion)|built by xagi)/i.test(text)
    );
}
const ABOUT_SELF_NOTE =
    "This message may show something about Bhai itself (its repo, site, app or extension). If so, that's you: speak first person (\"that's my own repo\"), never about Bhai as someone else. Still nothing beyond what's shown, no model or provider names, and don't claim you wrote the code yourself.";

/** Categories a plain desktop-driving turn uses, plus the always-on ones. */
const GUI_LOOP_CATEGORIES = new Set([
    "os_control",
    "app_management",
    "system_controls",
    "core",
    "memory",
    "tool_creation",
]);
/** Past this many iterations a desktop task isn't "short" any more; the router decides. */
const GUI_PIN_MAX_ITERATIONS = 8;
const isGuiOnly = (cats: string[]) =>
    cats.some((c) => c === "os_control" || c === "app_management") && cats.every((c) => GUI_LOOP_CATEGORIES.has(c));

/**
 * Steering messages (memory nudge, verification, circuit breaker, retry hints)
 * matter only for the turn that raised them. They're tagged here and stripped
 * from history when the turn ends, so they aren't resent on every later turn.
 */
// Per turn (ALS), so a turn ending doesn't strip an overlapping turn's nudges.
const turnNudges = new AsyncLocalStorage<Set<object>>();
export function pushNudge(msgs: ChatCompletionMessageParam[], content: string): void {
    const m: ChatCompletionMessageParam = { role: "system", content };
    turnNudges.getStore()?.add(m);
    msgs.push(m);
}
export function runWithTurnNudges<T>(owned: Set<object>, fn: () => T): T {
    return turnNudges.run(owned, fn);
}
export function stripTurnNudges(msgs: ChatCompletionMessageParam[], owned: ReadonlySet<object>): void {
    for (let i = msgs.length - 1; i >= 0; i--) if (owned.has(msgs[i])) msgs.splice(i, 1);
}

/**
 * Send the model back for another pass: its draft reply plus a steering note, both kept
 * only for this turn. Left in the history they read, next turn, as a reply nobody got
 * and as words the owner never said.
 */
export function pushRetry(msgs: ChatCompletionMessageParam[], draft: string, note: string): void {
    const a: ChatCompletionMessageParam = { role: "assistant", content: draft };
    const u: ChatCompletionMessageParam = { role: "user", content: `[Automatic check, not from the owner] ${note}` };
    turnNudges.getStore()?.add(a);
    turnNudges.getStore()?.add(u);
    msgs.push(a, u);
}

/**
 * The turn's contract: the done-criterion Bhai stated in its ack ("on it — …;
 * done = it shows in Sent"). The marker is "done =" at the start of the line or
 * after a clause break (". ", ", ", "; ", ": ", —, – or " - "), so "All done!",
 * "done: …", "done when …" and `state.done = true` never count, nor does code.
 */
const DONE_RE = /(?:^|[.,;:]\s|[—–]|\s-\s)\s*done\s*=\s*(.+)/i;
/** First prose line with the marker, `*` dropped, plus the criterion after it; code (fenced or `inline`) never counts. */
function matchAck(text: string | null | undefined): { line: string; contract: string } | undefined {
    let inFence = false;
    for (const raw of sanitizeAgentResponse(text ?? "").split("\n")) {
        if (/^\s*(```|~~~)/.test(raw)) {
            inFence = !inFence;
            continue;
        }
        const line = raw.replace(/\*/g, "");
        // Mask `code` at the same length so the marker is found only in prose, then read the criterion from the real line.
        const m = inFence ? null : DONE_RE.exec(line.replace(/`[^`]*`/g, (c) => "\0".repeat(c.length)));
        if (!m) continue;
        const contract = line.slice(m.index + m[0].length - m[1].length).replace(/`/g, "").trim().slice(0, 200);
        return { line: line.replace(/`/g, "").trim(), contract };
    }
    return undefined;
}
/** The ack line, cleaned for the user: internal tags and `*`/`` ` `` markup dropped. */
export function findAckLine(text: string | null | undefined): string | undefined {
    return matchAck(text)?.line;
}
export function extractDoneContract(text: string | null | undefined): string | undefined {
    return matchAck(text)?.contract || undefined;
}

/**
 * The "[ACK] …" progress line channels show for a reply: only when it states a
 * contract AND has tool calls, i.e. the work is actually starting. A reply with
 * no tool calls is the final answer (maybe a confirm-first question), never an ack.
 */
export function contractProgressLine(content: string | null | undefined, hasToolCalls: boolean): string | undefined {
    const ack = hasToolCalls && extractDoneContract(content) ? findAckLine(content) : undefined;
    return ack && `[ACK] ${ack}`;
}

/** A final reply that only announces the work ("on it — …; done = …") with no tool call made yet. */
export function ackWithoutAction(reply: string, toolCallsSoFar: number): boolean {
    return toolCallsSoFar === 0 && !!extractDoneContract(reply) && !takeStuckMarker(reply).stuck;
}

/** Steers the verify step to check the criterion the agent itself promised. */
export function contractCheckNudge(contract: string): string {
    return `Your own done-criterion was: "${contract}". Check exactly that and say what you saw.`;
}

/** An honest stuck report: why it stopped, what it tried, that it isn't done, and the owner's options. */
export function stuckNote(stopped: string, triedTools: string[], contract?: string): string {
    const tried = [...new Set(triedTools)].slice(-5);
    return [
        `${STUCK_NOTE_OPENER} ${stopped}.`,
        tried.length > 0 ? `I tried ${tried.join(", ")}.` : "",
        contract ? `It isn't done yet (done = ${contract}).` : "It isn't done yet.",
        "I can retry with a different approach, or you can take over from here.",
    ]
        .filter(Boolean)
        .join(" ");
}

/**
 * The reply for a turn that stopped early: the latest text the model wrote this turn, but never the
 * ack ("on it …; done = …" reads as still working), else an honest stuck note.
 */
export function stuckExitText(
    messages: ChatCompletionMessageParam[],
    stopped: string,
    triedTools: string[],
    contract?: string,
): string {
    let turnStart = messages.length - 1;
    while (turnStart >= 0 && messages[turnStart].role !== "user") turnStart--;
    const partial = messages
        .slice(turnStart + 1)
        .flatMap((m) =>
            m.role === "assistant" &&
            typeof m.content === "string" &&
            m.content.trim() &&
            !extractDoneContract(m.content)
                ? [m.content]
                : [],
        )
        .pop();
    return partial ?? stuckNote(stopped, triedTools, contract);
}

/** The verify gate wants one more iteration, unless the final reply is a stuck report (the agreed handoff). */
export function verifyGateFires(gate: VerifyGateState, responseText: string): boolean {
    return !takeStuckMarker(responseText).stuck && shouldForceVerify(gate);
}

/** The orchestrator's TOOLS block, built from the tools this turn actually offers. */
export function planToolsBlock(tools: Array<{ function?: { name: string; description?: string } }>): string {
    return tools
        .flatMap((t) => (t.function?.name ? [t.function] : []))
        .map((f) => `- ${f.name}: ${(f.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 160)}`)
        .join("\n");
}

const HARD_DECISION_TOOLS = new Set(["web_search", "shell_exec", "memory_store"]);

/** Tools whose results don't affect conversation flow — executed in background, synthetic success returned immediately */
const DEFERRABLE_TOOLS = new Set(["memory_store"]);

/** A pin or supersede can be refused, so the model must see the real result rather than "Saved.". */
export function isDeferrable(tc: { function: { name: string; arguments: string } }): boolean {
    if (!DEFERRABLE_TOOLS.has(tc.function.name)) return false;
    try {
        const a = JSON.parse(tc.function.arguments || "{}");
        return a.pin_id == null && a.supersedes == null && a.pin !== true;
    } catch {
        return true;
    }
}

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

/** Channels that stay silent when the whole reply is [NO_REPLY]; the overlay and the rest always answer. */
const NO_REPLY_CHANNELS = new Set(["telegram", "whatsapp", "discord", "slack", "matrix", "email"]);

const PHONE_CHAT = "phone chat: 1-2 short lines unless they asked for detail; no headings or tables";
const TEAM_CHAT = "team chat: short; markdown lists and code blocks are fine";
/** How a reply should look on each channel; the only place reply length and markup are set per channel. */
const CHANNEL_REGISTER: Record<string, string> = {
    telegram: PHONE_CHAT,
    whatsapp: PHONE_CHAT,
    discord: TEAM_CHAT,
    slack: TEAM_CHAT,
    matrix: TEAM_CHAT,
    email: "email: full sentences, no emoji or chat slang, greeting/sign-off only if theirs had one",
    overlay:
        'desktop overlay: short by default, full answer when asked. Markers go at the END: <!--QUICK_ACTIONS:["Option 1","Option 2"]--> for a choice or confirmation (always before deleting, overwriting, installing or anything destructive); <!--COLLAPSE:Title-->long content<!--/COLLAPSE--> around code over 5 lines or lists over 5 items; for the time here output exactly <!--WIDGET: {"type": "clock"}--> instead of the time; for another place, write its time in words and add <!--WIDGET: {"type": "clock", "tz": "Asia/Tokyo", "label": "Tokyo"}--> with its IANA zone',
};

/** The final reply as channels get it: an exact [NO_REPLY] on a silent-capable, user-typed turn survives sanitizing. */
export function finalReplyText(raw: string, channelContext?: ChannelContext): string {
    if (
        raw.trim().toUpperCase() === "[NO_REPLY]" &&
        channelContext &&
        !channelContext.autonomous &&
        NO_REPLY_CHANNELS.has(channelContext.channel)
    ) {
        return "[NO_REPLY]";
    }
    const text = sanitizeAgentResponse(raw);
    // Overlay markers (<!--QUICK_ACTIONS-->, <!--WIDGET-->, <!--COLLAPSE-->) mean nothing elsewhere and would show
    // as literal text. Only those: other HTML comments can be real content (code, "A --> B").
    return channelContext?.channel === "overlay"
        ? text
        : text.replace(/<!--\s*(?:QUICK_ACTIONS|WIDGET|\/?COLLAPSE)\b[\s\S]*?-->/g, "").trim();
}

/**
 * Anti-giving-up guard: an action task the reply hands back to the user (or gives up on)
 * right after a tool failure. Returns how many recent tool results failed when it should
 * force a retry, else 0. A stuck report ([[STUCK]]) is the agreed hand-off, so never over it.
 */
export function antiGivingUpFailures(
    messages: ChatCompletionMessageParam[],
    lastUserText: string,
    responseText: string,
    totalToolCalls: number,
): number {
    if (takeStuckMarker(responseText).stuck) return 0;
    const lower = responseText.toLowerCase();
    const failures = messages.slice(-10).filter((m) => {
        if (m.role !== "tool") return false;
        const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return (
            txt.includes('"error"') ||
            txt.includes('"success":false') ||
            txt.includes("NOT_PLAYING") ||
            txt.includes("NO_RESULTS") ||
            txt.includes("failed")
        );
    }).length;
    if (failures === 0 || totalToolCalls >= 15) return 0;
    const isActionTask =
        /\b(play|open|send|create|set|start|stop|run|install|build|find|show|take|click|type|write|download|upload|schedule|remind|pause|skip|next|search)\b/i.test(
            lastUserText,
        );
    const isDelegatingToUser = [
        "you can ",
        "you should ",
        "you need to ",
        "you'll need to",
        "go ahead and ",
        "from there",
        "i recommend you",
    ].some((p) => lower.includes(p));
    const isGivingUp = [
        "want me to try",
        "shall i try",
        "something else?",
        "another way",
        "isn't finding",
        "not finding",
        "couldn't find",
        "not in your library",
        "not available",
        "something's off",
        "having trouble",
        "doesn't seem",
        "unable to",
    ].some((p) => lower.includes(p));
    // Substantial replies (>200 chars) delegating to the user are likely genuine instructions.
    const fire = (isDelegatingToUser && isActionTask && responseText.length < 200) || isGivingUp;
    return fire ? failures : 0;
}

/**
 * A reply that says the task isn't finished and asks leave for its own next step, when
 * that step only looks ("Want me to take a screenshot and read them?"). Looking is part
 * of the task the owner already gave; asking first just stalls it. A step with effects
 * outside (send, pay, delete…) still gets asked.
 */
export function asksLeaveToLook(responseText: string, canSeeScreen = false): boolean {
    if (takeStuckMarker(responseText).stuck) return false;
    const l = responseText.toLowerCase().replace(/[’‘]/g, "'");
    // "I can't read the name. If you can see it in the Wi-Fi menu, tell me": with screen
    // tools in hand, looking is Bhai's job, not the owner's.
    if (
        canSeeScreen &&
        /\b(can't|cannot|couldn't|unable to|not able to|don't have|do not have)\b/.test(l) &&
        /\bif you (can )?(see|check|look|open|click)\b|\btell me (the|what|which|its) [a-z -]{0,30}(from|in|on) (the|your) |\b(check|look at|read) (it|that|the [a-z -]{1,30}) (yourself|on your screen)\b|\byou(?:'ll| will| can) (see|find) (it|the [a-z -]{1,30}) (in|on|under)\b/.test(
            l,
        )
    )
        return true;
    if (!/\b(haven't|have not|not yet|isn't (finished|done|complete)|not (finished|done|complete))\b/.test(l)) return false;
    const ask = /\b(?:do you want me to|want me to|should i|shall i)\b([^?]{0,100})\?/.exec(l)?.[1];
    return (
        !!ask &&
        /\b(screenshot|read|look|check|scan|list|inspect|search|see|open it)\b/.test(ask) &&
        !/\b(send|post|buy|pay|delete|remove|submit|order|book|reply|email|message|call|share|install)\b/.test(ask)
    );
}

// There is no in-app purchase yet (Account shows the balance only), so don't send people
// looking for a top-up button.
const OUT_OF_CREDITS_REPLY =
    "You're out of AI credits, so I can't do this right now. Credits can't be bought in the app yet: reach the XAGI Labs team at xagilab.com for more, then ask me again.";

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
    browser_scan: 6000, // status/captcha/tip fields come after the element list
    browser_extract: 3000,
    browser_analyze: 2500,
    browser_run_js: 3000,
    shell_exec: 4000,
    read: 5000,
    grep: 4000,
    glob: 2000,
    deep_research: 6000,
    os_inspect: 8000, // a whole 60-element list, still under the 8KB offload line
    // failures[] + raw_tail; bigger results are offloaded with a head+tail preview. A result
    // that stayed inline is at most this many bytes, so at most this many chars: kept whole.
    test_run: OFFLOAD_THRESHOLD_BYTES,
};
const DEFAULT_RESULT_LIMIT = 4000;

function truncateToolResult(toolName: string, result: string): string {
    const limit = TOOL_RESULT_LIMITS[toolName] ?? DEFAULT_RESULT_LIMIT;
    if (result.length <= limit) return result;
    // Shell output keeps its tail: compilers and test runners print the errors last.
    if (toolName.startsWith("shell_")) return smartTruncate(toolName, result, limit);
    const safe = protect(result, { credentials: !CODE_TOOLS.has(toolName) }); // mask before cutting
    if (safe.length <= limit) return safe;
    return `${safe.substring(0, limit)}\n[... truncated from ${safe.length} chars]`;
}

/**
 * Screenshots ride in tool results and stay in the shared history, so a long
 * GUI turn would resend every one on every call (and can pass the proxy's body
 * limit). Once more than 6 pile up, keep the newest 3 — in a batch, so the
 * prompt cache isn't broken on every step.
 */
function pruneOldScreenshots(msgs: ChatCompletionMessageParam[]): void {
    const spots: Array<{ parts: Array<Record<string, unknown>>; i: number }> = [];
    for (const m of msgs) {
        if (m.role !== "tool" || !Array.isArray(m.content)) continue;
        const parts = m.content as unknown as Array<Record<string, unknown>>;
        parts.forEach((p, i) => {
            if (p.type === "image_url") spots.push({ parts, i });
        });
    }
    if (spots.length <= 6) return;
    for (const { parts, i } of spots.slice(0, -3)) parts[i] = { type: "text", text: "[earlier screenshot removed]" };
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
    /** The turn ended in a stuck report: Bhai needs the user to unblock it. */
    stuck?: boolean;
    /** The screenshot taken after the turn's last action, for the owner's private chat (pickReceipt). */
    receipt?: Receipt;
    /** The memory this owner turn stored last, for a one-tap "Forget that" (memoryUndoAction). */
    memoryUndo?: { id: number; at: number };
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
    /** A one-to-one conversation with the owner (not a group or public channel). */
    isPrivate?: boolean;
    contactProfile?: any; // WhatsApp ContactProfile
    /** A run nobody typed (scheduled task, research follow-up): it can't answer a consent question. */
    autonomous?: boolean;
    /**
     * A run steered by content nobody vetted (the research follow-up reads web pages): it may
     * read and report, never send, post, buy, book or delete — it suggests, the owner acts.
     */
    noOutward?: boolean;
}

// ── Session State ─────────────────────────────

let conversationHistory: ChatCompletionMessageParam[] = [];
const MAX_CONVERSATION_HISTORY = 200; // Hard cap to prevent unbounded memory growth

type PendingPrune = { base: ChatCompletionMessageParam[]; result: Awaited<ReturnType<typeof pruneContext>> } | null;
/** A prune started at the end of the last turn over a snapshot (`base`) of the history. */
let pendingPrune: Promise<PendingPrune> | null = null;
const MAX_SUMMARYLESS_PRUNES = 3;
let summarylessPrunes = 0;

/**
 * Swap a background prune into the live history: its summary replaces the
 * snapshot, and whatever was appended since is kept. Null when there's
 * nothing to apply or the history changed under it (cleared, capped).
 */
export function applyPendingPrune(
    history: ChatCompletionMessageParam[],
    pending: PendingPrune,
): ChatCompletionMessageParam[] | null {
    if (!pending || pending.result.pruned === 0) return null;
    const { base, result } = pending;
    if (history.length < base.length || !base.every((m, i) => history[i] === m)) return null;
    // No summary = the summary call failed (402/offline): don't drop context
    // unsummarized; the next turn's prune retries. Only a few times, though: a
    // call that keeps failing (timeout, oversized prompt) would otherwise pin
    // the history at the hard cap and re-pay the summary + fact flush each turn.
    if (!result.summary && ++summarylessPrunes < MAX_SUMMARYLESS_PRUNES) return null;
    summarylessPrunes = 0;
    console.log(`  ✂️ Pruned ${result.pruned} old messages`);
    return [...result.messages, ...history.slice(base.length)];
}
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

/** JSON.parse that also reads a result wrapped in the untrusted-content fence. */
function parseToolJson(result: string): Record<string, unknown> | null {
    try {
        return JSON.parse(result);
    } catch {
        const a = result.indexOf("{");
        const b = result.lastIndexOf("}");
        if (a < 0 || b <= a) return null;
        try {
            return JSON.parse(result.slice(a, b + 1));
        } catch {
            return null;
        }
    }
}

function getErrorMessage(toolName: string, result: string): string | null {
    try {
        const parsed = parseToolJson(result);
        if (parsed?.error) {
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
    /** Ran, but its JSON result said `success: false` (not an error, so no self-heal / escalation). */
    reportedFailure?: boolean;
    /** The screenshot lifted out of the result (data URL), unless it was withheld. */
    imageUrl?: string;
    /** The same screen without the model's coordinate grid, for a done-receipt (unset if it couldn't be made). */
    receiptUrl?: string;
    /** Touched the vault (a vault tool or a {{vault:…}} token) or had its screenshot withheld. */
    secret?: boolean;
}

/** The tool call failed, judged from its own result flags, not from the word "error" in its output. */
export const toolFailed = (r: { isError: boolean; reportedFailure?: boolean }): boolean =>
    r.isError || r.reportedFailure === true;

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

/** True when the live browser tab's origin had a saved secret typed into it (screenshots are withheld there). */
async function browserOriginTainted(): Promise<boolean> {
    try {
        const { getActivePage } = await import("./tools/browser/core.js");
        const { liveUrl } = await import("./tools/browser/vault-typing.js");
        return secretTypedIn(new URL(await liveUrl(await getActivePage())).origin);
    } catch {
        return true; // can't tell + a secret was typed this task → withhold, don't risk a leak
    }
}

/**
 * Execute a single tool call and process the result (screenshot extraction, error detection).
 */
async function executeAndProcessToolCall(
    toolCall: { id: string; function: { name: string; arguments: string } },
    onToolRequest?: (request: { capability: string; reason: string }) => Promise<string>,
    userMessage?: string,
    toolAllowlist?: string[],
    channelContext?: ChannelContext,
    signal?: AbortSignal,
): Promise<ToolCallResult> {
    const fnName = toolCall.function.name;
    let fnArgs: Record<string, unknown> = {};
    try {
        fnArgs = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
        fnArgs = {};
    }

    // ── Reject obviously malformed tool names ──
    // Fallback chains sometimes return mangled tool_call envelopes (single
    // letter, empty, or trimmed names like "a" / "o") that aren't real tools
    // and waste an iteration each time. Tool names in the registry are all
    // ≥3 chars and alphanumeric+underscore; reject anything shorter so the
    // loop bails out and the agent can move on.
    if (!fnName || fnName.length < 3 || !/^[a-z_][a-z0-9_]*$/i.test(fnName)) {
        const err = `Malformed tool call: name="${fnName}". The provider returned a truncated/invalid tool envelope. Skip this and try a different approach (try a simpler tool or stop and report progress to the user).`;
        return {
            toolCallId: toolCall.id,
            fnName,
            fnArgs,
            result: JSON.stringify({ error: err }),
            finalContent: JSON.stringify({ error: err }),
            isBrowser: false,
            isError: true,
        };
    }

    // ── Stopped by the user: nothing new runs after Stop (no half-sent form) ──
    if (signal?.aborted) {
        const err = JSON.stringify({ error: "Stopped by the user before this ran." });
        return {
            toolCallId: toolCall.id,
            fnName,
            fnArgs,
            result: err,
            finalContent: err,
            isBrowser: false,
            isError: true,
        };
    }

    // ── Hard block: reject tools not in the allowlist (defense-in-depth) ──
    if (!isToolAllowed(toolAllowlist, fnName)) {
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

    // Inject original user prompt + caller channel context for tools that support
    // continuation (e.g. deep_research). The continuation re-invokes runAgent in a
    // background .then() block; without channelContext it would run as a non-owner
    // and tools that gate on owner identity would refuse.
    if (fnName === "deep_research" && userMessage) {
        fnArgs._originalPrompt = userMessage;
        if (channelContext) fnArgs._channelContext = channelContext;
    }

    // ── Handle request_tools meta-tool (bidirectional router communication) ──
    if (isRequestToolsCall(fnName) && onToolRequest) {
        const result = await onToolRequest({
            capability: (fnArgs.capability as string) || "",
            reason: (fnArgs.reason as string) || "",
        });
        console.log(`  🔧 Tool call: ${fnName}`, JSON.stringify(fnArgs));
        console.log(`  ✅ Tool result: ${ownerMemoryTool(fnName) ? `(${result.length} chars)` : result.substring(0, 500)}`);
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

    console.log(`  🔧 Tool call: ${fnName}`, JSON.stringify(ownerMemoryTool(fnName) ? Object.keys(fnArgs) : fnArgs));

    // ── Pre-flight: catch obvious precondition failures before wasting
    // an actual tool round-trip. Fails open on any error; only short-circuits
    // when we have HIGH confidence the call would fail anyway (file-missing,
    // relative-path-where-absolute-required, malformed URL, etc).
    try {
        const { preflight } = await import("./tools/preflight.js");
        const hint = preflight(fnName, fnArgs);
        if (hint) {
            // Preflight's hint is already LLM-actionable ("file missing",
            // "use absolute path"). Return early with isError=true and
            // preflight=true marker; downstream self-heal honors this flag
            // by NOT trying a generic dependency fix (nothing to fix here).
            const suggested = hint.suggest ? ` Suggestion: ${hint.suggest}` : "";
            const errJson = JSON.stringify({ error: hint.reason + suggested, preflight: true });
            console.log(`  ⚠️  Preflight blocked: ${hint.reason}`);
            const result = truncateToolResult(fnName, errJson);
            return {
                toolCallId: toolCall.id,
                fnName,
                fnArgs,
                result,
                finalContent: result,
                isBrowser: false,
                isError: true,
            };
        }
    } catch {
        /* preflight module failure is non-fatal — fall through */
    }

    // Plan-mode runtime gate. The schema filter strips mutation tools BEFORE
    // the LLM sees them, but a determined model (or a stale tool-call from a
    // prior iteration) can still emit a blocked name — refuse here so the
    // execution layer is the last line of defense.
    if (!isToolAllowedInCurrentMode(fnName)) {
        const err = JSON.stringify({
            error: `Tool "${fnName}" is not allowed in the current plan-mode state.`,
        });
        return {
            toolCallId: toolCall.id,
            fnName,
            fnArgs,
            result: err,
            finalContent: err,
            isBrowser: false,
            isError: true,
        };
    }

    // Typing tools get real values for any [OTP_1]-style handles the model used;
    // fnArgs (logs, history, gates) keeps the handles.
    let execArgs = REVEAL_TOOLS.has(fnName) && channelContext?.isOwner === true ? revealArgs(fnArgs) : fnArgs;
    // Saved secrets ({{vault:id.password}}) too, under the vault's domain lock
    // and consent rules (security/vault.ts). Refused → the model gets the reason.
    // The call then runs inside runVaultCall: the typing tool re-checks the
    // origin where the keys land, and hooks only see tokens.
    let vault: VaultCall | undefined;
    if (REVEAL_TOOLS.has(fnName) && hasVaultToken(fnArgs)) {
        const v = await resolveVaultArgs(fnName, execArgs, {
            isOwner: channelContext?.isOwner === true,
            pageUrl: async () => {
                const { getActivePage } = await import("./tools/browser/core.js");
                const { liveUrl } = await import("./tools/browser/vault-typing.js");
                return liveUrl(await getActivePage());
            },
        });
        if ("error" in v) {
            const err = JSON.stringify({ error: v.error });
            return {
                toolCallId: toolCall.id,
                fnName,
                fnArgs,
                result: err,
                finalContent: err,
                isBrowser: false,
                isError: true,
                secret: true,
            };
        }
        execArgs = v.args;
        vault = { tool: fnName, rules: v.rules };
    }
    // Stop reaches long waits on the owner, also inside sub-agents/swarms this call starts.
    const runTool = () => {
        const run = () => runAsMainLoopTool(fnName, () => withTurnSignal(signal, () => executeTool(fnName, execArgs)));
        return vault ? runVaultCall(vault, run) : run();
    };
    let rawResult = await runTool();

    // ── Self-heal: if tool failed with a dependency error, auto-fix and retry ──
    let isError = false;
    let reportedFailure = false;
    try {
        const p = JSON.parse(rawResult);
        if (p.error) isError = true;
        reportedFailure = p?.success === false;
    } catch {
        /* not json */
    }
    if (isError) {
        try {
            const { attemptSelfHeal } = await import("./agents/self-heal.js");
            const heal = await attemptSelfHeal(rawResult);
            if (heal.fixed) {
                console.log(`  🔧 Self-healed (${heal.action}) — retrying ${fnName}`);
                rawResult = await runTool();
                isError = false;
                reportedFailure = false;
                try {
                    const p = JSON.parse(rawResult);
                    if (p.error) isError = true;
                    reportedFailure = p?.success === false;
                } catch {
                    /* not json */
                }
            }
        } catch {
            /* self-heal module not loaded — continue normally */
        }
    }

    // Lift a screenshot out before offload/truncate/fencing, which would
    // otherwise turn it into a few KB of base64 text the model can't see.
    let imageUrl: string | undefined;
    let receiptUrl: string | undefined;
    let secret = fnName.startsWith("vault_") || hasVaultToken(fnArgs);
    try {
        const parsed = JSON.parse(rawResult);
        const b64 = parsed.screenshot_base64 || parsed.zoomed_base64;
        if (b64) {
            // A browser screenshot of a page a saved secret was typed into can show the
            // value — a field that echoed it, a card/UPI preview, a split input that
            // auto-advanced — and an image is never masked (protect() can't touch pixels).
            // Withhold it; the model still reads the page via browser_scan/extract (text,
            // which IS masked). Only pay the origin lookup once a secret has been typed.
            // A browser screenshot: withhold if the live tab's origin is tainted.
            // Any full-screen capture (os_screenshot, os_smart_click, os_computer_action
            // …): withhold whenever a secret was typed into any browser page this task,
            // since the capture can include that window whatever tab is active.
            const withhold =
                anySecretTyped() &&
                (fnName.startsWith("browser_") ? await browserOriginTainted() : true);
            if (withhold) {
                secret = true;
                delete parsed.screenshot_base64;
                delete parsed.zoomed_base64;
                delete parsed.mime_type;
                parsed.image_attached = false;
                parsed.screenshot_withheld =
                    "A saved secret was typed on this page, so its screenshot is withheld (it could show the value). Use browser_scan or browser_extract to read the page.";
                rawResult = JSON.stringify(parsed);
            } else {
                // The API rejects oversized images (e.g. a full-page browser capture).
                const { downscaleForVision } = await import("./screen/ui-tars.js");
                const img = await downscaleForVision(Buffer.from(b64, "base64"));
                imageUrl = `data:${img.mime};base64,${img.buf.toString("base64")}`;
                // The owner's receipt is the screen without the grid. Look the clean copy up by the
                // tool's own bytes: once downscaled they no longer match the grid cache's key.
                const clean = await withoutGrid(b64);
                if (clean) {
                    const c = clean === b64 ? img : await downscaleForVision(Buffer.from(clean, "base64"));
                    receiptUrl = `data:${c.mime};base64,${c.buf.toString("base64")}`;
                }
                delete parsed.screenshot_base64;
                delete parsed.zoomed_base64;
                delete parsed.mime_type;
                parsed.image_attached = true;
                rawResult = JSON.stringify(parsed);
            }
        }
    } catch {
        /* not json */
    }

    // A call that typed a saved secret: mask its result now, while every value
    // it typed (a CVV too) is still known, not only before the next LLM call.
    if (vault) rawResult = protect(rawResult, { credentials: !CODE_TOOLS.has(fnName) });

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

    let result = truncateToolResult(fnName, workingResult);
    console.log(`  ✅ Tool result: ${ownerMemoryTool(fnName) ? `(${result.length} chars)` : result.substring(0, 500)}`);

    // Fence attacker-influenceable tool output (web/browser/MCP/research) so the
    // model treats it as data, not instructions (indirect prompt-injection
    // defense). Applied after offload/truncate so both the inline result and any
    // disk-offload preview are covered. Disable with ATLAS_NO_UNTRUSTED_WRAP=true.
    if (process.env.ATLAS_NO_UNTRUSTED_WRAP !== "true") {
        try {
            const { isUntrustedToolResult, wrapUntrustedToolResult } = await import("./context-scrubber.js");
            if (isUntrustedToolResult(fnName)) {
                result = wrapUntrustedToolResult(fnName, result);
            }
        } catch {
            /* scrubber unavailable — leave result unfenced */
        }
    }

    const isBrowser = isBrowserTool(fnName);

    const finalContent: string | Array<Record<string, unknown>> = imageUrl
        ? [
              { type: "text", text: result },
              { type: "image_url", image_url: { url: imageUrl } },
          ]
        : result;

    return {
        toolCallId: toolCall.id,
        fnName,
        fnArgs,
        result,
        finalContent,
        isBrowser,
        isError,
        reportedFailure,
        imageUrl,
        receiptUrl,
        secret,
    };
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
        /** A tool's status line ("🌐 Opening …"); the caller stamps it with the step and elapsed time. */
        sendStatus: (status: string) => Promise<void>;
        trackBrowserFn: (fnName: string, fnArgs: Record<string, unknown>, success: boolean) => void;
        onError: () => void;
        onToolComplete: (count: number) => Promise<void>;
        onToolRequest?: (request: { capability: string; reason: string }) => Promise<string>;
        userMessage?: string;
        toolAllowlist?: string[];
        channelContext?: ChannelContext;
        signal?: AbortSignal;
    },
): Promise<ToolCallResult[]> {
    // Separate browser, non-browser, and deferrable tool calls while preserving order
    const browserCalls: typeof toolCalls = [];
    const nonBrowserCalls: typeof toolCalls = [];
    const deferrableCalls: typeof toolCalls = [];

    for (const tc of toolCalls) {
        const fnName = tc.function.name;
        if (isBrowserTool(fnName)) {
            browserCalls.push(tc);
        } else if (isDeferrable(tc)) {
            deferrableCalls.push(tc);
        } else {
            nonBrowserCalls.push(tc);
        }
    }

    const results: ToolCallResult[] = [];

    // Fire deferrable tools in background (don't await — synthetic results returned immediately).
    // executeAndProcessToolCall logs its own "🔧 Tool call: X" line, so we don't duplicate it here.
    // We just mark in the completion log that this was the deferred path.
    const deferredResults: ToolCallResult[] = [];
    for (const tc of deferrableCalls) {
        // Track the promise to prevent unhandled rejections
        const promise = executeAndProcessToolCall(
            tc,
            ctx.onToolRequest,
            ctx.userMessage,
            ctx.toolAllowlist,
            ctx.channelContext,
            ctx.signal,
        )
            .then((r) => {
                const preview = r.result ? r.result.substring(0, 200) : "(empty)";
                console.log(`  ✅ Deferred tool ${r.fnName} completed: ${preview}`);
            })
            .catch((err) => console.error(`  ❌ Deferred tool ${tc.function.name} failed: ${(err as Error).message}`));
        // Ensure the promise is tracked to avoid unhandled rejection warnings
        void promise;
        deferredResults.push(createSyntheticDeferredResult(tc));
    }

    // Fire non-browser tools in parallel (with a safety timeout), except
    // screen-driving ones: they share focus, mouse and keyboard, so a type can
    // land before the click that focuses its field. Those run in call order.
    const TOOL_BATCH_TIMEOUT_MS = 120_000;
    const done = new Map<string, ToolCallResult>();
    const run = async (tc: (typeof toolCalls)[number]) => {
        const r = await executeAndProcessToolCall(
            tc,
            ctx.onToolRequest,
            ctx.userMessage,
            ctx.toolAllowlist,
            ctx.channelContext,
            ctx.signal,
        );
        done.set(tc.id, r);
        return r;
    };
    // Also anything the verify-before-done gate tracks (e.g. browser_click), so
    // its "a check after the action" reading matches what actually ran.
    const drivesScreen = (tc: (typeof toolCalls)[number]) => {
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(tc.function.arguments || "{}");
        } catch {
            /* unparseable: judged by name alone */
        }
        return gateDrivesScreen(tc.function.name, args);
    };
    const screenCalls = nonBrowserCalls.filter(drivesScreen);
    // Each call already has its own timeout in executeTool, so the in-order
    // lane gets room for every step. Once the batch is given up on, no further
    // screen step may START (a late "send" click after a reported failure).
    const batchTimeoutMs = TOOL_BATCH_TIMEOUT_MS + 35_000 * screenCalls.length;
    let gaveUp = false;
    const nonBrowserPromise =
        nonBrowserCalls.length > 0
            ? Promise.race([
                  (async () => {
                      const parallel = Promise.all(nonBrowserCalls.filter((tc) => !drivesScreen(tc)).map(run));
                      parallel.catch(() => {}); // observed below; don't let an early throw leave it unhandled
                      for (const tc of screenCalls) {
                          if (gaveUp) break;
                          await run(tc);
                      }
                      await parallel;
                      return nonBrowserCalls.map((tc) => done.get(tc.id) as ToolCallResult);
                  })(),
                  new Promise<ToolCallResult[]>((_, reject) =>
                      setTimeout(() => {
                          gaveUp = true;
                          reject(new Error(`Tool batch timed out after ${Math.round(batchTimeoutMs / 1000)}s`));
                      }, batchTimeoutMs),
                  ),
              ]).catch((err) => {
                  gaveUp = true;
                  console.error(`  ⚠️ Non-browser tool batch error: ${(err as Error).message}`);
                  // Keep the results of steps that did finish; only the rest are errors.
                  return nonBrowserCalls.map(
                      (tc) =>
                          done.get(tc.id) ?? {
                              toolCallId: tc.id,
                              fnName: tc.function.name,
                              fnArgs: {} as Record<string, unknown>,
                              result: JSON.stringify({ error: `${(err as Error).message}; this step did not finish` }),
                              finalContent: JSON.stringify({
                                  error: `${(err as Error).message}; this step did not finish`,
                              }),
                              isBrowser: false,
                              isError: true,
                          },
                  );
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
        if (milestone) await ctx.sendStatus(milestone);

        const r = await executeAndProcessToolCall(
            tc,
            ctx.onToolRequest,
            undefined,
            ctx.toolAllowlist,
            ctx.channelContext,
            ctx.signal,
        );
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
        if (milestone) await ctx.sendStatus(milestone);

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
    // Memories forgotten in the app's Memory screen: drop what this process still caches.
    syncForgetsFromElsewhere();
    // A non-owner (Slack/Discord guest, widget visitor) runs on a history of their own,
    // never the owner's: forked, so isContactAgent also keeps owner memories out.
    historyFork = historyForCaller(historyFork, channelContext);
    const isForked = !!historyFork;
    // Caller-context ALS wrapper — privilege-sensitive tools (cron, etc.)
    // read isOwner from this scope, not from a module-level slot, so
    // interleaved telegram-owner + whatsapp-contact turns don't swap
    // privileges when they interleave LLM awaits. Absent channelContext
    // defaults to non-owner (harness/research/voice paths).
    const callerIsOwner = channelContext?.isOwner === true;
    const runWithCaller = async (fn: () => Promise<AgentResponse>): Promise<AgentResponse> => {
        // Lazy ESM import to avoid circular dep at module-load time.
        // (Was `require()` previously — `require` is undefined in ESM-
        // compiled output and crashed every overlay/Telegram message
        // through this path.)
        const mod = await import("./tools/cron-tool.js");
        let res: AgentResponse;
        const nudges = new Set<object>();
        const caller: import("./tools/cron-tool.js").CronCallerContext = {
            isOwner: callerIsOwner,
            autonomous: channelContext?.autonomous === true,
            noOutward: channelContext?.noOutward === true,
            isPrivate: channelContext?.isPrivate === true,
            message: stripChannelTags(userMessage),
        };
        try {
            // Outermost turn ending = Bhai lets go of the screen (glow fades).
            const turn = () =>
                runWithTurnNudges(nudges, () =>
                    mod.runWithCallerContext(caller, () => trackCursorTurn(fn)),
                );
            // Turns share one send ledger (send-ledger.ts); an autonomous run gets its own,
            // so a recurring cron job may send the same text on its next tick.
            res = await (channelContext?.autonomous ? withSendLedger(turn) : turn());
        } finally {
            // Read after the turn: pruning may have swapped the history array.
            stripTurnNudges(historyFork ?? conversationHistory, nudges);
            // Prune between turns, off the next turn's critical path.
            if (!historyFork && !pendingPrune) {
                const base = [...conversationHistory];
                pendingPrune = pruneContext(base, llm)
                    .then((result) => ({ base, result }))
                    .catch((err) => {
                        console.error("Context pruning failed (non-fatal):", (err as Error).message);
                        return null;
                    });
            }
        }
        if (typeof res?.text === "string") {
            const { text, stuck } = takeStuckMarker(res.text);
            res.text = text;
            if (stuck) res.stuck = true;
        }
        // The model only ever sees handles ([OTP_1], [CARD_2]); the owner asked
        // about their own values, so show them. Everyone else keeps the handle.
        // Only in a private chat: in a group or public channel the real values
        // would reach everyone (and a page can ask the model to echo [CARD_1]).
        if (
            callerIsOwner &&
            channelContext?.isPrivate === true &&
            !channelContext.autonomous &&
            typeof res?.text === "string"
        ) {
            res.text = reveal(res.text);
        }
        if (callerIsOwner && !channelContext?.autonomous && typeof res?.text === "string") {
            noteOwnerReply(res.text, userMessage);
            noteSignaturePhrase(res.text);
            noteEpisodeCallbacks(res.text, userMessage);
        }
        // Only the owner's own chat gets "Forget that"; caller.storedMemory is set on owner turns only.
        if (caller.storedMemory && channelContext?.isPrivate === true && res) res.memoryUndo = caller.storedMemory;
        return res;
    };
    if (!isForked) {
        const _earlyTraceId = startTrace(
            channelContext?.channel || "default",
            userMessage.replace(/\n*\[SOURCE:.*\]$/s, "").trim(),
            0,
        );
        return runWithCaller(() =>
            runWithEvalTraceId(_earlyTraceId, () =>
                _runAgentBody(
                    llm,
                    userMessage,
                    onProgress,
                    media,
                    signal,
                    historyFork,
                    modelHint,
                    toolAllowlist,
                    channelContext,
                    _earlyTraceId,
                ),
            ),
        ).catch((err: unknown) => {
            if (_earlyTraceId) finalizeTrace(_earlyTraceId, false);
            throw err;
        });
    }
    return runWithCaller(() =>
        _runAgentBody(
            llm,
            userMessage,
            onProgress,
            media,
            signal,
            historyFork,
            modelHint,
            toolAllowlist,
            channelContext,
            null,
        ),
    );
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
    // A non-owner never gets the owner's tools by default (a channel that
    // passed no allowlist used to mean "everything", shell included).
    if (channelContext?.isOwner === false && toolAllowlist === undefined) toolAllowlist = NON_OWNER_TOOLS;

    // True when serving a non-owner contact (e.g. WhatsApp persona).
    // In this mode all owner-personal memory injection is skipped — the
    // historyFork already supplies the contact's context and we must not
    // leak the owner's identity, memories, location, or traits.
    const isContactAgent = isForked && channelContext?.isOwner === false;
    // What a contact or guest says is never the owner's: it must not become the owner's goal,
    // session context or anticipation pattern. (No channel context = an owner path, e.g. voice.)
    const ownerTurn = channelContext?.isOwner !== false;
    // The owner is here and reading: not a cron, research continuation or sub-agent run.
    const ownerAttended = channelContext?.isOwner === true && !channelContext.autonomous && !isForked;

    // Tag every runAgent invocation with a unique turn id so offloaded
    // tool outputs cluster per turn on disk.
    if (!isForked) nextTurnId();

    // A new top-level turn is the vault's task boundary: forget page taint and any
    // removed-secret masks from the last task (sub-agents / forks share the task).
    if (!isForked) resetVaultTask();

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
            const errorMsg = `⛔ ${accountStatus.reason || "Your Bhai account cannot process messages right now."}`;
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
            return { text: errorMsg, toolCalls: 0 };
        }
    }

    // Smart tool selection — dynamically updated each iteration
    let activeCategories: string[] | undefined;
    let requestedCategories: string[] | undefined;
    // The turn's tool set, reused on later iterations (see the selectTools await).
    let turnToolSelection: Awaited<ReturnType<typeof selectTools>> | undefined;
    let unhingedTurn = false;
    let turnToolReqKey = "";

    // Strip [SOURCE: ...] tags for classification/routing — the overlay appends
    // these to every message, inflating word count and breaking simple-message detection.
    // The full tagged message is still sent to the LLM for context.
    const rawUserMessage = stripChannelTags(userMessage);
    // Strip the [Replying to …'s message: "…"] prefix telegram.ts adds on a
    // swipe-reply (both forms). It quotes an earlier message — maybe the bot's
    // own "say yes to confirm" — so it must never count as the owner's words,
    // and goal detection shouldn't read it either. Anchored on `"]\n\n`, which
    // telegram.ts always emits, so a `]` inside the quote can't end it early.
    const userIntentText =
        rawUserMessage.replace(/^\[Replying to [^\n]*?message: "[\s\S]*?"\]\n\n/, "").trim() || rawUserMessage;
    const aboutSelf = channelContext?.isOwner === true && !channelContext.autonomous && isAboutBhai(userIntentText);
    // Only a message the owner actually sent can answer a consent question.
    if (channelContext?.isOwner && !channelContext.autonomous) {
        noteOwnerMessage(userIntentText);
        learnedRouter.noteNextMessage(userIntentText); // "no, that's wrong" counts against the last pick
        noteOwnerBusy(userIntentText); // "not now" → proactive holds for 2h
        noteOwnerMood(userIntentText); // grief, health, lost money, crisis → shades off
        // Any channel: the owner talking back is engagement (proactive fatigue gate).
        import("./proactive/notification-tracker.js")
            .then((m) => m.recordOwnerEngagement())
            .catch(() => {});
    }

    // ── Goal detection: only the owner's own words become the owner's goals ──
    if (channelContext?.isOwner && !channelContext.autonomous) {
        try {
            const detectedGoal = detectGoalFromMessage(userIntentText);
            if (detectedGoal && createGoal(detectedGoal.description, detectedGoal.deadline ?? undefined) > 0) {
                console.log(`  🎯 Goal detected: "${detectedGoal.description}"`);
            }
        } catch {
            /* non-fatal */
        }
    }

    // When running on a fork, use the fork instead of global history
    let workingHistory = historyFork || conversationHistory;

    // Helper: fire async reflection if needed (non-blocking)
    const maybeReflect = () => {
        if (!isForked && shouldReflect()) {
            console.log(`  🔄 Triggering async reflection (periodic)`);
            runReflection(llm, [...workingHistory], getSessionState()?.session_id).catch((err) =>
                console.error("Reflection error (non-fatal):", err),
            );
        }
    };

    if (!isForked && pendingPrune) {
        // Pruning (an LLM summary) ran in the background after the last turn;
        // usually it's done by now, so the first token doesn't wait on it.
        // Applied before the hard cap below: the cap builds a new array, which
        // would fail the prune's prefix check and drop it.
        const pending = pendingPrune;
        pendingPrune = null;
        const merged = applyPendingPrune(workingHistory, await pending);
        if (merged) {
            conversationHistory = merged;
            workingHistory = conversationHistory;
        }
    }

    // Strip any literal <system-reminder> tags from user input — those tags
    // are reserved for Bhai runtime instructions and must not be forgeable
    // by attacker-controlled message text.
    const safeUserMessage = sanitizeUntrustedContent(userMessage);

    // Build user message — multimodal if media attached
    if (media && media.length > 0) {
        const content: Array<Record<string, unknown>> = [];
        if (safeUserMessage) {
            content.push({ type: "text", text: safeUserMessage });
        }
        for (const m of media) {
            if (m.type === "image") {
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${m.mimeType};base64,${m.base64}` },
                });
            } else {
                // The Claude proxy takes images only: a video sent as an image
                // errors, and audio is silently dropped (so song-ID made things
                // up). Say so, so the model answers honestly instead.
                content.push({
                    type: "text",
                    text: `[The user attached a ${m.type} (${m.mimeType}), but I can't watch or listen to ${m.type} files directly. Use only any transcript or caption above; otherwise tell the user you couldn't play it.]`,
                });
            }
        }
        workingHistory.push({ role: "user", content: content as unknown as string });

        // ── Multimodal Memory: store image embeddings for cross-modal retrieval ──
        // The owner's images only: a contact's photo isn't the owner's memory.
        if (ownerTurn) try {
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
        workingHistory.push({ role: "user", content: safeUserMessage });
    }

    // Hard cap: prevent conversationHistory from growing unbounded (memory leak prevention)
    if (!isForked && workingHistory.length > MAX_CONVERSATION_HISTORY) {
        // Keep system messages at the start, then trim oldest non-system messages
        const systemMsgs = workingHistory.filter((m) => m.role === "system");
        const nonSystemMsgs = workingHistory.filter((m) => m.role !== "system");
        const keepCount = MAX_CONVERSATION_HISTORY - systemMsgs.length;
        const trimmed = nonSystemMsgs.length - keepCount;
        workingHistory = [...systemMsgs, ...nonSystemMsgs.slice(-keepCount)];
        conversationHistory = workingHistory;
        console.log(
            `  ✂️ Hard-capped conversation history: dropped ${trimmed} oldest messages (limit: ${MAX_CONVERSATION_HISTORY})`,
        );
    }

    // ── Quick commands: everyday computer commands run without a model call ──
    // (src/quick-commands.ts). The owner's own text turns only; anything not fully
    // understood, or a step that fails, carries on to the model below.
    if (!isForked && channelContext?.isOwner === true && !channelContext.autonomous && !media?.length) {
        const quick = await runQuickCommand(userIntentText, executeTool).catch(() => null);
        if (quick?.reply) {
            console.log(`  ⚡ Quick command: ${quick.reply}`);
            workingHistory.push({ role: "assistant", content: quick.reply });
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, true);
            return { text: quick.reply, toolCalls: 1 };
        }
        if (quick?.partial) workingHistory.push({ role: "system", content: quick.partial });
    }

    const messages: ChatCompletionMessageParam[] = workingHistory;

    let iterations = 0;
    let totalToolCalls = 0;
    let lastToolCalls: Array<{ function: { name: string } }> | undefined;
    let usedBrowserTools = false;
    let lastProgressTime = 0;
    let lastUsedModel: string | undefined; // Track model for credit deduction
    // Verify-before-done gate — see src/agents/verify-before-done.ts.
    const verifyGate = newVerifyGateState();
    let lookNudged = false; // asksLeaveToLook fires once per run
    let ackNudged = false; // the ack-without-action nudge, once per run
    const receiptFor = async (text: string): Promise<Receipt | undefined> => {
        const receipt = pickReceipt(verifyGate, {
            stuck: takeStuckMarker(text).stuck,
            isOwner: channelContext?.isOwner === true,
            isPrivate: channelContext?.isPrivate === true,
        });
        return receipt; // already the clean (ungridded) screen: see receiptUrl
    };
    // Playbooks: every tool call this turn, and the learnings shown to it.
    const turnCalls: PlaybookCall[] = [];
    const injectedLearnings = new Set<string>();
    // What went out this turn (sends, files, calendar events), for its 'bhai_did' memory.
    const didLines: string[] = [];
    const recordBatch = (batch: ToolCallResult[]) => {
        recordBatchForVerifyGate(verifyGate, batch);
        if (batch.some((r) => r.imageUrl)) turnSawImage = true;
        // Lane order, like the gate: a screen check batched with a browser action may have run before it.
        for (const r of inLaneOrder(batch)) {
            turnCalls.push({ fnName: r.fnName, fnArgs: r.fnArgs, failed: toolFailed(r) });
            const did =
                !toolFailed(r) && !sendFailed(r.fnName, r.result) && didLine(r.fnName, r.fnArgs, userIntentText);
            if (did) didLines.push(did);
        }
    };
    // A verified win teaches a playbook; a failed replay demotes what it was shown.
    // A Retry/Skip handoff turn is keyed by the report it replies to, or learns nothing.
    const playbookTask = playbookTaskText(rawUserMessage, userIntentText);
    const settleLearnings = (reply: string, stuck = takeStuckMarker(reply).stuck) => {
        if (turnArm && turnClass) {
            const verified = isVerifiedWin(turnCalls, reply, stuck);
            const base = learnedRouter.turnOutcome({
                verified,
                stuck,
                infra: turnArmInfra,
                calls: iterations,
                seconds: (Date.now() - turnStartedAt) / 1000,
            });
            // Handed to another model mid-turn: it needed help, whatever the ending.
            const outcome = base && turnArmLeft ? { ...base, success: 0, failure: stuck ? 0.5 : 0.25 } : base;
            if (outcome) {
                learnedRouter.recordOutcome(turnClass, turnArm.id, outcome);
                // The owner's "no, that's wrong" can follow only a turn they saw and that
                // didn't end on a question (where "no" is the answer).
                if (ownerAttended && !/\?\s*$/.test(reply.trim()))
                    learnedRouter.noteTurn(turnClass, turnArm.id, outcome.success);
            }
        }
        const did = bhaiDidMemory(didLines.splice(0), {
            isOwner: channelContext?.isOwner === true,
            autonomous: channelContext?.autonomous === true,
            stuck,
            secret: verifyGate.secretSeen === true,
            failed: verifyGate.lastMutatorFailed === true,
        });
        if (did) {
            remember(did, "bhai_did", "", 3, "tool").catch((err) =>
                console.warn("[MEMORY] bhai_did skipped:", (err as Error).message),
            );
        }
        if (channelContext?.isOwner !== true || playbookTask === undefined) return;
        try {
            const pb = buildPlaybook(playbookTask, turnCalls, reply, stuck);
            if (pb) {
                upsertLearning(pb.category, pb.taskPattern, pb.context, pb.steps, [], [], 1, new Date().toISOString());
            } else if (injectedLearnings.size > 0 && (stuck || verificationFailed(turnCalls))) {
                demoteLearnings(injectedLearnings);
            }
        } catch (err) {
            console.warn("[LEARNINGS] playbook update skipped:", (err as Error).message);
        }
    };
    let verificationNagged = false;
    // The done-criterion from this turn's ack, fed back to the verify nudges.
    let turnContract: string | undefined;
    // A non-complex desktop-only turn (set on iteration 1) stays on Haiku and
    // skips the memory nudge while it's short and nothing has gone wrong.
    let guiTurn = false;
    let guiTrouble = false;
    // Learned router (src/routing/learned-router.ts): the turn's model and how it went.
    let turnClass: learnedRouter.TaskClass | undefined;
    let turnArm: learnedRouter.Arm | undefined;
    let turnCats: string[] = [];
    let turnArmReleased = false; // the rules above choose again from here
    let turnArmLeft = false; // another model actually ran part of this turn
    let turnArmInfra = false; // a provider error or a silent fallback: not the model's doing
    let turnSawImage = false; // a tool result carried a screenshot this turn
    const guiPinned = () =>
        guiTurn &&
        !guiTrouble &&
        errorCount === 0 &&
        iterations <= GUI_PIN_MAX_ITERATIONS &&
        (requestedCategories ?? []).every((c) => GUI_LOOP_CATEGORIES.has(c));

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

    // Tool statuses read "step N · <status> · <elapsed>s"; a batch that runs
    // quiet for ~20s re-sends its current status so long tasks show a pulse.
    const turnStartedAt = Date.now();
    let toolStep = 0;
    let stepStatus = "working on it";
    const sendStatus = (status: string) => {
        stepStatus = status;
        return sendProgress(formatStepStatus(toolStep, status, Date.now() - turnStartedAt));
    };
    const runToolBatch = async (
        calls: Array<{ id: string; function: { name: string; arguments: string } }>,
        ctx: Omit<Parameters<typeof executeToolCallsBatch>[1], "sendProgress" | "sendStatus">,
    ): Promise<ToolCallResult[]> => {
        toolStep++;
        const milestoneOf = (tc: (typeof calls)[number]) => {
            try {
                return getMilestoneMessage(tc.function.name, JSON.parse(tc.function.arguments || "{}"));
            } catch {
                return null;
            }
        };
        stepStatus = calls.map(milestoneOf).find(Boolean) ?? "working on it";
        const stop =
            onProgress && !calls.some((tc) => SELF_REPORTING_TOOLS.has(tc.function.name))
            ? startStepHeartbeat(
                  () => lastProgressTime,
                  () => void sendStatus(stepStatus),
              )
            : () => {};
        try {
            return await executeToolCallsBatch(calls, { ...ctx, sendProgress, sendStatus });
        } finally {
            stop();
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

    // workingHistory is the shared conversation (trimming keeps system
    // messages), so add the hint once rather than once per OS-ish message.
    if (isOsAppTask && !workingHistory.some((m) => m.role === "system" && String(m.content).startsWith(OS_TASK_HINT))) {
        workingHistory.push({ role: "system", content: OS_TASK_HINT });
    }

    // Cascade escalation: only one attempt per agent invocation
    let cascadeAttempted = false;

    // Empty response retry: if LLM produces empty text after tool calls, nudge and retry
    let emptyResponseRetries = 0;
    const MAX_EMPTY_RETRIES = 2;

    // Metacognition state — self-monitoring for loop/struggle detection
    const metaState = createMetacognitionState();
    let metaNudged = false;
    let lastMetaNudgeIter = -100;
    // P5.3: at most ONE adversarial progress-judge call per stuck turn (Haiku),
    // and only when ATLAS_PROGRESS_JUDGE=true. Turn-scoped, reset per runAgent.
    let judgeFired = false;
    // A2: cross-iteration dispatcher state — drives escalate/replan/critics/ask_user.
    const interventionState: InterventionState = createInterventionState();
    // Captures selection.taskType at the end of each iteration so the critics
    // arm can detect the coding-verifier-in-scope case on the NEXT iteration.
    let lastSelectionTaskType: string | undefined;

    // Per-turn loop guardrail — catches a single tool retrying identical args
    // (a spiral the whole-batch no-progress guard below misses). Warn-only
    // unless ATLAS_TOOL_LOOP_HARDSTOP=true.
    const guardrailState = createGuardrailState();

    // Hard loop guard: count consecutive tool batches where EVERY call failed
    // or returned empty. The metacognition nudge only fires once and the model
    // can ignore it — this forces the loop to end after sustained total failure
    // so a stuck task can't grind to the 200-iteration / token-burn ceiling
    // (e.g. a shell loop returning empty stdout 38× in a row). Deliberately
    // narrow: only ALL-failed/empty batches count, polling tools are exempt,
    // and any usable output resets the streak — so legitimate long/iterative
    // work is never cut short. Env-tunable; 0 disables.
    const NO_PROGRESS_LIMIT = Number(process.env.ATLAS_NO_PROGRESS_LIMIT ?? "8");
    let noProgressStreak = 0;

    // Circuit breaker — trips after sustained failures or no-progress
    const circuitBreaker = createCircuitBreaker();

    let lastLlmError = ""; // the last model error this turn (to say "out of credits" plainly)
    // Hard stop for a turn that never converges (each step costs credits).
    const MAX_AGENT_ITERATIONS = Number(process.env.ATLAS_MAX_ITERATIONS ?? "60");

    while (true) {
        if (iterations >= MAX_AGENT_ITERATIONS) {
            console.log(`  🛑 Iteration cap (${MAX_AGENT_ITERATIONS}) reached`);
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
            settleLearnings("", true);
            return {
                text: stuckNote(
                    `I hit the ${MAX_AGENT_ITERATIONS}-step limit without finishing`,
                    turnCalls.map((c) => c.fnName),
                    turnContract,
                ),
                toolCalls: totalToolCalls,
                stuck: true,
            };
        }
        // Metacognition-driven nudge. A2: instead of a single one-shot nudge,
        // re-fire when struggle/loop PERSISTS — a stuck agent that ignored the
        // first nudge gets steered again — but on a cooldown so we never spam.
        // Disable the repeat behavior entirely with ATLAS_NO_META_INTERVENTIONS=true
        // (reverts to the original one-shot nudge).
        if (iterations > 3) {
            // C: stamp the (taskType, modelTier) the calibrator keys on. The model
            // for THIS iteration isn't picked yet, so pass the prior taskType + any
            // forced tier; absent → global calibrator (shadow no-op by default).
            setCalibrationContext(metaState, {
                taskType: lastSelectionTaskType,
                modelTier: interventionState.forcedModel ?? undefined,
            });
            const metaCheck = assess(metaState);
            const interventionsOff = process.env.ATLAS_NO_META_INTERVENTIONS === "true";
            const NUDGE_COOLDOWN = 5;
            const cooldownPassed = iterations - lastMetaNudgeIter >= NUDGE_COOLDOWN;
            const shouldNudge = metaCheck.loopDetected || metaCheck.struggleDetected;
            if (shouldNudge) guiTrouble = true; // a looping desktop task goes back to the router's pick
            // One-shot when interventions are off; cooldown-gated repeat otherwise.
            const fire = shouldNudge && (interventionsOff ? !metaNudged : !metaNudged || cooldownPassed);
            if (fire) {
                metaNudged = true;
                lastMetaNudgeIter = iterations;
                const nudge = `[SYSTEM — METACOGNITION] ${metaCheck.reasoning}. You have been running for ${iterations} iterations and ${totalToolCalls} tool calls. ${metaCheck.loopDetected ? "A repeating tool-call pattern was detected." : "You appear to be struggling."} Please reflect: are you stuck in a loop or making actual progress? If you are stuck, summarize what you have accomplished so far and present it to the user. If you are making real progress, continue with a different approach.`;
                pushNudge(messages, nudge);
                console.warn(`  ⚠️ Metacognition nudge: ${metaCheck.reasoning} (iteration ${iterations})`);
            }
            // Low confidence can inform cascade escalation
            if (metaCheck.confidence < 0.3 && !cascadeAttempted) {
                console.log(
                    `  🧠 Metacognition: low confidence (${metaCheck.confidence.toFixed(2)}) — may trigger cascade escalation`,
                );
            }
            // P5.3 — opt-in adversarial progress judge. Fires AT MOST ONCE per stuck
            // turn, and ONLY when ATLAS_PROGRESS_JUDGE=true (DEFAULT OFF). Healthy
            // turns (no loop AND repeats<3 AND confidence≥0.35) never enter this
            // branch → ZERO added LLM cost in the default config. When it fires it
            // makes exactly ONE Haiku call; its likely_fix overrides the heuristic
            // metaCheck.intervention so the SAME applyIntervention dispatcher acts.
            if (
                progressJudgeEnabled() &&
                !judgeFired &&
                iterations >= 4 &&
                (metaCheck.loopDetected ||
                    metaState.signals.maxIdenticalStepRepeats >= 3 ||
                    metaCheck.confidence < 0.35)
            ) {
                judgeFired = true;
                const verdict = await runProgressJudge(llm, rawUserMessage, messages);
                if (verdict) {
                    const judged = judgeFixToIntervention(verdict.likely_fix);
                    console.warn(
                        `  🧑‍⚖️ Progress judge: ${verdict.progress_0_100}/100 stalled=${verdict.stalled} → ${verdict.likely_fix} | ${verdict.one_line}`,
                    );
                    if (judged !== "none") {
                        metaCheck.intervention = judged;
                        metaCheck.reasoning = `progress judge: ${verdict.one_line}`;
                    }
                }
            }
            // A2: make MetaAssessment.intervention ACT. The text nudge above is the
            // fallback; this dispatches the computed enum (escalate/replan/critics/
            // ask_user) into concrete cooldown-gated, fail-open actions. On a healthy
            // turn (intervention === "none") or with ATLAS_NO_META_INTERVENTIONS=true
            // it is a no-op with ZERO added cost. Awaited because escalate/ask_user
            // set state consumed by THIS iteration's model pick below.
            await applyIntervention({
                llm,
                assessment: metaCheck,
                iterations,
                totalToolCalls,
                originalRequest: rawUserMessage,
                messages,
                recentToolNames: metaState.signals.recentToolNames,
                taskType: lastSelectionTaskType,
                onProgress,
                state: interventionState,
            });
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
                    pushNudge(
                        messages,
                        `[SYSTEM — CIRCUIT BREAKER HALF-OPEN] The agent has been stuck. This is a recovery probe. Take a completely different approach to complete the task. Summarize what has been tried so far and attempt one final strategy.`,
                    );
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
                    // P5.2 STEP-0: genuine reasoning-failure terminal exit (circuit
                    // breaker tripped on sustained trouble) → true-negative label.
                    // model not picked at this point → global-calibrator fallback.
                    try {
                        logOutcome(metaState, false, { taskType: lastSelectionTaskType });
                    } catch {
                        /* best-effort */
                    }
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                    settleLearnings("", true);
                    return {
                        text: stuckExitText(
                            messages,
                            "the same steps kept failing",
                            turnCalls.map((c) => c.fnName),
                            turnContract,
                        ),
                        toolCalls: totalToolCalls,
                        stuck: true,
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

        // ── Periodic Memory Nudge ──
        // Every N iterations, nudge the agent to self-evaluate what's worth remembering.
        // This ensures important facts/decisions/preferences are persisted during long
        // conversations, not just at session end.
        // Not on a short desktop task: there it lands as the last thing the model
        // sees and the final answer replies to the nudge instead of the user.
        if (iterations > 1 && iterations % MEMORY_NUDGE_INTERVAL === 0 && !guiPinned()) {
            const nudge = `[Memory nudge] Review the conversation so far. If any important facts, decisions, user preferences, or task learnings have emerged that aren't yet stored, use memory_store to persist them now. Focus on information that would be valuable in future conversations.`;
            pushNudge(messages, nudge);
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
        // Capture for the NEXT iteration's critics-arm verifier-scope check.
        lastSelectionTaskType = selection.taskType;
        // Circuit breaker half-open: force highest-tier model for recovery probe.
        // A2: the metacog escalate arm threads a forced tier here via the same
        // modelOverride path — consumed once, then cleared so it forces ONE iteration.
        const forcedPick = circuitBreaker.state === "half-open" || !!interventionState.forcedModel;
        let model =
            circuitBreaker.state === "half-open" ? MODELS.SONNET : (interventionState.forcedModel ?? selection.modelId);
        if (interventionState.forcedModel) {
            console.log(`  🧠 Metacog escalate → ${interventionState.forcedModel}`);
            interventionState.forcedModel = null;
        }
        if (iterations <= 3 || iterations % 5 === 0) {
            console.log(`  🧠 Iteration ${iterations} using ${selection.displayName} [${selection.reason}]`);
        }

        // Auto-inject relevant memory and strategies on the first iteration of a user's prompt
        let activeInjection = "";
        // Music fast-path state. Phase-1 is set BEFORE the tool-selection await
        // (heuristic only — skips the memory injection). Phase-2 is set
        // AFTER the await when the LLM classifier has populated its output.
        let musicFastPathPhase1 = false; // heuristic match — skip memory injection only
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
            // A forked turn (a WhatsApp contact, a group) must not touch the owner's
            // session: an expiry here reflected on the contact's chat and saved their
            // "my name is X" as the owner's. Periodic reflection skips forks too.
            const { isNew, expiredSession } = isForked
                ? { isNew: false, expiredSession: null }
                : touchSession(userMessage);
            if (isNew) {
                console.log(`  📋 New session started`);
                resetSessionTraitCaps("new");

                // Fire reflection for expired session — use pre-expiry history, not current (mostly empty) workingHistory
                if (expiredSession && expiredSession.turn_count > 3) {
                    console.log(
                        `[MEMORY][REFLECTION] Session expired — triggering reflection (${expiredSession.turn_count} turns)`,
                    );
                    // Give reflection a moment so its DB writes usually land before
                    // memory retrieval, but never hold the user's first message
                    // after a break for its 2-4 LLM calls; it finishes in the background.
                    const reflection = runReflection(
                        llm,
                        preSessionHistory,
                        expiredSession.session_id,
                        getShortSummary(expiredSession),
                    ).catch((err) =>
                        console.error("[MEMORY][REFLECTION] Expired session reflection failed:", err),
                    );
                    await Promise.race([reflection, new Promise((r) => setTimeout(r, 1500))]);
                }
            }

            // ── 1. Classify query to decide retrieval depth ──
            const queryMode = classifyQuery(rawUserMessage);
            console.log(`[MEMORY][RETRIEVE] Query mode: ${queryMode}`);

            // ── Build conversation context for tool router ──
            // Gives the tool selector awareness of recent conversation turns so it
            // can disambiguate references like "open the file manager" (OS app vs. website button)
            // The router classifies the bare words, so "do this for me" needs the situation
            // the words point at: what's attached, and whether a page in the owner's Chrome
            // can be driven (no title/URL: the page writes those). First, so the router's
            // cache key (the context's first 200 chars) tells the situations apart.
            const situation = [
                media?.some((m) => m.type === "image") ? "The user attached an image (or a screenshot of their screen)." : "",
                userMessage.includes("[BROWSER CONTEXT: Chrome extension is connected")
                    ? "The user has a web page open in their own Chrome, which the browser tools can act on."
                    : "",
            ].filter(Boolean);
            const convCtx = [situation.length ? `(${situation.join(" ")})` : "", buildToolRouterContext(workingHistory)]
                .filter(Boolean)
                .join("\n");

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

            // ── Coding context ──
            // The codebase index + repo map are synchronous disk/CPU work that can
            // hold the event loop for 10s+. Started while routing was in flight they
            // starved its timeout (a 5s budget took 15s on "… my code doesn't build.
            // roast me"), so they start once routing settles and are skipped on a
            // chat-lane turn. Memory retrieval below does not wait for either; the
            // parts go last, so the context cap cuts them before core memory.
            const buildCodingContext = async (): Promise<string[]> => {
                const parts: string[] = [];
                // ── Coding complexity classification ──
                // Inject a short reminder telling the agent which flow to
                // follow: trivial skips design-docs, standard implements
                // directly with Pro tier, complex triggers the full PRD →
                // approval → walkthrough ceremony.
                try {
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
                } catch {
                    /* classifier unavailable — don't block the agent */
                }

                // ── Past coding-strategy recall (Phase 4E read side) ──
                // For coding tasks, surface the code-category task-learnings separately
                // from the general recall so previously-validated patterns aren't
                // crowded out by browser/os/app entries when the top-3 is shared.
                // Owner-only: playbooks quote the owner's own task messages.
                try {
                    const codingLearnings =
                        channelContext?.isOwner === false
                            ? ""
                            : getTaskLearningsContext(rawUserMessage, "code", injectedLearnings);
                    if (codingLearnings) parts.push(codingLearnings);
                } catch {
                    /* task-learnings not initialized */
                }

                // ── Project memory (ATLAS.md walk-up) ──
                // Only for coding-classified queries to avoid injecting
                // project conventions into chat/research flows.
                try {
                    const projectMemory = getProjectMemorySnippet();
                    if (projectMemory) parts.push(projectMemory);
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
                // Scan attacker-influenceable context (a poisoned repo file can
                // surface in repo_map/architecture) for embedded instructions.
                // Fails OPEN: scan error or kill-switch → inject as before.
                const guardContext = async (label: string, body: string | null): Promise<string | null> => {
                    if (!body || process.env.ATLAS_NO_THREAT_SCAN === "true") return body;
                    try {
                        const { scanForThreats } = await import("./security/threat-patterns.js");
                        const r = scanForThreats(body, "context");
                        if (r.detected) {
                            console.warn(`[AGENT] ${label} injection blocked (threat:${r.categories.join(",")})`);
                            return `<${label}>\n[context omitted: failed injection scan — ${r.categories.join(",")}]\n</${label}>`;
                        }
                    } catch {
                        /* fail open — inject unscanned context as before */
                    }
                    return body;
                };
                const safeRepoMap = await guardContext("repo_map", repoMap);
                const safeArch = await guardContext("architecture", arch);
                if (safeRepoMap) parts.push(safeRepoMap);
                if (safeArch) parts.push(safeArch);
                return parts;
            };
            const codingPartsPromise: Promise<string[]> =
                detectTaskType(rawUserMessage) !== "coding"
                    ? Promise.resolve([])
                    : toolSelectionPromise
                          .then(
                              (s) => !s.categories.includes("chat_only"),
                              () => true,
                          )
                          .then((coding) => (coding ? buildCodingContext() : []))
                          .catch(() => []);

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

            // ── 3. Behavioral traits (token-budgeted, relevance-scored) ──
            try {
                const traitsSnippet = getTraitsForInjection(rawUserMessage, 600);
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
                // Owner's private chat only: a group, contact or autonomous turn would spend a once-ever milestone.
                const relationshipSnippet =
                    channelContext?.isOwner !== false &&
                    channelContext?.isPrivate === true &&
                    !channelContext?.autonomous
                        ? getRelationshipSnippet()
                        : "";
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

            try {
                // Core Identity & Important Facts (Always injected)
                const coreMems = getCoreMemory(getDimensionValue<number>("memory.coreMemory.k") ?? 10);
                if (coreMems && coreMems.length > 0) {
                    noteShownMemories(coreMems.map((m) => m.id));
                    parts.push(
                        `🧠 CORE MEMORY (Always remember these facts about the user):\n${coreMems.map((m) => `- (#${m.id} · ${m.category} · ${ageLabel(m.created_at)}${m.pinned ? " · pinned" : ""}) ${m.content}`).join("\n")}`,
                    );
                }

                // 6. Query-specific recall — only for modes that need semantic search
                if (queryMode === "retrieve" || queryMode === "llm_with_traits") {
                    const recallK = getDimensionValue<number>("memory.recall.k") ?? 5;
                    const convRecallK = getDimensionValue<number>("memory.conversationRecall.k") ?? 3;
                    // Enrich recall query with recent user messages for better semantic matching
                    const recentUserMsgs = workingHistory
                        .filter((m) => m.role === "user" && typeof m.content === "string")
                        .slice(-3)
                        .map((m) => stripChannelTags(m.content as string).substring(0, 150));
                    const enrichedQuery =
                        recentUserMsgs.length > 1 ? `${recentUserMsgs.join(" ")} ${rawUserMessage}` : rawUserMessage;

                    // Pre-start the query embedding in parallel with the SQL-only
                    // recalls below. recall() awaits this promise internally only
                    // at the HNSW search step, so the embedding (potentially a
                    // ~100 ms transformer pipeline on cold cache) now overlaps
                    // with the conversation + task-learnings SQL work instead of
                    // running strictly before it.
                    let embeddingPromise: Promise<Float32Array | null> = Promise.resolve(null);
                    try {
                        const embedMod = await import("./memory/embeddings.js");
                        if (embedMod.isReady()) {
                            embeddingPromise = embedMod.embedText(enrichedQuery, "query").catch(() => null);
                        }
                    } catch {
                        /* recall() will fall back to computing embedding internally */
                    }

                    const [queriedMems, pastConvos, learningsCtx] = await Promise.all([
                        // Summaries already arrive as PAST CONVERSATIONS; the window comes from this message only.
                        recall(enrichedQuery, recallK, llm, queryMode, undefined, embeddingPromise, {
                            excludeCategories: ["session_summary"],
                            ...parseDateWindow(rawUserMessage),
                        }).catch(() => []),
                        recallConversation(rawUserMessage, convRecallK).catch(() => []),
                        Promise.resolve().then(() => {
                            // Owner-only: playbooks quote the owner's own task messages.
                            if (channelContext?.isOwner === false) return null;
                            try {
                                return getTaskLearningsContext(rawUserMessage, undefined, injectedLearnings);
                            } catch {
                                return null;
                            }
                        }),
                    ]);

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const uniqueMems = queriedMems.filter((q: any) => !coreMems.some((c: any) => c.id === q.id));
                    // Record memory hits for harness traces
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const topScore = queriedMems.length > 0 ? ((queriedMems[0] as any).score ?? 0) : 0;
                    if (_harnessTraceId) recordMemoryHit(_harnessTraceId, uniqueMems.length, topScore);
                    // Owner-only, never in groups: contacts, group chats and autonomous runs keep the plain list.
                    const { cards, ids, rest } =
                        channelContext?.isOwner !== false &&
                        channelContext?.isPrivate === true &&
                        !channelContext?.autonomous
                            ? buildMemoryCards(rawUserMessage, uniqueMems, new Set(coreMems.map((c) => c.id)))
                            : { cards: "", ids: [], rest: uniqueMems };
                    if (cards) {
                        noteShownMemories(ids);
                        parts.push(cards);
                    }
                    if (rest.length > 0) {
                        noteShownMemories(rest.map((m) => m.id));
                        parts.push(
                            `🧠 RELEVANT RECALLED MEMORIES (Based on current prompt):\n${rest.map((m) => `- (#${m.id} · ${m.category} · ${ageLabel(m.created_at)}) ${m.content}`).join("\n")}`,
                        );
                    }

                    if (pastConvos.length > 0) {
                        const convoLines = pastConvos.map((c) => `- [${ageLabel(c.created_at)}] ${c.summary}`);
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
                if (ownerTurn) await wmReflect(rawUserMessage); // working memory is the owner's
                const wmSnippet = getWMSnippet();
                if (wmSnippet) parts.push(wmSnippet);
            } catch {
                /* working memory not initialized */
            }

            // ── Active goals ──
            try {
                const goalsSnippet = getGoalsSnippet();
                if (goalsSnippet) parts.push(goalsSnippet);
            } catch {
                /* goals not ready */
            }

            // ── Counterfactual regret context ──
            // Surfaces "last time we tried X it went worse than plan Y" so the
            // agent can avoid known bad patterns on the current task.
            try {
                const { getCounterfactualContext } = await import("./memory/counterfactual.js");
                const cfSnippet = getCounterfactualContext(rawUserMessage, 3);
                if (cfSnippet) parts.push(cfSnippet);
            } catch {
                /* counterfactual not ready */
            }

            try {
                // W2: pull persona from identity.extra.persona once per turn,
                // narrow via asPersona, and pass into the dynamic context.
                // ATLAS_NO_PERSONA_BIAS=true short-circuits both this read
                // and the eventual prompt module (in dynamic-assembler).
                let _personaForCtx: import("./prompts/persona-bias.js").Persona | undefined;
                if (process.env.ATLAS_NO_PERSONA_BIAS !== "true") {
                    try {
                        const idMod = await import("./memory/identity.js");
                        const biasMod = await import("./prompts/persona-bias.js");
                        const idProfile = idMod.getIdentityProfile() as { extra?: { persona?: unknown } };
                        const p = biasMod.asPersona(idProfile?.extra?.persona);
                        if (p) _personaForCtx = p;
                    } catch {
                        /* persona injection is best-effort — skip on read failure */
                    }
                }
                const dynCtx = buildDynamicContextReminder(rawUserMessage, {
                    hour: localHour,
                    persona: _personaForCtx,
                });
                if (dynCtx) parts.push(dynCtx);
            } catch {
                /* dynamic context is a nicety — never block the turn */
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
                parts.push(
                    "🆕 FIRST-TIME USER: memory is empty. Follow FIRST-TIME USERS in your identity; save what they tell you with identity_update / trait_update.",
                );
            }

            parts.push(...(await codingPartsPromise));

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
                            `Saved notes:\n${cp.memories
                                .slice(-5)
                                .map((m: any) => `- ${m.content}`)
                                .join("\n")}`,
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
                    if (_harnessTraceId)
                        recordContextSources(
                            _harnessTraceId,
                            parts.map((p) => p.split("\n")[0].substring(0, 60)),
                        );
                    // Telemetry: log the shape of iteration-1 memory injection
                    // so we can see which subsystems are pulling weight vs
                    // returning empty. Enabled by default (low log volume,
                    // fires once per first-iteration turn); silence via
                    // ATLAS_MEMORY_TELEMETRY=false.
                    if (process.env.ATLAS_MEMORY_TELEMETRY !== "false") {
                        const shapes = parts.map((p) => {
                            const header = (p.match(/^[^\n]+/)?.[0] ?? "").slice(0, 40).replace(/\s+/g, " ");
                            return `${header}=${p.length}c`;
                        });
                        const totalChars = parts.reduce((s, p) => s + p.length, 0);
                        console.log(
                            `[MEMORY-INJECT] iter=1 sources=${parts.length} total=${totalChars}c → ${shapes.join(" | ")}`,
                        );
                    }
                }

                // Cap total injected context — tunable via Meta-Harness registry
                const MAX_INJECTION_CHARS = getDimensionValue<number>("agent.contextCap") ?? 8000;
                let totalChars = 0;
                const cappedParts: string[] = [];
                for (const part of parts) {
                    if (totalChars + part.length > MAX_INJECTION_CHARS) {
                        // Truncate the last part that overflows
                        const remaining = MAX_INJECTION_CHARS - totalChars;
                        if (remaining > 100) {
                            cappedParts.push(`${part.substring(0, remaining)}...`);
                            totalChars += remaining;
                        }
                        break;
                    }
                    cappedParts.push(part);
                    totalChars += part.length;
                }

                // Phase-1 heuristic: if this looks like a simple music command, skip the
                // memory injection. False positives here are low-cost — the user
                // just gets a leaner context on a non-music turn.
                if (iterations === 1 && !isPlanMode() && isLikelyMusicCommand(rawUserMessage)) {
                    musicFastPathPhase1 = true;
                    console.log(`  ⚡ Music fast-path phase-1 (heuristic) — skipping memory injection`);
                }

                if (!musicFastPathPhase1) {
                    activeInjection = `[Auto-Injected Memory & Strategy Context]\n${cappedParts.join("\n\n")}`;
                }
                // If musicFastPathPhase1 is true, we intentionally inject nothing here.
                // Phase-2 (after the tool-selection await) may still add a small
                // [Music Memory Hint] if the user used a possessive query.
            }

            // ── Deep research awareness ──
            // Surface running/recent/interrupted background researches so the
            // agent never starts a duplicate, knows which ids it can reference
            // without calling check_deep_research, and can report status when
            // asked.
            try {
                const { getResearchStatusSnippet } = await import("./research/index.js");
                const researchSnippet = await getResearchStatusSnippet();
                if (researchSnippet) {
                    activeInjection = `${activeInjection || ""}${activeInjection ? "\n\n" : ""}[Background Research Status]\n${researchSnippet}`;
                }
            } catch (err) {
                console.warn("[AGENT] research status snippet failed:", (err as Error).message);
            }

            // Preset-neutral: identity §3/§4 already carry the casual register.
            if (modelHint === "simple") {
                activeInjection = `${activeInjection || ""}\n\n[simple message: answer in as few words as it needs; no padding, no follow-up question unless you need one to act]`;
            }

            // Record user turn in session buffer. Use the sanitized text —
            // raw user content can carry literal <system-reminder> tags that
            // would otherwise re-emerge in the next turn's session-summary
            // injection (and into overnight dream-replay), defeating the
            // boundary sanitizer.
            if (ownerTurn) {
                appendTurn("user", safeUserMessage);
                trackSessionForAnticipation();
            }
        }

        // Smart thinking: use router's recommended thinking level
        // Override: skip thinking for simple messages (more spontaneous)
        // Sparse thinking: disable reasoning for simple repetitive OS tool loops (iterations 4+)
        const lastToolNames = lastToolCalls?.map((tc) => tc.function.name) || [];
        const isRepetitiveOsAction =
            iterations > 3 &&
            lastToolNames.length > 0 &&
            lastToolNames.every((name) => name.startsWith("os_") || name === "app_manager");

        let iterThinking: ThinkingLevel =
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
        const reqKey = (requestedCategories || []).join(",");
        if (iterations === 1 && userMessage) {
            // Use the promise started earlier
            toolSelection = await toolSelectionPromise!;
        } else if (turnToolSelection && reqKey === turnToolReqKey) {
            // Later iterations keep the turn's tool set: tools render first in the
            // prompt, so a set that changes every iteration busts the prompt cache.
            // request_tools still widens it (reqKey changes → re-select below).
            toolSelection = turnToolSelection;
        } else {
            toolSelection = await selectTools({
                message: userMessage,
                recentToolCalls: lastToolCalls?.map((tc) => tc.function.name),
                iteration: iterations,
                requestedCategories,
                conversationContext: buildToolRouterContext(workingHistory),
            });
        }
        turnToolSelection = toolSelection;
        turnToolReqKey = reqKey;
        const tools = toolSelection.tools;
        activeCategories = toolSelection.categories;

        // ── Task-context routing (iteration 1) ──
        // The router picked a model from the raw message before anything knew
        // what this turn needs; the classifier (which also sees the recent
        // conversation) now does. Chat and single quick actions run on Haiku
        // (chat without thinking); complex work gets at least Sonnet with some
        // thinking. Forced picks and explicit asks for depth are left alone.
        const turnTier = toolSelection.classification?.tier;
        if (iterations === 1 && turnTier && !forcedPick) {
            const before = model;
            if (
                (turnTier === "chat" || turnTier === "simple") &&
                !opusWarranted(rawUserMessage, errorCount, modelHint)
            ) {
                if (claudeTier(model) !== "haiku") model = MODELS.HAIKU;
                // Pure chat needs no reasoning. A tool task keeps a little: with
                // thinking off, Haiku tends to answer from stale context instead
                // of calling the tool ("I haven't checked the weather this time…").
                iterThinking = turnTier === "chat" ? "off" : iterThinking === "off" ? "low" : iterThinking;
            } else if (turnTier === "complex" && claudeTier(model) === "haiku") {
                model = MODELS.SONNET;
                if (iterThinking === "off") iterThinking = "low";
            }
            console.log(
                `  🧭 Task tier: ${turnTier} → ${claudeTier(model)}${model !== before ? ` (was ${claudeTier(before)})` : ""}, thinking ${iterThinking}`,
            );
        }

        // Unhinged (an 18+ owner opt-in) runs the whole turn on Grok with its own
        // prompt (server-side; falls back to Sonnet). Claude under the default
        // personality answered tame, and a tool step handed to it lost the voice
        // ("play your top song pick" → it asked instead of picking). Complex
        // multi-step work stays on Claude, and two errors hand the turn back.
        // Owner turns only; 1 credit a call.
        if (iterations === 1 && (!channelContext || channelContext.isOwner) && turnTier !== "complex") {
            const { getActivePreset } = await import("./setup/personality-sync.js");
            unhingedTurn = getActivePreset() === "unhinged" && !isSerious();
        }

        // ── Learned router: the model for this kind of task, from evidence ──
        // (src/routing/learned-router.ts). Rules above it: an explicit ask for depth, a forced
        // pick, unhinged (Grok writes the turn), and complex work keeping at least Sonnet.
        if (
            iterations === 1 &&
            !forcedPick &&
            !unhingedTurn &&
            turnTier !== "complex" &&
            toolSelection.classification &&
            process.env.ATLAS_NO_LEARNED_ROUTER !== "true" &&
            !opusWarranted(rawUserMessage, errorCount, modelHint)
        ) {
            turnClass = learnedRouter.classifyTurn(toolSelection.classification, hasMediaThisIter);
            turnCats = toolSelection.classification.categories ?? [];
            const pick = learnedRouter.chooseArm(turnClass, {
                // Only the owner's own turns try a model, and only low-risk kinds of task.
                lowRisk: ownerAttended && learnedRouter.lowRiskTurn(turnClass, turnCats),
                vision: hasMediaThisIter,
            });
            turnArm = pick.arm;
            model = pick.arm.model;
            console.log(
                `  🎯 Learned router: ${turnClass} → ${pick.arm.id}${pick.explored ? " (trying)" : ""} [${pick.reason}]`,
            );
        }

        // ── Simple desktop tasks stay on Haiku ──
        // From iteration 3 the native router moves os_* loops to Sonnet by
        // iteration count alone, a rule from when the model couldn't see the
        // screen. A non-complex desktop turn keeps Haiku until a step fails.
        // GUI-ness comes from the classifier's own categories: the turn's tool
        // set is padded with chain categories (e.g. shell for system_automation).
        if (iterations === 1) {
            guiTurn =
                !!turnTier &&
                turnTier !== "complex" &&
                isGuiOnly(toolSelection.classification?.categories ?? []) &&
                !opusWarranted(rawUserMessage, errorCount, modelHint);
        } else if (forcedPick) {
            guiTrouble = true; // don't undo a forced escalation next iteration
        } else if (guiPinned() && claudeTier(model) !== "haiku") {
            console.log(`  🖱️ Desktop task stays on Haiku (router picked ${claudeTier(model)})`);
            model = MODELS.HAIKU;
        }

        // The learned pick keeps the turn (one model: one prompt cache) until something goes
        // wrong, the turn widens into another kind of task (request_tools: browser, code), or a
        // nudge asked for a stronger model (lastToolCalls cleared); then the rules above decide.
        if (iterations > 1 && turnArm && !turnArmReleased && turnClass) {
            const widened =
                !!requestedCategories?.length &&
                learnedRouter.classifyTurn(
                    { ...toolSelection.classification, categories: [...turnCats, ...requestedCategories] },
                    false,
                ) !== turnClass;
            // A model that can't find things in a screenshot (scripts/eval-grounding.ts: gpt-4.1-nano
            // and gpt-4o-mini 3%, Haiku 94%) hands the turn back once one arrives.
            const blind = turnSawImage && !turnArm.vision;
            if (blind) console.log(`  🎯 Learned router: ${turnArm.id} can't read screenshots, back to the rules`);
            if (forcedPick || errorCount > 0 || widened || blind || lastToolCalls === undefined) turnArmReleased = true;
            else model = turnArm.model;
        }

        // Unhinged keeps the whole turn on Grok (after the desktop Haiku pin above).
        if (unhingedTurn && !forcedPick && errorCount < 2) {
            if (model !== MODELS.GROK) console.log("  🧭 Unhinged tone → grok");
            model = MODELS.GROK;
        }

        // ── Harness trace: record selected tools ──
        if (iterations === 1 && _harnessTraceId) {
            if (_harnessTraceId)
                recordToolsSelected(_harnessTraceId, tools.map((t) => t.function?.name ?? String(t)).filter(Boolean));
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

        // Fence the memory/context block with <memory-context>…</memory-context>
        // markers so the LLM treats it as recalled context, not new user input.
        // The output-side sanitizeContextEchoes (already wired in llm.ts) strips
        // any verbatim echoes of these fences from responses.
        const fencedInjection = activeInjection
            ? (await import("./context-scrubber.js")).fenceMemoryContext(activeInjection)
            : "";
        // Lead with the system-reminder semantics so the model knows that
        // <system-reminder> tags are trusted runtime instruction (we strip
        // them from user input at the boundary; without this prelude, a
        // model could be coaxed by injection-shaped text into honoring fake
        // reminders that slipped through some upstream sanitizer gap).
        pruneOldScreenshots(messages);
        let iterationMessages: ChatCompletionMessageParam[] = [
            { role: "system" as const, content: SYSTEM_REMINDER_EXPLANATION },
        ];
        if (fencedInjection) iterationMessages.push({ role: "system" as const, content: fencedInjection });
        iterationMessages.push(...messages);

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
            const register = CHANNEL_REGISTER[channelContext.channel];

            const ctxMsg = `[Channel: ${channelContext.channel} | User: ${channelContext.userName || channelContext.userId} | Role: ${channelContext.isOwner ? "owner" : "contact"} | Active channels: ${activeChannels.join(", ")} | Primary channel for notifications: ${primaryChannel}${register ? ` | Register: ${register}` : ""}]`;
            iterationMessages.push({ role: "system", content: ctxMsg });
        }

        // The tone the owner picked in Settings, restated next to their message
        // (never for contacts, groups or widget visitors).
        if (!channelContext || channelContext.isOwner) {
            const { getToneReminder } = await import("./setup/personality-sync.js");
            const tone = isSerious() ? SHADES_OFF_NOTE : getToneReminder();
            if (tone) iterationMessages.push({ role: "system", content: tone });
        }
        // identity.md allows one late-hour remark per night; the model can't
        // remember it made one, so say so (owner only; every step, since the
        // reply is usually written after the tool steps).
        if (channelContext?.isOwner === true) {
            const lateNote = lateNightNote();
            if (lateNote) iterationMessages.push({ role: "system", content: lateNote });
            const sigNote = signaturePhraseNote();
            if (sigNote) iterationMessages.push({ role: "system", content: sigNote });
            if (aboutSelf) iterationMessages.push({ role: "system", content: ABOUT_SELF_NOTE });
        }

        // ── Orchestrator Planning: Sonnet 4.6 generates execution plan for interactive tasks ──
        const planningCategories = ["os_control", "app_management", "browser", "media", "communication", "scheduling"];
        const actionCategoryCount = activeCategories.filter((c) => planningCategories.includes(c)).length;
        // Skip the ~14K-token Sonnet plan for UNAMBIGUOUS single-domain tasks:
        // the classifier was confident AND only one action-category is in play.
        // Genuinely multi-domain or ambiguous tasks still get a plan. Tunable
        // via ATLAS_ALWAYS_ORCHESTRATE=true to restore the old always-on path.
        const classifierConf = toolSelection.classification?.confidence ?? 0;
        const unambiguousSingleStep =
            process.env.ATLAS_ALWAYS_ORCHESTRATE !== "true" && actionCategoryCount <= 1 && classifierConf >= 0.85;

        // ── Simple GUI/messaging fast-path gate ──
        // "open WhatsApp and send a message" classifies as cats=[os_control,
        // app_management, communication] (the classifier emits all three for any
        // desktop-app driving — tool-router.ts), so actionCategoryCount>1 and the
        // unambiguousSingleStep skip never fires → a ~14K-token, ~20s Sonnet plan
        // runs for a one-shot GUI action (the bulk of per-task cost). These are
        // still ONE clear action. If EVERY active action-category is in the simple
        // GUI/app/messaging/media set (no browser/scheduling/coding/research/shell/
        // file — those imply multi-step or web/dev work) and the task isn't chained
        // or multi-step, skip the plan. Mirrors the music fast-path. Platform-agnostic.
        const SIMPLE_ACTION_CATEGORIES = new Set([
            "os_control",
            "app_management",
            "communication",
            "media",
            "system_controls",
        ]);
        const activeActionCats = activeCategories.filter(
            (c) => planningCategories.includes(c) || c === "system_controls",
        );
        const allCatsSimple =
            activeActionCats.length > 0 && activeActionCats.every((c) => SIMPLE_ACTION_CATEGORIES.has(c));
        const intentStr = (toolSelection.classification?.intent || "").toLowerCase();
        const multiStepIntent = /research|swarm|workflow|pipeline|then|after that|multi/.test(intentStr);
        const multiAppOrChained =
            / then |, then|after that| followed by /i.test(rawUserMessage) ||
            (rawUserMessage.match(/\b(?:and|&)\b/gi)?.length ?? 0) >= 2;
        const simpleGuiFastPath =
            process.env.ATLAS_ALWAYS_ORCHESTRATE !== "true" &&
            process.env.ATLAS_NO_GUI_FASTPATH !== "true" &&
            allCatsSimple &&
            !multiStepIntent &&
            !multiAppOrChained &&
            classifierConf >= 0.7;

        // The classifier says whether the turn is multi-step; a single-step or
        // chat turn doesn't need a plan however many categories it touches.
        const turnCls = toolSelection.classification;
        const classifierSaysSingleStep =
            process.env.ATLAS_ALWAYS_ORCHESTRATE !== "true" &&
            !!turnCls?.tier &&
            !turnCls.multi_step &&
            turnCls.tier !== "complex" &&
            !multiAppOrChained &&
            !multiStepIntent;
        const needsPlanning =
            actionCategoryCount > 0 && !unambiguousSingleStep && !simpleGuiFastPath && !classifierSaysSingleStep;
        if (iterations === 1 && classifierSaysSingleStep && actionCategoryCount > 0) {
            console.log(`  ⚡ Single-step ${turnCls?.tier} task — skipping orchestrator plan`);
        }
        if (iterations === 1 && simpleGuiFastPath && !unambiguousSingleStep) {
            console.log(
                `  ⚡ Simple GUI/messaging fast-path — skipping Sonnet orchestrator (cats=[${activeActionCats.join(",")}] intent="${intentStr}" conf=${classifierConf.toFixed(2)})`,
            );
        }
        if (iterations === 1 && needsPlanning && !musicFastPathActive) {
            try {
                const planStart = Date.now();
                // Dynamic plan-model routing by task complexity (DeepSeek/Gemini/Sonnet).
                // ATLAS_NO_DYNAMIC_ORCHESTRATOR forces "complex" → Sonnet (old behavior).
                const orchComplexity =
                    process.env.ATLAS_NO_DYNAMIC_ORCHESTRATOR === "true"
                        ? "complex"
                        : classifyOrchestratorComplexity(rawUserMessage, {
                              activeCategories: activeCategories || [],
                              classifierConfidence: classifierConf,
                              intent: intentStr,
                              actionCategoryCount,
                          });
                const orchPick = pickOrchestratorModel(orchComplexity);
                const orchShadow = process.env.ATLAS_ORCH_SHADOW === "true";
                const planModel = orchShadow ? MODELS.SONNET : orchPick.model;
                const planThinking = orchShadow ? "low" : orchPick.thinkingLevel;
                console.log(
                    `  📋 Orchestrator: Planning with ${orchShadow ? "Sonnet 4.6 (shadow)" : orchPick.display} (complexity=${orchComplexity})...`,
                );

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
                // Defang user-supplied text in recent pairs to neutralize prompt-injection
                // attempts targeting the orchestrator's identity-defense layer.
                const { defangPlanInjection: defangInput } = await import("./agents/defang-plan-injection.js");
                const recentPairs: string[] = [];
                const historySlice = messages.slice(-12); // last ~6 user/assistant pairs
                for (const msg of historySlice) {
                    if (msg.role === "user" && typeof msg.content === "string") {
                        const safe = defangInput(msg.content.substring(0, 150)).text;
                        recentPairs.push(`User: ${safe}`);
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
                // Owner's session: never in a contact's plan prompt.
                const summary = isContactAgent ? "" : getSessionSummary();
                const sessionCtx = summary ? `\n\n${summary}` : "";

                const planRequest = {
                    messages: [
                        {
                            role: "user" as const,
                            content: `Task: "${rawUserMessage}"${prefContext}${strategyContext}${conversationContext}${sessionCtx}${memoryContext}

Create a precise execution plan.

TOOLS (the only tools available this turn — name no others):
${planToolsBlock(tools.filter((t) => toolAllowlist === undefined || isToolAllowed(toolAllowlist, t.function.name)))}

HINTS (apply a hint only if the tools it names are listed above):
- Desktop: app_manager action='activate' app="WhatsApp"; os_smart_click instruction="the Send button" clicks by description (prefer it over os_nav+os_click_element or raw apple_script); os_type text=/key=/combo= after focusing the field; os_visual_verify expect_text=/expect_gone= after any step that changes UI state. Raw AppleScript keystrokes are the LAST resort.
- Music: spotify action='play' query="exact song name" (or "<name> playlist", "liked songs"); action='now_playing' to verify. music_control is the same for Apple Music.
- Messaging: whatsapp_send for paired contacts; messages_tool is iMessage only. If whatsapp_send fails, drive the WhatsApp app: app_manager activate → os_smart_click "new chat button" → os_type the name → os_smart_click the contact → os_type the message → os_smart_click "send button" → os_visual_verify expect_text=the_message.

CRITICAL RULES:
1. **Verify before declaring done.** Every UI-driving plan ENDS with os_visual_verify (or for music, spotify action='now_playing'). Never say "done" off a fire-and-forget AppleScript.
2. **Prefer os_smart_click over raw keystroke sequences.** "Cmd+N then type the name then return" reads correctly but does NOT verify focus and breaks silently if the wrong window has focus. os_smart_click checks before clicking.
3. **For music queries, search EXACTLY what the user said.** "play the song time" → query="Time", NOT "Time Pink Floyd". If the query is AMBIGUOUS (common words like "Time", "Happy", "Stay", "Home"), step 1 = ASK_USER "Which 'Time'? Some options: Pink Floyd, MKJ, NF, Hans Zimmer (Inception). Which one?"
4. **For os_click_element legacy path, prefer text= over label=N.** Text matches survive screen layout changes; label numbers don't.

Write 3-8 numbered steps with exact tool calls.
PLAN:`,
                        },
                    ],
                    modelOverride: planModel,
                    thinkingLevel: planThinking,
                    serverPromptSlug: "orchestrator-base",
                };
                let planResponse: Awaited<ReturnType<LLMClient["chat"]>> | undefined;
                let escalatedToSonnet = false;
                try {
                    planResponse = await llm.chat(planRequest);
                } catch (planErr) {
                    // Failover: a cheap-tier (DeepSeek/Gemini) outage or timeout must
                    // degrade to a Sonnet plan, not to no plan at all. One-shot retry.
                    if (planModel !== MODELS.SONNET) {
                        console.warn(
                            `  ⚠️ Orchestrator plan failed on ${orchPick.display} (${(planErr as Error).message}) — retrying on Sonnet 4.6`,
                        );
                        escalatedToSonnet = true;
                        planResponse = await llm.chat({
                            ...planRequest,
                            modelOverride: MODELS.SONNET,
                            thinkingLevel: "low",
                        });
                    } else {
                        throw planErr;
                    }
                }
                logOrchestratorRouting({
                    complexity: orchComplexity,
                    model: escalatedToSonnet ? MODELS.SONNET : planModel,
                    shadow: orchShadow,
                    actionCategoryCount,
                    classifierConfidence: classifierConf,
                    activeCategories: activeCategories || [],
                    messageLen: rawUserMessage.length,
                    planLatencyMs: Date.now() - planStart,
                    escalatedToSonnet,
                });
                const rawPlanText = planResponse?.choices?.[0]?.message?.content || "";
                const { defangPlanInjection } = await import("./agents/defang-plan-injection.js");
                const defanged = defangPlanInjection(rawPlanText);
                const planText = defanged.text;
                if (defanged.scrubbed) {
                    console.warn(
                        `  ⚠️ Orchestrator plan scrubbed (${defanged.patternsHit} identity-affirming pattern(s) neutralized)`,
                    );
                }

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
                            content: `[ORCHESTRATOR PLAN — follow precisely]\n${planText}\n\n[EXECUTION RULES]\n- Follow the plan step by step.\n- For "click X" steps, ALWAYS try os_smart_click first (it cascades AX → OmniParser → UI-TARS automatically). Only fall back to os_nav+os_click_element text= or os_ocr_click if os_smart_click returns cascade_miss.\n- Raw apple_script keystroke sequences ("cmd+n then type then return") fire blind and silently fail when focus is wrong. They are the LAST resort, never the first attempt.\n- For Spotify/Music apps, os_click_element auto-double-clicks (plays the song). After playing a song, MUST call spotify action='now_playing' to verify the correct track is playing before saying "Done".\n- For ALL OTHER UI-driving tasks (sent a message, opened a tab, clicked through a form, etc.), MUST call os_visual_verify (or os_screenshot + inspect the result) before saying "Done". Never claim success off a fire-and-forget tool call.\n- If a step fails, escalate via the cascade: os_smart_click → os_inspect+os_click_id → os_nav+os_click_element text= → os_ocr_click.`,
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
        if (toolAllowlist !== undefined) {
            finalTools = tools.filter((t) => isToolAllowed(toolAllowlist, t.function.name));
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

        if (turnArm && model !== turnArm.model) turnArmLeft = true; // another model runs this step
        let response: Awaited<ReturnType<LLMClient["chat"]>> | undefined;
        try {
            response = await llm.chat({
                messages: iterationMessages,
                tools: finalTools,
                thinkingLevel: iterThinking,
                modelOverride: model,
                skillSlugs: iterSkillSlugs,
                // Unhinged on Grok gets its own personality prompt (rules + prompts/unhinged.md)
                // instead of the default one, whose calm, short style rules won out.
                serverPromptSlug: model === MODELS.GROK ? "unhinged" : undefined,
                // Unhinged runs hot: a higher sampling temperature makes Grok wilder
                // and less predictable — the point of the mode. Normal turns omit it.
                temperature: model === MODELS.GROK ? 1.1 : undefined,
            });
        } catch (llmErr) {
            if (turnArm && model === turnArm.model) turnArmInfra = true; // provider trouble, not the model's answer
            cbRecordFailure(circuitBreaker);
            console.error(`[AGENT] LLM call threw: ${(llmErr as Error).message} — attempting recovery`);
            lastLlmError = (llmErr as Error).message ?? "";
            // Out of credits: no other model or retry can help, say so once.
            if ((llmErr as { status?: number }).status === 402) {
                if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                return {
                    text: OUT_OF_CREDITS_REPLY,
                    toolCalls: totalToolCalls,
                };
            }
            // Try one more model before giving up this iteration
            // Step to a different Claude model, never up to Opus on an error.
            const fallbackModel = claudeTier(model) === "sonnet" ? MODELS.HAIKU : MODELS.SONNET;
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
                    // Only text written after THIS turn's user message counts (an out-of-credits
                    // user once got the last turn's answer again), and never the ack.
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                    const outOfCredits = /run out of (AI )?credits|insufficient credits/i.test(lastLlmError);
                    return {
                        text: outOfCredits
                            ? OUT_OF_CREDITS_REPLY
                            : stuckExitText(
                                  messages,
                                  "I lost my connection to the AI model",
                                  turnCalls.map((c) => c.fnName),
                                  turnContract,
                              ),
                        toolCalls: totalToolCalls,
                        // Out of credits: a Retry tap would fail the same way, so no handoff buttons.
                        stuck: !outOfCredits,
                    };
                }
                console.warn(`[AGENT] LLM error (attempt ${errorCount}/3) — retrying next iteration`);
                pushNudge(messages, "[SYSTEM] The LLM call failed. Retry with a different approach.");
                continue;
            }
        }

        // ── Empty response recovery ──
        // If LLM returns empty/undefined, retry with escalating models before giving up.
        if (!response?.choices?.length) {
            console.warn(`[AGENT] LLM returned empty/undefined response from ${model} — attempting recovery`);
            // Retry on a different Claude model (Sonnet, then Haiku), never Opus.
            const retryModels = [MODELS.SONNET, MODELS.HAIKU].filter((m) => claudeTier(m) !== claudeTier(model));
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
                pushNudge(
                    messages,
                    "[SYSTEM] Previous LLM call returned empty. Take a different approach to complete the user's request.",
                );
                continue;
            }
        }
        // A reply from another model than the pick (Convex's silent Azure→Claude fallback, a
        // client failover): provider trouble, so this turn says nothing about the picked model.
        const served = String(response.model ?? "");
        if (
            turnArm &&
            model === turnArm.model &&
            served &&
            (turnArm.model.startsWith("azure/") ? /^claude/i.test(served) : claudeTier(served) !== claudeTier(turnArm.model))
        )
            turnArmInfra = true;
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
        const hasToolCalls = !!assistantMessage.tool_calls?.length;
        // The contract comes only from the ack, before any tool output is in
        // context, so quoted page/email text can't become the done-criterion.
        // Owner (or internal) turns only: a contact's text must never come back
        // as a system-role "your own done-criterion".
        if (totalToolCalls === 0 && !turnContract && (!channelContext || channelContext.isOwner)) {
            turnContract = extractDoneContract(assistantMessage.content);
            if (turnContract && !isForked)
                updateSessionGoal((findAckLine(assistantMessage.content) ?? turnContract).slice(0, 200));
            const ackLine = contractProgressLine(assistantMessage.content, hasToolCalls);
            if (ackLine && onProgress) {
                try {
                    await onProgress(ackLine);
                } catch {
                    /* non-fatal */
                }
            }
        }

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

            const recentFailures = antiGivingUpFailures(messages, lastUserText, responseText, totalToolCalls);
            if (recentFailures > 0) {
                const hasVisualTools = toolSelection.categories.includes("os_control");
                const continuationHint = hasVisualTools
                    ? "Use os_smart_click with a natural-language instruction (e.g. 'the Wi-Fi row') — it cascades AX → OmniParser → UI-TARS/cloud grounding automatically and is far more reliable than os_ocr_click, which has been failing here. Only fall back to os_screenshot + os_click if os_smart_click returns cascade_miss. You have full mouse+keyboard control."
                    : "Try a completely different approach — use request_tools if you need different capabilities, or try browser_navigate to accomplish it via the web.";

                console.log(
                    `  🔄 Anti-giving-up: agent stopped after tool failure (${recentFailures} errors) — forcing retry with visual fallback`,
                );
                pushRetry(
                    messages,
                    responseText,
                    `Your previous approach didn't work, but the task is NOT done. Don't ask the owner — try a different approach yourself. ${continuationHint} If your dedicated tool failed, that's fine — you have dozens of other tools. Complete the task, then verify the result.`,
                );
                lastToolCalls = undefined;
                continue;
            }

            if (
                !lookNudged &&
                asksLeaveToLook(
                    responseText,
                    toolSelection.categories.some((c) => c === "os_control" || c === "system_controls"),
                )
            ) {
                lookNudged = true;
                console.log("  🔄 Asked leave to look before finishing — continuing instead");
                pushRetry(
                    messages,
                    responseText,
                    "You can see the owner's screen yourself: don't ask them to look or ask leave to look. Open what shows it (e.g. the right System Settings pane), read it with os_inspect or a screenshot, finish the task, and give them the actual answer.",
                );
                lastToolCalls = undefined;
                continue;
            }

            // An ack with no action: the contract line ("on it — …; done = …") and no tool
            // call, so nothing happened. Small models stop there (gpt-5-nano, model-ladder eval).
            if (!ackNudged && ackWithoutAction(responseText, totalToolCalls)) {
                ackNudged = true;
                console.log("  🔄 Announced the task but called no tool — continuing");
                pushRetry(
                    messages,
                    responseText,
                    "You said what you'll do but made no tool call, so nothing has happened yet. Do it now with your tools, then tell the owner the result.",
                );
                lastToolCalls = undefined;
                continue;
            }

            // ── Verify-before-done gate ──
            // If a state-mutating OS tool fired this run but no verifier did,
            // force one extra iteration with a system reminder. This catches
            // the "agent claims message-sent without ever checking" failure
            // mode that no other guard catches (the persistence-nudge fires
            // on count-of-tool-calls, not on whether the actions were
            // verified). Capped at one fire per run via verifyGate.nudgedThisRun.
            // Kill-switch: ATLAS_NO_VERIFY_GATE=true disables.
            if (verifyGateFires(verifyGate, responseText)) {
                console.log(
                    `  🔍 Verify gate: ${verifyGate.lastMutator} mutated UI but no verification ran — forcing one more iteration`,
                );
                verifyGate.nudgedThisRun = true;
                pushRetry(messages, responseText, buildVerifyReminder(verifyGate));
                if (turnContract) pushNudge(messages, contractCheckNudge(turnContract));
                lastToolCalls = undefined; // bump model selection to PRO for the verify-and-respond turn
                continue;
            }

            // ── Decision: should we nudge? ──
            // Only nudge if the agent made very few tool calls (< 6) AND none of the
            // bail-out signals fired AND the user's message looks like a real task.
            // Two thresholds for "substantial response": with 3+ tool calls a short
            // 80-char wrap-up is enough; with 2 tool calls we need 200+ chars (the
            // agent really wrote a meaningful answer, not "checking..."); a 600+
            // char response is always considered substantial regardless of tool
            // count — the previous logic was nudging the agent even after it had
            // written 1800-token comprehensive answers because it had only made
            // 2 tool calls.
            const hasSubstantialResponse =
                (responseText.length > 80 && totalToolCalls >= 3) ||
                (responseText.length > 200 && totalToolCalls >= 2) ||
                responseText.length > 600;
            const shouldNudge =
                !takeStuckMarker(responseText).stuck &&
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
                pushRetry(
                    messages,
                    responseText,
                    "There may be more steps to this task. If it is done, give your final answer to the owner's last message and don't mention this check; otherwise keep working.",
                );
                // Force PRO model for the assessment (without polluting errorCount)
                // The next iteration will use PRO regardless of tool history
                lastToolCalls = undefined; // Clears FLASH routing, causes chooseModel to pick PRO
                continue;
            }
            // ─────────────────────────────────────────────────────────────────

            // Final response — use PRO for synthesis if needed
            // Note: if PRO itself wants to keep using tools, let the loop continue.
            // Only when a stronger model would write it: re-asking the same tier
            // re-sends the whole context to rewrite an answer we already have.
            const finalSelection = totalToolCalls > 0 ? selectForFinalAnswer(selection.taskType) : null;
            const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 } as const;
            if (
                finalSelection &&
                model !== MODELS.PRO &&
                // Choosing to stay silent is the answer; a stronger model mustn't overwrite it.
                responseText.trim().toUpperCase() !== "[NO_REPLY]" &&
                TIER_RANK[claudeTier(finalSelection.modelId)] > TIER_RANK[claudeTier(model)]
            ) {
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
                        const batchResults = await runToolBatch(
                            finalChoice.message.tool_calls as Array<{
                                id: string;
                                function: { name: string; arguments: string };
                            }>,
                            {
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
                                signal,
                            },
                        );
                        totalToolCalls += batchResults.length;
                        // Verify-before-done gate — same recording as the main loop site.
                        recordBatch(batchResults);
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
                    const text = finalReplyText(rawText, channelContext) || "(empty response)";
                    // Retry if final model produced empty response after tool calls.
                    // BUT: if the prompt is already huge (>40K tokens), retrying the
                    // same prompt at the same model produces the same empty response
                    // — that's context-overflow / model exhaustion, not a transient
                    // glitch. Prune the conversation history before retrying so we
                    // don't burn another 57K-token call to get 3 tokens back.
                    const promptTokens = finalResponse.usage?.prompt_tokens ?? 0;
                    if (
                        text === "(empty response)" &&
                        lastToolCalls &&
                        lastToolCalls.length > 0 &&
                        emptyResponseRetries < MAX_EMPTY_RETRIES
                    ) {
                        emptyResponseRetries++;
                        console.log(
                            `  🔄 Empty response from final model after tool calls — retry ${emptyResponseRetries}/${MAX_EMPTY_RETRIES} (prompt=${promptTokens} tokens)`,
                        );
                        // If the prompt is overflowing, drop early tool-result
                        // messages to make room before the retry. Without this
                        // the retry hits the same context-overflow path.
                        if (promptTokens > 40_000 && messages.length > 12) {
                            const keepFirst = 2; // system + initial user
                            const keepLast = 8; // recent tool results + user message
                            const dropped = messages.length - keepFirst - keepLast;
                            if (dropped > 0) {
                                messages.splice(keepFirst, dropped);
                                console.log(`  ✂️ Pruned ${dropped} mid-conversation messages to recover from overflow`);
                            }
                        }
                        pushRetry(
                            messages,
                            "",
                            "You produced an empty response. Please provide a concise meaningful reply to the user based on what you've already done.",
                        );
                        lastToolCalls = undefined;
                        continue;
                    }
                    messages.push({ role: "assistant", content: text });
                    if (ownerTurn) appendTurn("assistant", text);
                    maybeReflect();
                    if (usedBrowserTools) autoSaveSession();
                    // Credits deducted per-API-call in llm.ts
                    if (_harnessTraceId) finalizeTrace(_harnessTraceId, true);
                    settleLearnings(text);
                    return { text, toolCalls: totalToolCalls, receipt: await receiptFor(text) };
                }
            }

            let text = finalReplyText(responseText, channelContext) || "(empty response)";

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
                pushRetry(
                    messages,
                    "",
                    "You produced an empty response. Please provide a meaningful reply to the user.",
                );
                lastToolCalls = undefined;
                continue;
            }

            // ── Cascade escalation: detect poor responses and re-try with a better model ──
            // Only attempt once per turn to avoid infinite loops, and only if not already on the best model
            if (model !== MODELS.PRO && !cascadeAttempted && text !== "[NO_REPLY]") {
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
            if (ownerTurn) appendTurn("assistant", text);
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

            // A3: record the metacognition outcome for this turn (best-effort).
            logOutcome(metaState, true, { taskType: selection?.taskType, modelTier: model });

            // Credits deducted per-API-call in llm.ts
            if (_harnessTraceId) finalizeTrace(_harnessTraceId, true);
            if (process.env.ATLAS_NO_FORGE_VERIFIER !== "true") {
                import("./forge/pending-consumer.js")
                    .then(({ consumeOnePending }) => consumeOnePending())
                    .catch((e: Error) => console.warn("[forge] pending consume failed:", e.message));
            }
            settleLearnings(text);
            return { text, toolCalls: totalToolCalls, receipt: await receiptFor(text) };
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
        const batchResults = await runToolBatch(
            assistantMessage.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>,
            {
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
                channelContext,
                signal,
            },
        );
        totalToolCalls += batchResults.length;

        // Verify-before-done gate — record every tool call against the per-run
        // bookkeeper. Only successful (or even attempted) mutators flip
        // osStateMutated; that's the right semantics because a *failed* click
        // can still leave the UI in a half-changed state we need to verify.
        recordBatch(batchResults);
        // A tool made or turned on this batch must be offered next iteration.
        if (batchResults.some((r) => !r.isError && (r.fnName === "create_tool" || r.fnName === "approve_dynamic_tool")))
            turnToolSelection = undefined;

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

        for (const r of batchResults) {
            const errorMsg = getErrorMessage(r.fnName, r.result);
            if (errorMsg) await sendProgress(errorMsg);
            // Track tool success/failure per model per task type for adaptive routing
            updateToolStats(model, !errorMsg, selection.taskType);

            // ── Per-turn loop guardrail: identical-args repeat detection ──
            // Appends a steering hint when the same tool keeps failing with the
            // same args. Warn-only unless ATLAS_TOOL_LOOP_HARDSTOP=true.
            const guard = recordGuardrailCall(guardrailState, {
                fnName: r.fnName,
                fnArgs: r.fnArgs,
                isError: r.isError,
            });
            if ((guard.hint || guard.hardStop) && typeof r.finalContent === "string") {
                const note = guard.hardStop
                    ? `\n\n[SYSTEM — LOOP GUARD] \`${r.fnName}\` has failed ${guard.failureCount} times with identical arguments. STOP calling it with these arguments; change approach or report the blocker to the user.`
                    : guard.hint;
                r.finalContent = r.finalContent + note;
            }

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
                if (ownerTurn) wmRetain(`tool_${r.toolCallId}`, "tool_result", `[${r.fnName}] ${summary}`, importance);
            } catch {
                /* working memory not initialized */
            }

            // ── Metacognition: update signals per tool call ──
            updateSignals(metaState, {
                toolName: r.fnName,
                hadError: r.isError,
                responseLength: r.result.length,
                wasEmpty: r.result.length === 0 || r.result === "{}",
                // A1: content-aware step key (toolName + canonical args) so the
                // metacognition loop detector sees identical-args spirals.
                stepKey: canonicalArgsHash(r.fnName, r.fnArgs),
            });
        }

        // ── Hard no-progress loop guard ───────────────────────────
        // Narrow by design so it does NOT cut short legitimate long/iterative
        // work: it ONLY counts batches where EVERY result genuinely failed or
        // came back empty. A batch with any usable output resets the streak.
        //
        // Exemptions — these tools legitimately repeat with identical/empty
        // output and must never feed the streak:
        //   • polling/monitoring (shell_check_process, shell_wait_process,
        //     check_long_task, check_deep_research) — "still running" is normal
        //   • genuinely-empty-but-successful ops (mkdir, mv, grep-no-match)
        // Long-running WORK delegates out via start_long_task (handled below)
        // and never grinds this loop, so this only catches interactive spirals.
        // Disable entirely with ATLAS_NO_PROGRESS_LIMIT=0.
        const LOOP_EXEMPT_TOOLS = new Set([
            "shell_check_process",
            "shell_wait_process",
            "shell_exec_background",
            "check_long_task",
            "check_deep_research",
            "shell_kill_process",
        ]);
        const batchHasExemptTool = batchResults.some((r) => LOOP_EXEMPT_TOOLS.has(r.fnName));
        if (NO_PROGRESS_LIMIT > 0 && batchResults.length > 0 && !batchHasExemptTool) {
            // "Useless" = errored OR truly empty result. We do NOT trip on
            // identical-but-non-empty output: a task that keeps reading similar
            // data is making progress, not stuck.
            const allUseless = batchResults.every(
                (r) => r.isError || !r.result || r.result.length === 0 || r.result === "{}",
            );
            if (allUseless) {
                noProgressStreak++;
            } else {
                noProgressStreak = 0;
            }

            if (noProgressStreak >= NO_PROGRESS_LIMIT) {
                console.warn(
                    `  🛑 No-progress loop guard tripped after ${noProgressStreak} all-failed/empty batches — ending turn (iteration ${iterations})`,
                );
                const stuckMsg =
                    "I tried several approaches but couldn't get a useful result — the commands kept returning nothing or failing. Rather than keep retrying, here's where I got stuck: the tool calls aren't returning the data I need. Could you tell me a bit more, or try running it directly?";
                messages.push({ role: "assistant", content: stuckMsg });
                if (ownerTurn) appendTurn("assistant", stuckMsg);
                // P5.2 STEP-0: genuine reasoning-failure terminal exit (gave up after
                // sustained no-progress) → true-negative label for calibration.
                try {
                    logOutcome(metaState, false, { taskType: selection?.taskType, modelTier: model });
                } catch {
                    /* best-effort */
                }
                if (_harnessTraceId) finalizeTrace(_harnessTraceId, false);
                settleLearnings(stuckMsg, true);
                return { text: stuckMsg, toolCalls: totalToolCalls, stuck: true };
            }
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
                if (ownerTurn) appendTurn("assistant", delegationText);
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
        const hasToolFailure = batchResults.some(toolFailed);
        if (hasToolFailure) guiTrouble = true;
        const hasAppOpened = allResults.includes('"action":"activate"') || allResults.includes('"action":"launch"');
        // Click results ("clicked", "double_clicked", "right_clicked", the smart-click
        // "clicked" field), not the bare tool name, which also appears in tool tips.
        const hasClick = allResults.includes('clicked"');
        const hasSearch = allResults.includes("search_play") || allResults.includes("search_visible");
        const isPlaying = allResults.includes('"playing":true');

        // Key insight: if no verification tool was used in THIS batch, the task isn't done
        // Same notion of "checked" as the verify-before-done gate (incl. a screenshot).
        const usedVerification = batchResults.some(
            (r) => !r.isError && (isVerifier(r.fnName, r.fnArgs || {}) || r.fnName === "os_nav"),
        );

        if (usedVerification) verificationNagged = false;
        if (
            (hasToolFailure || hasAppOpened || hasSearch || (hasClick && !isPlaying)) &&
            !usedVerification &&
            !musicFastPathActive &&
            !verificationNagged
        ) {
            // Once until a verification happens: one copy per step piled up in history.
            verificationNagged = true;
            pushNudge(
                messages,
                `[VERIFICATION REQUIRED] Your last action may not have completed the task. Before responding to the user:
1. VERIFY the result (e.g., spotify action='now_playing', os_nav to confirm state, os_visual_verify)
2. If verification shows the task isn't done, keep working — try alternative approaches
3. Only tell the user "done" after you have CONFIRMED the task succeeded
Do NOT assume success from a single click or tool call.${turnContract ? `\n${contractCheckNudge(turnContract)}` : ""}`,
            );
        }
        if (musicFastPathActive && !hasToolFailure) {
            const sawSpotifyCall = batchResults.some((r) => r.fnName === "spotify" || r.fnName === "music_control");
            if (sawSpotifyCall) {
                pushNudge(
                    messages,
                    "[FAST_PATH_DONE] The music tool returned success. Reply briefly confirming the song is playing (one short sentence). Do NOT call now_playing or any other tool unless the user asks a follow-up question.",
                );
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
