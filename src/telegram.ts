// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename as nodeBasename } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import {
    type ChannelContext,
    clearConversation,
    getConversationCount,
    getConversationHistory,
    type MediaAttachment,
    runAgent,
    setThinkingLevel,
} from "./agent.js";
import { resolveInterrupt } from "./agents/human-interrupt.js";
import {
    cancelLongTask,
    getLongTaskStatus,
    type LongTask as LongTaskType,
    listActiveLongTasks,
} from "./agents/long-task.js";
import {
    categorizeError,
    getErrorMessage,
    getProgressMessage,
    getResponseTimeAck,
    getThinkingPhrase,
    getVoiceStagePhrase,
    getWaitPhrase,
    smartChunkMessage,
} from "./alive-ux.js";
import { getThinkingLevel, handleCommand, initCommands } from "./commands/index.js";
import { getConvexSiteUrl } from "./config/keys.js";
import { getDataDir } from "./config/paths.js";
import type { Config } from "./config.js";
import { encryptedFetch } from "./crypto-transport.js";
import type { LLMClient } from "./llm.js";
import { MODELS } from "./llm.js";
import { classifyQuery } from "./memory/classifier.js";
import { getSessionToken } from "./session.js";
import { batchKey } from "./telegram-batch.js";
import {
    clearDeepResearchProgress,
    clearLongTaskProgress,
    clearSwarmProgress,
    setDeepResearchProgress,
    setLongTaskProgress,
    setSwarmProgress,
} from "./tools/index.js";
import { setTelegramContext } from "./tools/send-file.js";

// ── Markdown → Telegram HTML ──────────────────

// Sanitize attacker-controlled inbound text before wrapping in delimiters.
function sanitizeIncomingChannelText(text: string): string {
    if (!text) return text;
    return text
        .replace(/\[SYSTEM NOTE:/gi, "[user-quoted-text:")
        .replace(/\[ATLAS-INTERNAL\b/gi, "[user-quoted-text")
        .replace(/<system_log>/gi, "&lt;system_log&gt;")
        .replace(/<\/system_log>/gi, "&lt;/system_log&gt;")
        .replace(/<tool_log/gi, "&lt;tool_log")
        .replace(/<\/tool_log>/gi, "&lt;/tool_log&gt;")
        .replace(/\[Tool Result/gi, "[user-quoted-text Tool Result");
}

// ── Strip internal debug blocks before sending ──
// Cleans out any <system_log>...</system_log> blocks that may leak from
// context-pruning compressed messages into the LLM's final reply.
function sanitizeReply(text: string): string {
    return text
        .replace(/<system_log>[\s\S]*?<\/system_log>/g, "")
        .replace(/<tool_log[\s\S]*?<\/tool_log>/g, "")
        .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
        .replace(/\[SYSTEM NOTE:[^\]]*\]/g, "") // Strip SYSTEM NOTE metadata from replies
        .trim();
}

function markdownToTelegramHtml(text: string): string {
    let html = text;

    // Escape HTML special chars (but preserve our conversions)
    html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Code blocks: ```lang\ncode\n``` → <pre>code</pre>
    html = html.replace(/```\w*\n?([\s\S]*?)```/g, "<pre>$1</pre>");

    // Inline code: `code` → <code>code</code>
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Bold: **text** → <b>text</b>
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

    // Italic: *text* → <i>text</i> (but not inside bold)
    html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");

    // Strikethrough: ~~text~~ → <s>text</s>
    html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Underline: __text__ → <u>text</u>
    html = html.replace(/__(.+?)__/g, "<u>$1</u>");

    // Headings: # text → <b>text</b> (Telegram has no heading tags)
    html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Horizontal rules: --- or *** or ___ → ———
    html = html.replace(/^[\s]*([-*_]){3,}[\s]*$/gm, "———");

    // Links: [text](url) → <a href="url">text</a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Numbered lists: 1. item → 1. item (preserve as-is, Telegram renders them okay)
    // But ensure consistent formatting
    html = html.replace(/^(\d+)\.\s+/gm, "$1. ");

    // Bullet points: * item or - item → • item
    html = html.replace(/^[\s]*[*-]\s+/gm, "• ");

    // Simple table support: convert markdown tables to readable plain text format
    // Match table rows like | cell | cell | cell |
    const tableMatch = html.match(/^\|.+\|$/gm);
    if (tableMatch && tableMatch.length >= 2) {
        // This is a table, convert to readable format
        html = html.replace(/^\|(.+)\|$/gm, (_, content) => {
            // Skip separator rows (|---|---|)
            if (/^[\s\-:|]+$/.test(content)) return "";
            // Convert cells to tab-separated
            return content
                .split("|")
                .map((c: string) => c.trim())
                .filter(Boolean)
                .join("  │  ");
        });
        // Remove empty lines from separator removal
        html = html.replace(/\n{2,}/g, "\n");
    }

    return html;
}

// ── Inline Keyboards ─────────────────────────

/** Main quick-action menu shown on /start and /help. */
function buildMainMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("Deep Research", "cmd:research")
        .text("Browse Web", "cmd:browse")
        .row()
        .text("Check Tasks", "cmd:tasks")
        .text("Memory Snapshot", "cmd:memory")
        .row()
        .text("System Status", "cmd:status");
}

/** Task progress keyboard shown when a long task starts. */
function buildTaskKeyboard(taskId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text("Check Progress", `task:check:${taskId}`)
        .text("Cancel Task", `task:cancel:${taskId}`);
}

// ── Improved Message Formatting ──────────────

/** Scrub internal file paths from error messages before showing to users. */
function scrubFilePaths(text: string): string {
    // Remove absolute paths like /Users/user/... or /home/user/... or C:\Users\...
    return text
        .replace(/(?:\/(?:Users|home|var|tmp|opt|usr|private|etc)\/[\w.\-/]+)/g, "[internal path]")
        .replace(/(?:[A-Z]:\\[\w.\-\\]+)/g, "[internal path]")
        .replace(/(?:at\s+[\w.]+\s+\(\/[^)]+\))/g, "") // strip stack trace locations
        .replace(/\n\s*at\s+.+/g, "") // strip stack trace lines
        .replace(/\n{3,}/g, "\n\n") // collapse excess blank lines
        .trim();
}

/** Format a long-task status into a user-friendly summary card. */
function formatTaskStatusCard(task: LongTaskType): string {
    const statusIcons: Record<string, string> = {
        planning: "📝",
        running: "🔄",
        paused: "⏸️",
        completed: "✅",
        failed: "❌",
        cancelled: "🛑",
    };
    const icon = statusIcons[task.status] || "📋";
    const elapsed =
        task.totalDurationMs > 0
            ? `${Math.round(task.totalDurationMs / 1000)}s`
            : `${Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000)}s`;
    const phasesCompleted = Object.keys(task.checkpointData).length;

    const lines = [
        `${icon} **Task: ${task.description.substring(0, 80)}**`,
        "",
        `Status: ${task.status.toUpperCase()}`,
        `Phases: ${phasesCompleted}/${task.phases.length}`,
        `Elapsed: ${elapsed}`,
    ];

    if (task.status === "running" && task.currentPhase < task.phases.length) {
        const current = task.phases[task.currentPhase];
        lines.push(`Current: ${current.description.substring(0, 60)}`);
    }

    if (task.error) {
        lines.push(`Error: ${scrubFilePaths(task.error).substring(0, 120)}`);
    }

    return lines.join("\n");
}

/** Format a task completion summary. */
function formatTaskCompletionCard(task: LongTaskType): string {
    const elapsed =
        task.totalDurationMs > 0
            ? formatDuration(task.totalDurationMs)
            : formatDuration(Date.now() - new Date(task.startedAt).getTime());
    const phasesCompleted = Object.keys(task.checkpointData).length;

    return [
        "✅ **Task Completed**",
        "",
        `**${task.description.substring(0, 100)}**`,
        `Phases completed: ${phasesCompleted}/${task.phases.length}`,
        `Total time: ${elapsed}`,
    ].join("\n");
}

function formatDuration(ms: number): string {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    if (mins < 60) return `${mins}m ${remainSecs}s`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}h ${remainMins}m`;
}

// ── Create Telegram Bot ───────────────────────

// Module-scoped refs so external modules (e.g. the inbox chat-fallback
// in src/proactive/inbox/chat-fallback.ts) can reach into the running
// bot without threading the instance through every call site.
let _moduleBot: Bot | null = null;
let _moduleConfig: Config | null = null;

/** Returns the running Telegram Bot instance, or null if not yet created. */
export function getTelegramBot(): Bot | null {
    return _moduleBot;
}

/** Returns the Config used to create the Telegram bot, or null if not yet created. */
export function getTelegramConfig(): Config | null {
    return _moduleConfig;
}

// F3: distinguish channel-allowed from platform-owner. OWNER_TELEGRAM_IDS
// is a strict subset of ALLOWED_USER_IDS; defaults to ALLOWED_USER_IDS (with
// a warning) for back-compat.
function parseTelegramOwners(config: Config): Set<number> {
    const raw = process.env.OWNER_TELEGRAM_IDS;
    if (!raw) {
        console.warn(
            "[TG] OWNER_TELEGRAM_IDS not set — defaulting owner set to ALLOWED_USER_IDS. Narrow this by setting OWNER_TELEGRAM_IDS to a strict subset.",
        );
        return new Set(config.allowedUserIds);
    }
    return new Set(
        raw
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n)),
    );
}

export function isPlatformOwner(channel: "telegram", userId: number, config: Config): boolean {
    if (channel !== "telegram") return false;
    return parseTelegramOwners(config).has(userId);
}

export function createTelegramBot(config: Config, llm: LLMClient): Bot {
    const bot = new Bot(config.telegramBotToken);
    _moduleBot = bot;
    _moduleConfig = config;
    const startTime = Date.now();
    const telegramOwners = parseTelegramOwners(config);

    // Initialize slash commands
    initCommands({
        config,
        startTime,
        sessionTokens: 0,
        thinkingLevel: "off",
        setThinkingLevel: (level: string) => setThinkingLevel(level),
        clearConversation,
        conversationCount: getConversationCount,
        llm,
        sendProgress: async (msg: string) => {
            await sendProactiveMessage(bot, config, msg);
        },
    });

    // ── Per-sender inbound rate limit (F7) ──
    const RATE_WINDOW_MS = 60_000;
    const RATE_MAX = 20;
    const rateBuckets = new Map<number, number[]>();
    function rateLimitAllow(userId: number): boolean {
        const now = Date.now();
        const arr = rateBuckets.get(userId) || [];
        const fresh = arr.filter((ts) => now - ts < RATE_WINDOW_MS);
        if (fresh.length >= RATE_MAX) {
            rateBuckets.set(userId, fresh);
            return false;
        }
        fresh.push(now);
        rateBuckets.set(userId, fresh);
        return true;
    }

    // ── Security: User ID whitelist middleware ──
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return;
        if (!config.allowedUserIds.has(userId)) {
            console.log(`🚫 Blocked message from unauthorized user: ${userId}`);
            return;
        }
        if (!rateLimitAllow(userId)) {
            console.log(`🚫 Rate limit hit for telegram user ${userId} — dropping message`);
            return;
        }
        await next();
    });

    // ── Track active tasks per chat ───────────────
    interface ActiveTask {
        controller: AbortController;
        taskId: string;
        triggerMessageId: number;
        description: string;
        startedAt: number;
    }
    const activeTasks = new Map<number, ActiveTask[]>();
    const MAX_CONCURRENT_TASKS = 3;
    let taskIdCounter = 0;

    // ── Track bot message → task mapping for reply routing ──
    const botMessageToTask = new Map<number, string>(); // bot msgId → taskId

    // ── Proactive message tracking (read receipt awareness) ──
    interface ProactiveLog {
        sentAt: number;
        topic: string;
        responded: boolean;
    }
    const proactiveMessageLog: ProactiveLog[] = [];
    const MAX_PROACTIVE_LOG = 20;

    // Mark proactive messages as responded when user sends a message within 30 min
    function checkProactiveResponse(): void {
        const now = Date.now();
        const RESPONSE_WINDOW = 30 * 60 * 1000; // 30 min
        for (const entry of proactiveMessageLog) {
            if (!entry.responded && now - entry.sentAt < RESPONSE_WINDOW) {
                entry.responded = true;
            }
        }
        // Memory leak prevention: trim to MAX_PROACTIVE_LOG, removing oldest entries
        while (proactiveMessageLog.length > MAX_PROACTIVE_LOG) {
            proactiveMessageLog.shift();
        }
    }

    // Export for heartbeat to check before generating proactive messages
    (globalThis as Record<string, unknown>).__atlasProactiveLog = proactiveMessageLog;

    // ── Message batching (debounce rapid messages) ──
    const messageBuffer = new Map<
        string,
        {
            messages: string[];
            timer: ReturnType<typeof setTimeout>;
            triggerMessageId: number;
            replyToText?: string;
            replyToAuthor?: string;
            ctx: typeof bot extends { on: (e: string, cb: (c: infer C) => void) => void } ? C : never;
        }
    >();
    const BATCH_DELAY_MS = 500; // Initial delay: 500ms (reduced from 1500ms)
    const BATCH_EXTEND_MS = 1000; // Extend by 1s if more messages arrive

    // ── Handle text messages ───────────────────
    bot.on("message:text", async (ctx) => {
        const userMessage = ctx.message.text;
        const userName = ctx.from.first_name || "User";
        const triggerMessageId = ctx.message.message_id;

        // ── Extract reply context if user swiped to reply ──
        // F10: in groups a user can reply to a non-bot message and forge an
        // "earlier message from me" prefix. Carry the replied-to author so the
        // framing reflects who actually said it.
        let replyToText: string | undefined;
        let replyToAuthor: string | undefined;
        if (ctx.message.reply_to_message && "text" in ctx.message.reply_to_message) {
            const rep = ctx.message.reply_to_message as { text?: string; from?: { id?: number; first_name?: string } };
            replyToText = rep.text;
            const botId = ctx.me?.id;
            if (rep.from?.id && botId && rep.from.id !== botId) {
                replyToAuthor = rep.from.first_name || `user ${rep.from.id}`;
            }
        }
        const chatId = ctx.chat.id;
        const bufKey = batchKey(chatId, ctx.from?.id);

        console.log(`\n💬 ${userName}: ${userMessage}`);

        // ── Latent-topic monitor matcher (Phase 3.9d) ──
        // Runs on every inbound message, before stop-signals / commands, so rules
        // fire even when the user's text is something the agent won't act on. Any
        // failure is swallowed — this must never block normal message handling.
        try {
            const { embedText } = await import("./memory/embeddings.js");
            const native = await import("../native/index.js");
            const { getMonitorStore } = await import("./proactive/monitors/store-singleton.js");
            const { globalMonitorHitBus } = await import("./proactive/monitors/monitor-hits.js");
            const nativeMod = native as unknown as {
                monitorCheck?: (
                    emb: number[],
                    channel: string,
                    sender: string,
                    nowMs: number,
                ) => Array<{ ruleId: string; score: number }>;
                monitorMarkFired?: (id: string, tsMs: number) => void;
            };
            if (typeof nativeMod.monitorCheck === "function") {
                const store = getMonitorStore();
                if (store) {
                    const emb = await embedText(userMessage, "query");
                    const embArr = Array.from(emb).map((n) => Number(n));
                    const hits = nativeMod.monitorCheck(
                        embArr,
                        "telegram",
                        String(ctx.from?.id ?? "unknown"),
                        Date.now(),
                    );
                    if (hits.length > 0) {
                        for (const h of hits) {
                            const rule = store.get(h.ruleId);
                            if (!rule) continue;
                            globalMonitorHitBus.emit({
                                ruleId: h.ruleId,
                                ruleUserPhrase: rule.userPhrase,
                                ruleTopic: rule.topic,
                                ruleUrgency: rule.urgency,
                                ruleActionDefaultMode: rule.action.defaultMode,
                                ruleSuggestedFollowup: rule.action.suggestedFollowup,
                                messageChannel: "telegram",
                                messageSender: String(ctx.from?.id ?? "unknown"),
                                messagePreview: userMessage.slice(0, 200),
                                score: h.score,
                                ts: Date.now(),
                            });
                            store.markFired(h.ruleId, Date.now());
                            if (typeof nativeMod.monitorMarkFired === "function") {
                                nativeMod.monitorMarkFired(h.ruleId, Date.now());
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.log("[TG] monitor check failed (non-fatal):", (err as Error).message);
        }

        // ── Stop/Cancel command — instant, no debounce ──
        const lower = userMessage.toLowerCase().trim();
        const STOP_SIGNALS = [
            "stop",
            "cancel",
            "/stop",
            "/cancel",
            "don't continue",
            "dont continue",
            "never mind",
            "nevermind",
            "leave it",
            "abort",
            "quit it",
            "stop it",
            "yes stop",
            "no stop",
            "please stop",
        ];
        const isStopSignal =
            STOP_SIGNALS.some((s) => lower === s || lower.startsWith(s + " ") || lower.endsWith(" " + s)) ||
            (lower.split(" ").length <= 4 && ["stop", "cancel", "abort", "quit"].some((w) => lower.includes(w)));

        if (isStopSignal) {
            // Clear any buffered messages too
            const buf = messageBuffer.get(bufKey);
            if (buf) {
                clearTimeout(buf.timer);
                messageBuffer.delete(bufKey);
            }

            const tasks = activeTasks.get(chatId) || [];

            // If replying "stop" to a specific bot message, cancel only that task
            if (replyToText && ctx.message.reply_to_message) {
                const repliedToMsgId = ctx.message.reply_to_message.message_id;
                const targetTaskId = botMessageToTask.get(repliedToMsgId);
                const targetTask = targetTaskId ? tasks.find((t) => t.taskId === targetTaskId) : null;
                if (targetTask) {
                    targetTask.controller.abort();
                    activeTasks.set(
                        chatId,
                        tasks.filter((t) => t.taskId !== targetTaskId),
                    );
                    console.log(`  🛑 Stopping specific task ${targetTask.taskId}: "${targetTask.description}"`);
                    await ctx.reply(`🛑 Stopping: ${targetTask.description}`, {
                        reply_parameters: { message_id: triggerMessageId },
                    });
                    return;
                }
            }

            // Otherwise cancel all tasks
            if (tasks.length > 0) {
                for (const task of tasks) task.controller.abort();
                activeTasks.delete(chatId);
                console.log(`  🛑 Aborting all ${tasks.length} active task(s) for chat ${chatId}`);
                await ctx.reply(`🛑 Stopping ${tasks.length} active task(s)...`);
            } else {
                await ctx.reply("No active task to stop.");
            }
            return;
        }

        // ── Proactive-subsystem commands (shut up / resume / set posture / status + monitor CRUD) ──
        {
            const { tryProactiveCommand } = await import("./proactive/chat-commands.js");
            const { parseMonitorRule } = await import("./proactive/monitors/monitor-parser.js");
            const { getMonitorStore } = await import("./proactive/monitors/store-singleton.js");
            const { embedText } = await import("./memory/embeddings.js");
            const native = await import("../native/index.js");
            const { join } = await import("node:path");
            const nativeMon = native as unknown as {
                monitorUpsertRule?: (r: unknown) => void;
                monitorDeleteRule?: (id: string) => void;
            };
            const result = await tryProactiveCommand(userMessage, {
                configPath: join(getDataDir(), "proactive-config.json"),
                monitorStore: getMonitorStore() ?? undefined,
                parseRule: async (phrase) =>
                    parseMonitorRule(phrase, {
                        llm,
                        embedText: async (t) => await embedText(t, "query"),
                    }),
                nativeMonitor:
                    typeof nativeMon.monitorUpsertRule === "function" &&
                    typeof nativeMon.monitorDeleteRule === "function"
                        ? {
                              upsertRule: (r) => nativeMon.monitorUpsertRule!(r),
                              deleteRule: (id) => nativeMon.monitorDeleteRule!(id),
                          }
                        : undefined,
            });
            if (result) {
                await ctx.reply(result.reply, { reply_parameters: { message_id: triggerMessageId } });
                return;
            }
        }

        // Check for slash commands — instant, no debounce
        if (userMessage.startsWith("/")) {
            const cmdResult = await handleCommand(userMessage);
            if (cmdResult.handled) {
                if (cmdResult.response) {
                    const cmdLower = userMessage.toLowerCase().split(/\s+/)[0];
                    // Attach inline keyboard for /start and /help
                    const replyMarkup =
                        cmdLower === "/start" || cmdLower === "/help" ? { reply_markup: buildMainMenuKeyboard() } : {};
                    try {
                        await ctx.reply(markdownToTelegramHtml(cmdResult.response), {
                            parse_mode: "HTML",
                            ...replyMarkup,
                        });
                    } catch {
                        await ctx.reply(cmdResult.response.replace(/\*\*(.+?)\*\*/g, "$1"), replyMarkup);
                    }
                }
                return;
            }
        }

        // ── Buffer message and debounce ──
        const existing = messageBuffer.get(bufKey);
        if (existing) {
            // Add to buffer and reset timer
            existing.messages.push(userMessage);
            existing.ctx = ctx as typeof existing.ctx;
            if (replyToText && !existing.replyToText) existing.replyToText = replyToText;
            if (replyToAuthor && !existing.replyToAuthor) existing.replyToAuthor = replyToAuthor;
            clearTimeout(existing.timer);
            existing.timer = setTimeout(
                () => processBuffered(chatId, triggerMessageId, undefined, undefined, bufKey),
                BATCH_EXTEND_MS,
            );
        } else {
            // Start new buffer
            messageBuffer.set(bufKey, {
                messages: [userMessage],
                timer: setTimeout(
                    () => processBuffered(chatId, triggerMessageId, undefined, undefined, bufKey),
                    BATCH_DELAY_MS,
                ),
                triggerMessageId,
                replyToText,
                replyToAuthor,
                ctx: ctx as never,
            });
        }
    });

    // ── Process buffered messages ───────────────────
    // eslint-disable-next-line @typescript-eslint/no-floating-promises, @typescript-eslint/no-explicit-any
    function processBuffered(
        chatId: number,
        triggerMessageId: number,
        directMessage?: string,
        directCtx?: any,
        bufKey?: string,
    ) {
        let combinedMessage: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ctx: any;
        let replyToText: string | undefined;
        let replyToAuthor: string | undefined;

        if (directMessage && directCtx) {
            // Called directly from callback query handler — bypass buffer
            combinedMessage = directMessage;
            ctx = directCtx;
            replyToText = undefined;
        } else {
            if (!bufKey) return;
            const buf = messageBuffer.get(bufKey);
            if (!buf) return;
            messageBuffer.delete(bufKey);

            combinedMessage = buf.messages.join("\n");
            ctx = buf.ctx as any;
            replyToText = buf.replyToText;
            replyToAuthor = buf.replyToAuthor;

            if (buf.messages.length > 1) {
                console.log(`  📦 Batched ${buf.messages.length} messages into one`);
            }
        }

        // ── Inject reply context if user swiped to reply ──
        if (replyToText) {
            const preview = replyToText.substring(0, 500);
            const prefix = replyToAuthor
                ? `[Replying to ${replyToAuthor}'s message: "${preview}"]`
                : `[Replying to your earlier message: "${preview}"]`;
            combinedMessage = `${prefix}\n\n${combinedMessage}`;
            console.log(`  ↩️ Reply context injected (${replyToAuthor || "self"}): "${preview.substring(0, 80)}..."`);
        }

        // ── Record user activity + proactive response tracking ──
        // Fire-and-forget: deliver dream results if available
        (async () => {
            try {
                const { recordUserActivity, getDreamResultsForDelivery, formatDreamResults } = await import(
                    "./proactive/dreaming.js"
                );
                recordUserActivity();

                // Mark proactive messages as responded and record engagement
                checkProactiveResponse();
                try {
                    const { recordUserEngagement } = await import("./proactive/inner-thoughts.js");
                    recordUserEngagement(true);
                } catch {
                    /* non-fatal */
                }
                try {
                    const { recordResponse } = await import("./proactive/notification-tracker.js");
                    // Find the most recent unresponded notification and mark as engaged
                    recordResponse(0, "engaged", 1);
                } catch {
                    /* non-fatal */
                }

                const dreamResults = getDreamResultsForDelivery();
                if (dreamResults && dreamResults.length > 0) {
                    const dreamMsg = formatDreamResults(dreamResults);
                    await ctx.reply(dreamMsg, { parse_mode: "Markdown" }).catch(() => {
                        ctx.reply(dreamMsg.replace(/\*\*/g, "")).catch(() => {});
                    });
                }
            } catch {
                // Dreaming module not loaded — skip
            }
        })();

        // ── Check concurrent task limit (DON'T cancel old tasks) ──
        const existingTasks = activeTasks.get(chatId) || [];
        if (existingTasks.length >= MAX_CONCURRENT_TASKS) {
            (async () => {
                await ctx.reply(`⚠️ I'm already working on ${existingTasks.length} things. Let me finish one first.`, {
                    reply_parameters: { message_id: triggerMessageId },
                });
            })();
            return;
        }

        const controller = new AbortController();
        const taskId = `task_${++taskIdCounter}`;
        const taskDescription = combinedMessage.substring(0, 80).replace(/\n/g, " ");
        const task: ActiveTask = {
            controller,
            taskId,
            triggerMessageId,
            description: taskDescription,
            startedAt: Date.now(),
        };
        existingTasks.push(task);
        activeTasks.set(chatId, existingTasks);

        // Fork history if other tasks are running concurrently
        const shouldFork = existingTasks.length > 1;
        if (shouldFork) {
            console.log(`  🔀 Forked history for concurrent task ${taskId} (${existingTasks.length} active)`);
        }

        // Fire-and-forget async processing
        (async () => {
            await ctx.replyWithChatAction("typing");
            const typingInterval = setInterval(async () => {
                try {
                    await ctx.replyWithChatAction("typing");
                } catch {
                    /* ignore */
                }
            }, 4000);

            // Track response time for awareness
            const taskStartTime = Date.now();

            try {
                setTelegramContext(bot, chatId);

                // ── Detect short acknowledgements ─────────────────────────────
                const msgLower = combinedMessage.toLowerCase().trim();
                const ACK_WORDS = [
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
                    "k",
                    "noted",
                    "sounds good",
                    "awesome",
                    "perfect",
                    "good",
                    "understood",
                    "sure",
                    "yep",
                    "yup",
                    "yeah",
                    "yes",
                ];
                const isAck =
                    ACK_WORDS.some(
                        (w) => msgLower === w || msgLower === w + "!" || msgLower === w + "." || msgLower === "oh " + w,
                    ) && combinedMessage.trim().split(/\s+/).length <= 5;

                let agentMessage = combinedMessage;
                let modelHint: "simple" | "complex" | undefined;
                if (isAck) {
                    console.log(`  💬 Short ack detected — injecting context note to prevent task restart`);
                    agentMessage =
                        combinedMessage +
                        "\n\n[CONTEXT NOTE: The user is acknowledging the previous response. The task is done. Just reply conversationally — do NOT use tools or restart any previous task.]";
                    modelHint = "simple";
                } else if (classifyQuery(combinedMessage) === "llm_only") {
                    // Fast-path: classifier says this is a greeting/simple message — skip LLM classification
                    console.log(`  ⚡ Fast-path: classifier → llm_only, skipping classifyAndAck`);
                    modelHint = "simple";
                } else {
                    // Use LLM to intelligently classify + optionally acknowledge
                    const { ack, complexity } = await classifyAndAck(llm, combinedMessage);
                    modelHint = complexity;
                    if (ack) {
                        console.log(`  💬 LLM classified as task — ack: "${ack}"`);
                        await ctx.reply(ack);
                    }
                    console.log(`  🧠 Model routing: ${complexity}`);
                }
                // ─────────────────────────────────────────────────────────────

                // ── Live-status + varied thinking indicators ──────────────────
                // One editable message that cycles between thinking phrases and
                // tool milestone updates. Deleted before the real answer arrives.
                let statusMessageId: number | null = null;
                let lastStatusText = "";
                let statusTimeout: ReturnType<typeof setTimeout> | null = null;
                let pendingStatus: string | null = null;
                let statusCleared = false; // ← Race condition guard
                const STATUS_DELAY_MS = 6000;
                const statusStartTime = Date.now();
                let timeoutWarningShown = false;

                // Rotate thinking phrases every 5-8s while LLM is generating
                // Uses alive-ux for varied, natural phrases
                let thinkingTimer: ReturnType<typeof setInterval> | null = null;
                const startThinkingRotation = () => {
                    if (thinkingTimer) return;
                    thinkingTimer = setInterval(
                        async () => {
                            if (controller.signal.aborted || statusCleared) return;

                            const elapsed = Date.now() - statusStartTime;

                            // After 45s without tool progress, show timeout warning
                            if (elapsed > 45000 && !timeoutWarningShown) {
                                timeoutWarningShown = true;
                                const timeoutMsg = getWaitPhrase(elapsed);
                                if (statusMessageId) {
                                    try {
                                        await bot.api.editMessageText(chatId, statusMessageId, `⏳ ${timeoutMsg}`);
                                        lastStatusText = timeoutMsg;
                                    } catch {
                                        /* */
                                    }
                                }
                                return;
                            }

                            // Normal rotation — use alive-ux for fresh phrases
                            const phrase = `💭 ${getThinkingPhrase(modelHint === "simple" ? "simple" : modelHint === "complex" ? "complex" : "default")}`;

                            if (!statusMessageId) {
                                pendingStatus = phrase;
                            } else if (phrase !== lastStatusText) {
                                try {
                                    await bot.api.editMessageText(chatId, statusMessageId, phrase);
                                    lastStatusText = phrase;
                                } catch {
                                    /* message may have been deleted */
                                }
                            }
                        },
                        5000 + Math.random() * 3000,
                    ); // 5-8s jitter for naturalness
                };

                const progressCallback = async (msg: string) => {
                    // ── Human-in-the-loop interrupt handling ──
                    // Detect approval requests and send as inline keyboard messages
                    const interruptMatch = msg.match(/\[id:([a-f0-9]+)\]/);
                    if (interruptMatch && msg.includes("Approval Required")) {
                        const interruptId = interruptMatch[1];
                        // Parse options from the message (format: "Options: A | B")
                        const optionsMatch = msg.match(/Options:\s*(.+)/);
                        const options = optionsMatch
                            ? optionsMatch[1].split("|").map((o) => o.trim())
                            : ["Approve", "Skip"];

                        // Strip the metadata from the display message
                        const displayMsg = msg
                            .replace(/\[id:[a-f0-9]+\]/, "")
                            .replace(/Options:\s*.+/, "")
                            .replace(/\*\*/g, "")
                            .trim();

                        const keyboard = new InlineKeyboard();
                        for (const option of options) {
                            keyboard.text(option, `interrupt:${interruptId}:${option}`);
                        }

                        try {
                            await bot.api.sendMessage(chatId, `🛑 ${displayMsg}`, {
                                reply_markup: keyboard,
                            });
                        } catch (err) {
                            console.warn("[TELEGRAM] Failed to send interrupt keyboard:", (err as Error).message);
                        }
                        return;
                    }

                    // ── Long-task progress: send inline keyboard for check/cancel ──
                    const longTaskMatch = msg.match(/\[LONG-TASK:([^\]]+)\]\s*(.*)/);
                    if (longTaskMatch) {
                        const ltTaskId = longTaskMatch[1];
                        const ltMessage = longTaskMatch[2] || "Long task started";
                        try {
                            await bot.api.sendMessage(chatId, `📋 ${ltMessage}`, {
                                reply_markup: buildTaskKeyboard(ltTaskId),
                            });
                        } catch (err) {
                            console.warn("[TELEGRAM] Failed to send task keyboard:", (err as Error).message);
                        }
                        return;
                    }

                    // ── Live Thinking Display ──
                    // Replace the fake rotating phrases with real model reasoning
                    if (msg.startsWith("[THINKING] ")) {
                        const thinkingText = msg.slice(11).trim();
                        if (!thinkingText || statusCleared) return;

                        // Stop the fake rotation — real thinking has arrived
                        if (thinkingTimer) {
                            clearInterval(thinkingTimer);
                            thinkingTimer = null;
                        }

                        // Truncate to ~800 chars for Telegram limits
                        const truncated =
                            thinkingText.length > 800 ? thinkingText.substring(0, 800) + "..." : thinkingText;
                        const escaped = truncated.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                        const thinkingHtml = `💭 <blockquote expandable><i>${escaped}</i></blockquote>`;

                        try {
                            if (statusMessageId) {
                                await bot.api.editMessageText(chatId, statusMessageId, thinkingHtml, {
                                    parse_mode: "HTML",
                                });
                                lastStatusText = thinkingHtml;
                            } else {
                                const sent = await ctx.reply(thinkingHtml, { parse_mode: "HTML" });
                                statusMessageId = sent.message_id;
                                lastStatusText = thinkingHtml;
                            }
                        } catch {
                            /* message send may fail */
                        }
                        return;
                    }

                    console.log(`  📊 [progress] ${msg}`);

                    const humanized = humanizeProgress(msg);
                    if (!humanized || statusCleared) return;

                    if (!statusMessageId) {
                        pendingStatus = humanized;
                        if (!statusTimeout) {
                            statusTimeout = setTimeout(async () => {
                                if (pendingStatus && !controller.signal.aborted && !statusCleared) {
                                    try {
                                        const sent = await ctx.reply(pendingStatus);
                                        // Check AGAIN after the async reply — cleanup may have run while we were awaiting
                                        if (statusCleared) {
                                            try {
                                                await bot.api.deleteMessage(chatId, sent.message_id);
                                            } catch {
                                                /* */
                                            }
                                        } else {
                                            statusMessageId = sent.message_id;
                                            lastStatusText = pendingStatus!;
                                            startThinkingRotation();
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                }
                                statusTimeout = null;
                            }, STATUS_DELAY_MS);
                        }
                    } else {
                        // Tool milestone overrides thinking phrase
                        if (humanized !== lastStatusText) {
                            try {
                                await bot.api.editMessageText(chatId, statusMessageId, humanized);
                                lastStatusText = humanized;
                            } catch {
                                /* message may have been deleted */
                            }
                        }
                    }
                };

                const clearStatusMessage = async () => {
                    statusCleared = true; // Prevent any in-flight async from setting statusMessageId
                    if (statusTimeout) {
                        clearTimeout(statusTimeout);
                        statusTimeout = null;
                    }
                    if (thinkingTimer) {
                        clearInterval(thinkingTimer);
                        thinkingTimer = null;
                    }
                    if (statusMessageId) {
                        try {
                            await bot.api.deleteMessage(chatId, statusMessageId);
                        } catch {
                            /* */
                        }
                        statusMessageId = null;
                    }
                };

                // Also fire a delayed thinking indicator even without tool progress
                // (covers pure-LLM responses that don't trigger any tool milestones)
                const thinkingFallback = setTimeout(async () => {
                    if (!statusMessageId && !controller.signal.aborted && !statusCleared) {
                        const phrase = `💭 ${getThinkingPhrase()}`;
                        try {
                            const sent = await ctx.reply(phrase);
                            // Check AGAIN after async reply
                            if (statusCleared) {
                                try {
                                    await bot.api.deleteMessage(chatId, sent.message_id);
                                } catch {
                                    /* */
                                }
                            } else {
                                statusMessageId = sent.message_id;
                                lastStatusText = phrase;
                                startThinkingRotation();
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                }, STATUS_DELAY_MS);

                const historyFork = shouldFork ? [...getConversationHistory()] : undefined;

                // Wire progress so sub-agent/research updates flow through our live-status
                setSwarmProgress(progressCallback);
                setDeepResearchProgress(progressCallback);
                setLongTaskProgress(progressCallback);
                const senderIsOwner = !!ctx.from?.id && telegramOwners.has(ctx.from.id);
                const response = await runAgent(
                    llm,
                    agentMessage,
                    progressCallback,
                    undefined,
                    controller.signal,
                    historyFork,
                    modelHint,
                    undefined,
                    {
                        channel: "telegram",
                        userId: String(ctx.from?.id || ""),
                        userName: ctx.from?.first_name,
                        isOwner: senderIsOwner,
                        isPrivate: ctx.chat?.type === "private",
                    },
                );
                clearSwarmProgress();
                clearDeepResearchProgress();
                clearLongTaskProgress();

                clearTimeout(thinkingFallback);
                if (controller.signal.aborted) {
                    await clearStatusMessage();
                    return;
                }

                const taskDurationMs = Date.now() - taskStartTime;
                console.log(`🤖 Bhai: ${response.text.substring(0, 200)}... (${(taskDurationMs / 1000).toFixed(1)}s)`);
                if (response.toolCalls > 0) {
                    console.log(`   (${response.toolCalls} tool call(s))`);
                }

                // ── Response-time awareness ──────────────────────────────────
                // If the response took a while, acknowledge it naturally using alive-ux
                let responseText = response.text;
                const timeAck = getResponseTimeAck(taskDurationMs, response.toolCalls > 0);
                if (timeAck) {
                    const lowerResp = responseText.toLowerCase();
                    if (
                        !lowerResp.startsWith("sorry") &&
                        !lowerResp.startsWith("apolog") &&
                        !lowerResp.startsWith("that took") &&
                        !lowerResp.startsWith("took")
                    ) {
                        responseText = timeAck + responseText;
                    }
                }

                // Split into human-like multiple messages at paragraph breaks
                await clearStatusMessage();
                const bubbles = splitIntoBubbles(responseText);

                // Streamed edit-in-place: for long responses, send first part then edit to append more
                const totalLength = bubbles.reduce((s, b) => s + b.length, 0);
                const useStreaming = totalLength > 300 && bubbles.length > 1;

                if (useStreaming) {
                    // Send first bubble immediately
                    const replyOpts = shouldFork ? { reply_parameters: { message_id: triggerMessageId } } : {};
                    let currentText = bubbles[0];
                    let sentMsgId: number | undefined;
                    try {
                        const sent = await ctx.reply(markdownToTelegramHtml(sanitizeReply(currentText)), {
                            parse_mode: "HTML",
                            ...replyOpts,
                        });
                        sentMsgId = sent?.message_id;
                        if (sentMsgId) botMessageToTask.set(sentMsgId, taskId);
                    } catch {
                        const sent = await ctx.reply(currentText.replace(/\*\*(.+?)\*\*/g, "$1"), replyOpts);
                        sentMsgId = sent?.message_id;
                    }

                    // Append remaining bubbles via edit-in-place
                    for (let i = 1; i < bubbles.length; i++) {
                        const delay = Math.min(600, Math.max(200, bubbles[i].length * 1.5));
                        await new Promise((r) => setTimeout(r, delay));
                        currentText += "\n\n" + bubbles[i];

                        // Check if we'll exceed Telegram's 4096 char limit
                        const htmlText = markdownToTelegramHtml(sanitizeReply(currentText));
                        if (htmlText.length > 4000 || !sentMsgId) {
                            // Start a new message for remaining content
                            try {
                                await ctx.replyWithChatAction("typing");
                                const remaining = bubbles.slice(i).join("\n\n");
                                const remainChunks = splitMessage(remaining, 4096);
                                for (const chunk of remainChunks) {
                                    try {
                                        const sent = await ctx.reply(markdownToTelegramHtml(sanitizeReply(chunk)), {
                                            parse_mode: "HTML",
                                        });
                                        if (sent?.message_id) botMessageToTask.set(sent.message_id, taskId);
                                    } catch {
                                        await ctx.reply(chunk);
                                    }
                                }
                            } catch {
                                /* ignore */
                            }
                            break;
                        }

                        // Edit the existing message to show appended content
                        try {
                            await ctx.api.editMessageText(ctx.chat.id, sentMsgId!, htmlText, { parse_mode: "HTML" });
                        } catch {
                            // Edit failed — fall back to sending new message
                            try {
                                const sent = await ctx.reply(markdownToTelegramHtml(sanitizeReply(bubbles[i])), {
                                    parse_mode: "HTML",
                                });
                                if (sent?.message_id) {
                                    sentMsgId = sent.message_id;
                                    botMessageToTask.set(sentMsgId!, taskId);
                                }
                                currentText = bubbles[i]; // Reset for future edits
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                } else {
                    // Short response: send all bubbles normally
                    for (let i = 0; i < bubbles.length; i++) {
                        const bubble = bubbles[i];
                        if (i > 0) {
                            await ctx.replyWithChatAction("typing");
                            const delay = Math.min(600, Math.max(300, bubble.length * 2));
                            await new Promise((r) => setTimeout(r, delay));
                        }
                        const chunks = splitMessage(bubble, 4096);
                        for (const chunk of chunks) {
                            const replyOpts = shouldFork ? { reply_parameters: { message_id: triggerMessageId } } : {};
                            try {
                                const sent = await ctx.reply(markdownToTelegramHtml(sanitizeReply(chunk)), {
                                    parse_mode: "HTML",
                                    ...replyOpts,
                                });
                                if (sent?.message_id) botMessageToTask.set(sent.message_id, taskId);
                            } catch {
                                const plain = chunk
                                    .replace(/\*\*(.+?)\*\*/g, "$1")
                                    .replace(/\*(.+?)\*/g, "$1")
                                    .replace(/__(.+?)__/g, "$1")
                                    .replace(/`([^`]+)`/g, "$1")
                                    .replace(/```[\s\S]*?```/g, (m: string) => m.replace(/```\w*\n?/g, "").trim());
                                const sent = await ctx.reply(plain, replyOpts);
                                if (sent?.message_id) botMessageToTask.set(sent.message_id, taskId);
                            }
                        }
                    }
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    console.error("❌ Agent error:", err);
                    const errorType = categorizeError(err as Error);
                    const rawMsg = getErrorMessage(errorType);
                    // Scrub internal paths from error messages before sending to user
                    const errorMsg = scrubFilePaths(rawMsg);
                    await ctx.reply(errorMsg);
                }
            } finally {
                clearInterval(typingInterval);
                // Remove this specific task from the active list
                const tasks = activeTasks.get(chatId) || [];
                activeTasks.set(
                    chatId,
                    tasks.filter((t) => t.taskId !== taskId),
                );
                if ((activeTasks.get(chatId) || []).length === 0) activeTasks.delete(chatId);

                // Clean up botMessageToTask entries for this completed task (prevent memory leak)
                for (const [msgId, tid] of botMessageToTask) {
                    if (tid === taskId) botMessageToTask.delete(msgId);
                }
                // Hard cap: if map somehow grows too large, trim oldest entries
                if (botMessageToTask.size > 500) {
                    const keys = [...botMessageToTask.keys()];
                    for (let i = 0; i < keys.length - 200; i++) botMessageToTask.delete(keys[i]);
                }
            }
        })();
    }

    // ── Handle photo messages ──────────────────
    bot.on("message:photo", async (ctx) => {
        await handleMediaMessage(ctx, bot, config, llm, "image", messageBuffer as never);
    });

    // ── Handle video messages ──────────────────
    bot.on("message:video", async (ctx) => {
        await handleMediaMessage(ctx, bot, config, llm, "video", messageBuffer as never);
    });

    // ── Handle document messages (images/videos sent as files) ──
    bot.on("message:document", async (ctx) => {
        const mime = ctx.message.document?.mime_type || "";
        if (mime.startsWith("image/") || mime.startsWith("video/")) {
            await handleMediaMessage(
                ctx,
                bot,
                config,
                llm,
                mime.startsWith("image/") ? "image" : "video",
                messageBuffer as never,
            );
        }
    });

    // ── Handle voice messages (voice notes) ───────
    bot.on("message:voice", async (ctx) => {
        await handleAudioMessage(ctx, bot, config, llm);
    });

    // ── Handle audio messages (music/audio files) ─
    bot.on("message:audio", async (ctx) => {
        await handleAudioMessage(ctx, bot, config, llm);
    });

    // ── Handle all inline keyboard callback queries ──
    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        const chatId = ctx.chat?.id;

        // ── Inbox chat-fallback callbacks: inbox:<action>:<id>[:<minutes>] (Phase 4.3) ──
        if (data.startsWith("inbox:")) {
            try {
                const { handleTelegramInboxCallback } = await import("./proactive/inbox/chat-fallback.js");
                // Pass chatId so chat-fallback can record routing for the
                // execution-result follow-up (Phase 6.2).
                const ack = await handleTelegramInboxCallback(data, chatId);
                await ctx.answerCallbackQuery({ text: ack });
            } catch (err) {
                console.log("[TG] inbox callback failed (non-fatal):", (err as Error).message);
                await ctx.answerCallbackQuery({ text: "error" });
            }
            return;
        }

        // ── Human-in-the-loop interrupts: interrupt:<id>:<answer> ──
        if (data.startsWith("interrupt:")) {
            const parts = data.split(":");
            if (parts.length < 3) return;
            const interruptId = parts[1];
            const answer = parts.slice(2).join(":"); // Handle colons in answer

            const resolved = resolveInterrupt(interruptId, answer);
            if (resolved) {
                await ctx.answerCallbackQuery({ text: `Selected: ${answer}` });
                try {
                    const originalText =
                        ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
                            ? (ctx.callbackQuery.message as { text?: string }).text || ""
                            : "";
                    await ctx.editMessageText(`${originalText}\n\n✅ You chose: ${answer}`);
                } catch {
                    /* message may be too old to edit */
                }
            } else {
                await ctx.answerCallbackQuery({ text: "This approval has already expired." });
            }
            return;
        }

        // ── Quick action menu commands: cmd:<action> ──
        if (data.startsWith("cmd:")) {
            const command = data.slice(4);
            await ctx.answerCallbackQuery();

            // For /status, use the command handler directly
            if (command === "status") {
                const cmdResult = await handleCommand("/status");
                if (cmdResult.response) {
                    try {
                        await ctx.reply(markdownToTelegramHtml(cmdResult.response), { parse_mode: "HTML" });
                    } catch {
                        await ctx.reply(cmdResult.response.replace(/\*\*(.+?)\*\*/g, "$1"));
                    }
                }
                return;
            }

            // For tasks, check for active long tasks first and show summary
            if (command === "tasks") {
                const longTasks = listActiveLongTasks();
                if (longTasks.length > 0) {
                    const taskSummaries = longTasks.map((t) => formatTaskStatusCard(t)).join("\n\n———\n\n");
                    try {
                        await ctx.reply(markdownToTelegramHtml(taskSummaries), { parse_mode: "HTML" });
                    } catch {
                        await ctx.reply(taskSummaries.replace(/\*\*(.+?)\*\*/g, "$1"));
                    }
                    // Also add inline keyboards for running tasks
                    for (const t of longTasks) {
                        if (t.status === "running") {
                            try {
                                await ctx.reply(`Task: ${t.description.substring(0, 60)}`, {
                                    reply_markup: buildTaskKeyboard(t.id),
                                });
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                } else {
                    await ctx.reply(
                        "No active long tasks right now. Send me a complex task and I'll track it for you.",
                    );
                }
                return;
            }

            // For research, browse, memory — give the user a prompt to fill in
            const actionPrompts: Record<string, string> = {
                research: "🔬 What topic should I research? Send me a question or subject and I'll do a deep dive.",
                browse: "🌐 Where should I browse? Send me a URL or search query.",
                memory: "🧠 Retrieving your memory snapshot...",
            };

            const prompt = actionPrompts[command];
            if (!prompt) {
                await ctx.reply("Unknown action.");
                return;
            }

            // Memory runs directly through the agent
            if (command === "memory" && chatId) {
                // Inject memory request as a simulated user message into the processing pipeline
                const triggerMsgId = ctx.callbackQuery.message?.message_id || 0;
                processBuffered(
                    chatId,
                    triggerMsgId,
                    "Give me a snapshot of what you remember about me — core memories, my preferences, relationship notes, and anything notable from our recent conversations.",
                    ctx,
                );
                return;
            }

            await ctx.reply(prompt);
            return;
        }

        // ── Task progress check: task:check:<taskId> ──
        if (data.startsWith("task:check:")) {
            const ltTaskId = data.slice(11);
            await ctx.answerCallbackQuery();

            const task = getLongTaskStatus(ltTaskId);
            if (!task) {
                await ctx.reply("Task not found or has been cleaned up.");
                return;
            }

            const statusCard = formatTaskStatusCard(task);
            try {
                await ctx.reply(markdownToTelegramHtml(statusCard), { parse_mode: "HTML" });
            } catch {
                await ctx.reply(statusCard.replace(/\*\*(.+?)\*\*/g, "$1"));
            }

            // If still running, re-send the keyboard for further checks
            if (task.status === "running") {
                try {
                    await ctx.reply("Task is still running.", {
                        reply_markup: buildTaskKeyboard(ltTaskId),
                    });
                } catch {
                    /* ignore */
                }
            } else if (task.status === "completed") {
                const completionCard = formatTaskCompletionCard(task);
                try {
                    await ctx.reply(markdownToTelegramHtml(completionCard), { parse_mode: "HTML" });
                } catch {
                    await ctx.reply(completionCard.replace(/\*\*(.+?)\*\*/g, "$1"));
                }
            }
            return;
        }

        // ── Task cancel: task:cancel:<taskId> ──
        if (data.startsWith("task:cancel:")) {
            const ltTaskId = data.slice(12);

            const cancelled = cancelLongTask(ltTaskId);
            if (cancelled) {
                await ctx.answerCallbackQuery({ text: "Task cancelled" });
                try {
                    const originalText =
                        ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
                            ? (ctx.callbackQuery.message as { text?: string }).text || ""
                            : "";
                    await ctx.editMessageText(`${originalText}\n\n🛑 Task cancelled by user.`);
                } catch {
                    /* message may be too old to edit */
                }
            } else {
                await ctx.answerCallbackQuery({ text: "Task not found or already finished." });
            }
            return;
        }

        // ── Unknown callback — acknowledge to stop Telegram loading indicator ──
        await ctx.answerCallbackQuery({ text: "Unknown action" });
    });

    return bot;
}

// ── Media Message Handler ─────────────────────

async function handleMediaMessage(
    ctx: {
        message: {
            caption?: string;
            photo?: Array<{ file_id: string }>;
            video?: { file_id: string; mime_type?: string };
            document?: { file_id: string; mime_type?: string };
        };
        from: { id?: number; first_name?: string };
        chat: { id: number };
        reply: Function;
        replyWithChatAction: Function;
    },
    bot: Bot,
    config: Config,
    llm: LLMClient,
    mediaType: "image" | "video",
    messageBuffer?: Map<string, { messages: string[]; timer: ReturnType<typeof setTimeout>; ctx: never }>,
) {
    const userName = ctx.from.first_name || "User";
    let caption = ctx.message.caption || (mediaType === "image" ? "What's in this image?" : "What's in this video?");

    console.log(`\n📎 ${userName} sent a ${mediaType}${caption ? `: ${caption}` : ""}`);

    // Wait briefly so follow-up text messages (like 👍 or a comment) can arrive
    await new Promise((r) => setTimeout(r, 1500));

    // Absorb any buffered text messages sent right after the image
    if (messageBuffer) {
        const key = batchKey(ctx.chat.id, ctx.from?.id);
        const buf = messageBuffer.get(key);
        if (buf && buf.messages.length > 0) {
            const extra = buf.messages.join("\n");
            caption += "\n" + extra;
            console.log(
                `  📦 Absorbed ${buf.messages.length} follow-up text(s) into media context: "${extra.substring(0, 60)}"`,
            );
            clearTimeout(buf.timer);
            messageBuffer.delete(key);
        }
    }

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(async () => {
        try {
            await ctx.replyWithChatAction("typing");
        } catch {
            /* ignore */
        }
    }, 4000);

    try {
        // Get file ID
        let fileId: string;
        let mimeType: string;
        if (mediaType === "image" && ctx.message.photo) {
            // Photos come as array of sizes — take the largest
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            mimeType = "image/jpeg";
        } else if (mediaType === "video" && ctx.message.video) {
            fileId = ctx.message.video.file_id;
            mimeType = ctx.message.video.mime_type || "video/mp4";
        } else if (ctx.message.document) {
            fileId = ctx.message.document.file_id;
            mimeType = ctx.message.document.mime_type || (mediaType === "image" ? "image/jpeg" : "video/mp4");
        } else {
            await ctx.reply("Couldn't process this media.");
            return;
        }

        // Download file from Telegram (with retry + timeout for flaky networks).
        // Reject anything bigger than MAX_MEDIA_BYTES at the Telegram metadata
        // step — without this, an in-memory `arrayBuffer()` of a 1GB document
        // OOMs the bot process, and Telegram does deliver up to ~2GB to bots
        // in some configurations.
        const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB
        const file = await bot.api.getFile(fileId);
        if (typeof file.file_size === "number" && file.file_size > MAX_MEDIA_BYTES) {
            await ctx.reply(
                `That file is too large to process (${Math.round(file.file_size / 1024 / 1024)} MB). Limit is ${MAX_MEDIA_BYTES / 1024 / 1024} MB.`,
            );
            return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

        let buffer: Buffer | null = null;
        const MAX_RETRIES = 3;
        const FETCH_TIMEOUT_MS = 30_000; // 30s per attempt
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(fileUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                // Defence in depth: cap the body even if Telegram reported a small size.
                const contentLengthHeader = response.headers.get("content-length");
                if (contentLengthHeader && Number(contentLengthHeader) > MAX_MEDIA_BYTES) {
                    throw new Error(`Media body too large: ${contentLengthHeader} bytes`);
                }
                buffer = Buffer.from(await response.arrayBuffer());
                if (buffer.length > MAX_MEDIA_BYTES) throw new Error(`Media body too large: ${buffer.length} bytes`);
                break; // success
            } catch (fetchErr) {
                console.warn(
                    `  ⚠️ Media download attempt ${attempt}/${MAX_RETRIES} failed:`,
                    (fetchErr as Error).message,
                );
                if (attempt === MAX_RETRIES) throw fetchErr;
                await new Promise((r) => setTimeout(r, 2000 * attempt)); // backoff: 2s, 4s
            }
        }
        const downloadedBuffer = buffer!; // guaranteed non-null: loop either sets buffer or throws
        const base64 = downloadedBuffer.toString("base64");

        console.log(`  📥 Downloaded ${mediaType}: ${Math.round(downloadedBuffer.length / 1024)}KB`);

        // Save to temporary file so DaVinci/Filmora can use it if requested.
        // Use crypto.randomUUID() so the filename can't be predicted by an
        // attacker who can also write to the same tmpdir (closes a race
        // where a malicious side-process plants a file at a known name).
        // Safe extension allowlist — never trust attacker-supplied MIME for
        // the on-disk extension; we cap to mp3/wav/ogg/m4a/jpg/png/mp4.
        const mediaDir = join(tmpdir(), "atlas_media");
        await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
        const safeExt = (() => {
            const claimed = (mimeType.split("/")[1] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            const allowed = new Set([
                "mp3",
                "wav",
                "ogg",
                "m4a",
                "aac",
                "jpg",
                "jpeg",
                "png",
                "gif",
                "webp",
                "mp4",
                "mov",
                "webm",
            ]);
            if (allowed.has(claimed)) return claimed;
            return mediaType === "image" ? "jpg" : "mp4";
        })();
        const { randomUUID } = await import("node:crypto");
        const tmpFilePath = join(mediaDir, `telegram_${randomUUID()}.${safeExt}`);
        await fs.writeFile(tmpFilePath, downloadedBuffer, { mode: 0o600 });
        console.log(`  💾 Saved media to atlas_media/...`);

        // Wrap attacker-controlled caption in delimiters and strip framing tokens.
        // The tmp file path is ATLAS-internal hint, separately marked.
        caption = `<channel_message_content>\n${sanitizeIncomingChannelText(caption)}\n</channel_message_content>\n\n[ATLAS-INTERNAL — not from user: This ${mediaType} is saved at ${tmpFilePath}. Use this absolute path for DaVinci Resolve or Filmora edits.]`;

        // Build media attachment
        const media: MediaAttachment[] = [{ type: mediaType, base64, mimeType }];

        setTelegramContext(bot, ctx.chat.id);

        // ── Send one natural acknowledgement before work starts ──
        const { ack: mediaAck } = await classifyAndAck(llm, caption);
        if (mediaAck) await ctx.reply(mediaAck);

        // Progress is silent on Telegram — only logged to console.
        const progressCallback = async (msg: string) => {
            console.log(`  📊 [progress] ${msg}`);
        };

        const senderIsOwner = !!ctx.from?.id && isPlatformOwner("telegram", ctx.from.id, config);
        const result = await runAgent(
            llm,
            caption,
            progressCallback,
            media,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                channel: "telegram",
                userId: String(ctx.chat.id),
                userName: ctx.from?.first_name,
                isOwner: senderIsOwner,
                isPrivate: (ctx.chat as { type?: string })?.type === "private",
            },
        );

        console.log(`🤖 Bhai: ${result.text.substring(0, 200)}...`);

        // If the agent decided no reply is needed, stay silent
        if (result.text.trim() === "[NO_REPLY]") {
            console.log("  🤫 No reply needed — staying silent");
            return;
        }

        const bubbles = splitIntoBubbles(result.text);
        for (let i = 0; i < bubbles.length; i++) {
            const bubble = bubbles[i];
            if (i > 0) {
                await ctx.replyWithChatAction("typing");
                const delay = Math.min(600, Math.max(300, bubble.length * 2));
                await new Promise((r) => setTimeout(r, delay));
            }
            const chunks = splitMessage(bubble, 4096);
            for (const chunk of chunks) {
                try {
                    await ctx.reply(markdownToTelegramHtml(sanitizeReply(chunk)), { parse_mode: "HTML" });
                } catch {
                    const plain = chunk
                        .replace(/\*\*(.+?)\*\*/g, "$1")
                        .replace(/\*(.+?)\*/g, "$1")
                        .replace(/__(.+?)__/g, "$1")
                        .replace(/`([^`]+)`/g, "$1")
                        .replace(/```[\s\S]*?```/g, (m: string) => m.replace(/```\w*\n?/g, "").trim());
                    await ctx.reply(plain);
                }
            }
        }
    } catch (err) {
        console.error("❌ Media processing error:", err);
        const errorType = categorizeError(err as Error);
        await ctx.reply(scrubFilePaths(getErrorMessage(errorType)));
    } finally {
        clearInterval(typingInterval);
    }
}

// ── Audio Message Handler (Voice Notes / Audio Files) ─

async function handleAudioMessage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    bot: Bot,
    config: Config,
    llm: LLMClient,
) {
    const userName = ctx.from?.first_name || "User";
    console.log(`\n🎤 ${userName} sent a voice/audio message`);

    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(async () => {
        try {
            await ctx.replyWithChatAction("typing");
        } catch {
            /* ignore */
        }
    }, 4000);

    try {
        // Get file ID from voice or audio message
        const voice = ctx.message?.voice;
        const audio = ctx.message?.audio;
        const fileId = voice?.file_id || audio?.file_id;
        if (!fileId) {
            await ctx.reply("Couldn't process this audio message.");
            return;
        }

        const duration = voice?.duration || audio?.duration || 0;
        const mimeType = voice?.mime_type || audio?.mime_type || "audio/ogg";
        const caption = ctx.message?.caption || "";

        // Download audio from Telegram. Mirror the 25 MB cap from the
        // image/video path: a single voice/audio note can otherwise be up
        // to ~50 MB for bots, ~2 GB for documents, and arrayBuffer()
        // would OOM the bot process before we ever transcribe.
        const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
        const file = await bot.api.getFile(fileId);
        if (typeof file.file_size === "number" && file.file_size > MAX_AUDIO_BYTES) {
            await ctx.reply(
                `That audio file is too large to process (${Math.round(file.file_size / 1024 / 1024)} MB). Limit is ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`,
            );
            return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

        let buffer: Buffer | null = null;
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const contentLengthHeader = response.headers.get("content-length");
                if (contentLengthHeader && Number(contentLengthHeader) > MAX_AUDIO_BYTES) {
                    throw new Error(`Audio body too large: ${contentLengthHeader} bytes`);
                }
                buffer = Buffer.from(await response.arrayBuffer());
                if (buffer.length > MAX_AUDIO_BYTES) throw new Error(`Audio body too large: ${buffer.length} bytes`);
                break;
            } catch (fetchErr) {
                console.warn(
                    `  ⚠️ Audio download attempt ${attempt}/${MAX_RETRIES} failed:`,
                    (fetchErr as Error).message,
                );
                if (attempt === MAX_RETRIES) throw fetchErr;
                await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
        }
        const audioBuffer = buffer!;
        const base64Audio = audioBuffer.toString("base64");
        console.log(`  📥 Downloaded audio: ${Math.round(audioBuffer.length / 1024)}KB, ${duration}s, ${mimeType}`);

        // ── Stage 1: Whisper transcription (accurate STT) ──
        let transcript = "";
        let sttError = "";
        try {
            const { transcribeBuffer } = await import("./voice/transcribe.js");
            transcript = await transcribeBuffer(audioBuffer, mimeType.includes("wav") ? "audio.wav" : "audio.ogg");
            if (transcript?.trim()) {
                console.log(`  📝 Whisper transcription: "${transcript.trim()}"`);
            }
        } catch (err) {
            sttError = (err as Error).message;
            console.warn("  ⚠️ Whisper transcription failed:", sttError);
        }

        let enrichedPrompt: string;
        if (transcript?.trim()) {
            // User spoke words — send transcription directly (no Gemini hallucination)
            enrichedPrompt = transcript.trim();
            if (caption) enrichedPrompt += `\n\n(caption: "${caption}")`;
        } else {
            // No words. The model can't hear audio (the proxy drops it), so it
            // must not guess songs or sounds: say so honestly.
            enrichedPrompt = `[AUDIO MESSAGE FROM USER — ${sttError ? `it couldn't be transcribed (${sttError})` : "no speech was detected"}.]
${caption ? `User caption: "${caption}"\n` : ""}
You can't listen to audio, so don't guess what's in it (no song names, no sounds). Tell the user briefly and ask them to type what they need.`;
        }

        setTelegramContext(bot, ctx.chat.id);

        const progressCallback = async (msg: string) => {
            console.log(`  📊 [progress] ${msg}`);
        };

        const senderIsOwner = !!ctx.from?.id && isPlatformOwner("telegram", ctx.from.id as number, config);
        const result = await runAgent(
            llm,
            enrichedPrompt,
            progressCallback,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                channel: "telegram",
                userId: String(ctx.from?.id || ""),
                userName: ctx.from?.first_name,
                isOwner: senderIsOwner,
                isPrivate: ctx.chat?.type === "private",
            },
        );

        console.log(`🤖 Bhai: ${result.text.substring(0, 200)}...`);

        if (result.text.trim() === "[NO_REPLY]") {
            console.log("  🤫 No reply needed — staying silent");
            return;
        }

        // Send response
        const bubbles = splitIntoBubbles(result.text);
        for (let i = 0; i < bubbles.length; i++) {
            const bubble = bubbles[i];
            if (i > 0) {
                await ctx.replyWithChatAction("typing");
                const delay = Math.min(600, Math.max(300, bubble.length * 2));
                await new Promise((r) => setTimeout(r, delay));
            }
            const chunks = splitMessage(bubble, 4096);
            for (const chunk of chunks) {
                try {
                    await ctx.reply(markdownToTelegramHtml(sanitizeReply(chunk)), { parse_mode: "HTML" });
                } catch {
                    const plain = chunk
                        .replace(/\*\*(.+?)\*\*/g, "$1")
                        .replace(/\*(.+?)\*/g, "$1")
                        .replace(/__(.+?)__/g, "$1")
                        .replace(/`([^`]+)`/g, "$1")
                        .replace(/```[\s\S]*?```/g, (m: string) => m.replace(/```\w*\n?/g, "").trim());
                    await ctx.reply(plain);
                }
            }
        }
    } catch (err) {
        console.error("❌ Audio processing error:", err);
        const errorType = categorizeError(err as Error);
        await ctx.reply(scrubFilePaths(getErrorMessage(errorType)));
    } finally {
        clearInterval(typingInterval);
    }
}

// ── Helpers ───────────────────────────────────

/**
 * Uses a fast LLM call to intelligently:
 * 1. Decide if a message is an actionable task needing an upfront acknowledgment
 * 2. Classify message complexity (simple chat vs complex task) for model routing
 *
 * Returns { ack, complexity } where:
 * - ack: natural acknowledgment string, or null if not a task
 * - complexity: 'simple' (use Flash) or 'complex' (use Pro)
 */
async function classifyAndAck(
    llm: LLMClient,
    message: string,
): Promise<{ ack: string | null; complexity: "simple" | "complex" }> {
    try {
        const response = await llm.chat({
            messages: [
                {
                    role: "user",
                    content: `Message from user: "${message.substring(0, 500)}"

Analyze this message and respond with EXACTLY two lines:

LINE 1 - TASK ACKNOWLEDGMENT:
If this message asks you to DO something requiring action (searching, downloading, creating, browsing, running commands, etc.), write a short casual acknowledgment (1 sentence). CRITICAL: The acknowledgment MUST MATCH THE VIBE AND TONE of the user's message. If they are excited, match the energy. If they use slang, respond naturally. Make it specific and use appropriate emojis.
If it's NOT a task, write exactly "NONE".

LINE 2 - COMPLEXITY:
Write "SIMPLE" if this is: a greeting, casual chat, short question, opinion request, reaction, acknowledgment, small talk, general knowledge question, or anything that can be answered from general knowledge without tools.
Write "COMPLEX" if this: requires tool use, web search, file operations, browsing, code execution, multi-step reasoning, analysis of specific data, or any real work.`,
                },
            ],
            systemPrompt: `You classify messages. Be precise.

Task acknowledgment examples:
- "search for flights to Goa" → "looking up flights now ✈️" (task)
- "I was thinking about Goa" → NONE (sharing thoughts)
- "what do you think about this" → NONE (asking opinion)
- "download this video" → "on it, downloading now ⬇️" (task)
- "bro we need to fix this prod issue NOW" → "on it boss, diving in right away 🚨" (task)
- "Hey play some songs man" → "vibes on, queuing up some tracks 🎧" (task)

Complexity examples:
- "hi", "hello", "hey" → SIMPLE
- "how are you" → SIMPLE
- "what's the capital of France" → SIMPLE
- "what do you think about AI" → SIMPLE
- "that's cool" → SIMPLE
- "tell me a joke" → SIMPLE
- "good morning" → SIMPLE
- "what were we talking about yesterday" → SIMPLE
- "search for flights to Goa" → COMPLEX
- "open chrome and go to youtube" → COMPLEX
- "can you edit this file" → COMPLEX
- "research quantum computing papers" → COMPLEX
- "send a message to mom on whatsapp" → COMPLEX
- "set a reminder for tomorrow" → COMPLEX

When in doubt about task ack → NONE (don't acknowledge casual chat as task).
When in doubt about complexity → COMPLEX (better to use Pro than give a bad answer).

Respond with EXACTLY two lines, nothing else.`,
            modelOverride: MODELS.GPT41_NANO,
        });

        const text = (response.choices[0]?.message?.content || "NONE\nCOMPLEX").trim();
        const lines = text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

        const ackLine = lines[0] || "NONE";
        const complexityLine = (lines[1] || "COMPLEX").toUpperCase();

        const ack = ackLine.toUpperCase() === "NONE" || ackLine.toUpperCase().startsWith("NONE") ? null : ackLine;
        const complexity = complexityLine.includes("SIMPLE") ? ("simple" as const) : ("complex" as const);

        return { ack, complexity };
    } catch (err) {
        console.warn("  ⚠️ classifyAndAck failed:", (err as Error).message);
        return { ack: null, complexity: "complex" }; // Safe default: no ack, use Pro
    }
}

function splitIntoBubbles(text: string): string[] {
    const trimmed = text.trim();

    // Short messages stay as one bubble
    if (trimmed.length < 200 && !trimmed.includes("\n\n")) return [trimmed];

    // Split at double newlines (paragraph breaks), but keep code blocks intact
    const parts: string[] = [];
    let current = "";
    let inCodeBlock = false;

    for (const line of trimmed.split("\n")) {
        if (line.startsWith("```")) inCodeBlock = !inCodeBlock;

        if (!inCodeBlock && line.trim() === "" && current.trim().length > 0) {
            parts.push(current.trim());
            current = "";
        } else {
            current += (current ? "\n" : "") + line;
        }
    }
    if (current.trim()) parts.push(current.trim());

    // Merge tiny adjacent bubbles (< 40 chars) to avoid spam
    const merged: string[] = [];
    for (const part of parts) {
        if (merged.length > 0 && merged[merged.length - 1].length < 40 && part.length < 40) {
            merged[merged.length - 1] += "\n\n" + part;
        } else {
            merged.push(part);
        }
    }

    return merged.length > 0 ? merged : [trimmed];
}

function splitMessage(text: string, maxLength: number): string[] {
    // Use alive-ux smart chunking that preserves code blocks
    return smartChunkMessage(text, maxLength);
}

/**
 * Convert internal milestone messages into short, natural status texts.
 * Uses alive-ux for varied, human-like phrases.
 * Returns null for messages that shouldn't be shown to the user.
 */
function humanizeProgress(msg: string): string | null {
    const lower = msg.toLowerCase();

    // Skip generic "still working" and pure error messages
    if (lower.includes("still working")) return null;
    if (lower.startsWith("❌") || lower.startsWith("⚠️")) return null;
    if (lower.includes("scroll")) return null; // Too frequent, skip
    if (lower.includes("complete") || lower.includes("done")) return null;

    // Extract target context from milestone messages
    const extractTarget = (msg: string, patterns: RegExp[]): string | null => {
        for (const pat of patterns) {
            const match = msg.match(pat);
            if (match?.[1]) {
                let target = match[1]
                    .trim()
                    .replace(/\.{3}$/, "")
                    .replace(/^["']|["']$/g, "");
                if (target.length > 40) target = target.substring(0, 37) + "…";
                return target;
            }
        }
        return null;
    };

    // Search
    if (lower.includes("search") || lower.includes("🔍")) {
        const query = extractTarget(msg, [/[Ss]earching[:\s]*"?([^"]+)"?/i, /🔍\s*(?:Searching[:\s]*)?(.+)/]);
        return getProgressMessage("search", query || undefined);
    }

    // Browse / Navigate
    if (lower.includes("brows") || lower.includes("navigat") || lower.includes("🌐") || lower.includes("opening")) {
        const url = extractTarget(msg, [
            /(?:Opening|Navigating to|Browsing)\s+(https?:\/\/\S+)/i,
            /🌐\s*(?:Opening\s+)?(.+)/,
        ]);
        if (url) {
            try {
                const domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
                return getProgressMessage("browse", domain);
            } catch {
                return getProgressMessage("browse", url);
            }
        }
        return getProgressMessage("browse");
    }

    // Shell / command
    if (
        lower.includes("shell") ||
        lower.includes("command") ||
        lower.includes("terminal") ||
        lower.includes("running command")
    ) {
        const cmd = extractTarget(msg, [
            /[Rr]unning (?:command[:\s]*)?(.+)/i,
            /⚙️\s*(?:Running (?:command[:\s]*)?)?(.+)/,
        ]);
        return getProgressMessage("code", cmd || undefined);
    }

    // File read
    if ((lower.includes("read") && lower.includes("file")) || lower.includes("📖")) {
        const filePath = extractTarget(msg, [/[Rr]eading[:\s]*(.+)/i, /📖\s*(?:Reading[:\s]*)?(.+)/]);
        const base = filePath ? nodeBasename(filePath) || filePath : undefined;
        return getProgressMessage("read", base);
    }

    // File write
    if ((lower.includes("writ") && lower.includes("file")) || lower.includes("📝")) {
        const filePath = extractTarget(msg, [
            /[Ww]riting (?:file[:\s]*)?(.+)/i,
            /📝\s*(?:Writing (?:file[:\s]*)?)?(.+)/,
        ]);
        const base = filePath ? nodeBasename(filePath) || filePath : undefined;
        return getProgressMessage("write", base);
    }

    // Memory
    if (lower.includes("remembering") || lower.includes("🧠")) {
        const content = extractTarget(msg, [/[Rr]emembering[:\s]*"?([^"]+)"?/i, /🧠\s*(?:Remembering[:\s]*)?(.+)/]);
        return getProgressMessage("memory", content || undefined);
    }

    if (lower.includes("screenshot") || lower.includes("📸")) return getProgressMessage("screenshot");
    if (lower.includes("click") || lower.includes("typing")) return "🖱️ doing UI stuff";
    if (lower.includes("download")) return getProgressMessage("download");
    if (lower.includes("upload") || lower.includes("send")) return getProgressMessage("upload");
    if (lower.includes("scan") || lower.includes("analyz")) return getProgressMessage("analyze");
    if (lower.includes("deep research") || lower.includes("🔬")) return "🔬 deep researching";
    if (lower.includes("long task") || lower.includes("📋")) return "📋 running task";
    if (lower.includes("synthesiz")) return "🧩 putting it together";

    // Fallback
    return getProgressMessage("wait");
}

// ── Proactive Message Sender ──────────────────

export async function sendProactiveMessage(
    bot: Bot,
    config: Config,
    message: string,
    filePath?: string,
): Promise<void> {
    if (config.allowedUserIds.size === 0) {
        console.warn("⚠️ No allowed Telegram users to send proactive message to.");
        return;
    }

    // File attachment path — send document/photo/video based on extension
    if (filePath) {
        try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { InputFile } = await import("grammy");
            if (fs.existsSync(filePath)) {
                const buf = fs.readFileSync(filePath);
                const fileName = path.basename(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
                const isVideo = [".mp4", ".mov", ".webm"].includes(ext);
                const caption = message.length <= 1024 ? message : undefined;
                for (const userId of config.allowedUserIds) {
                    try {
                        const inputFile = new InputFile(buf, fileName);
                        if (isImage) {
                            await bot.api.sendPhoto(userId, inputFile, { caption });
                        } else if (isVideo) {
                            await bot.api.sendVideo(userId, inputFile, { caption });
                        } else {
                            await bot.api.sendDocument(userId, inputFile, { caption });
                        }
                    } catch (err) {
                        console.error(`❌ Failed to send proactive file to ${userId}:`, (err as Error).message);
                    }
                }
                // If caption was too long for Telegram (>1024), send the message separately
                if (caption === undefined && message) {
                    // fall through to also send the message as a regular text below
                } else {
                    return;
                }
            }
        } catch (fileErr) {
            console.error("❌ Proactive file send failed, falling back to text:", (fileErr as Error).message);
        }
    }

    // Skip when internet is down — no point retrying Telegram API
    try {
        const { isOffline } = await import("./network-health.js");
        if (isOffline()) {
            console.log("📵 Skipping proactive Telegram message — internet offline");
            return;
        }
    } catch {
        /* network monitor not loaded */
    }

    // Gate proactive messages through Smart DND (user responses bypass this check)
    try {
        const { shouldSuppressMessage } = await import("./proactive/dnd.js");
        const suppress = await shouldSuppressMessage(message);
        if (suppress) {
            console.log("🔕 Proactive Telegram message suppressed by DND");
            return;
        }
    } catch {
        /* DND check failed — deliver anyway */
    }

    // Track proactive message for read receipt awareness
    const log = (globalThis as Record<string, unknown>).__atlasProactiveLog as
        | Array<{ sentAt: number; topic: string; responded: boolean }>
        | undefined;
    if (log) {
        // Extract topic from first 80 chars
        const topic = message
            .substring(0, 80)
            .replace(/[*_`\n]/g, "")
            .trim();
        log.push({ sentAt: Date.now(), topic, responded: false });
        // Keep log bounded
        while (log.length > 20) log.shift();
    }

    const chunks = splitMessage(message, 4096);

    for (const userId of config.allowedUserIds) {
        for (const chunk of chunks) {
            let sent = false;
            for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
                try {
                    await bot.api.sendMessage(userId, markdownToTelegramHtml(sanitizeReply(chunk)), {
                        parse_mode: "HTML",
                    });
                    sent = true;
                } catch (err) {
                    const errMsg = (err as Error)?.message || String(err);
                    const isTransient =
                        errMsg.includes("ENOTFOUND") ||
                        errMsg.includes("ETIMEDOUT") ||
                        errMsg.includes("ECONNRESET") ||
                        errMsg.includes("ECONNREFUSED") ||
                        errMsg.includes("fetch failed");
                    if (isTransient && attempt < 3) {
                        // Retry transient network errors with backoff
                        await new Promise((r) => setTimeout(r, 2000 * attempt));
                        continue;
                    }
                    console.error(`❌ Failed to send proactive message to ${userId} (attempt ${attempt}):`, err);
                    // Fallback to plain text if HTML parsing fails (non-transient)
                    if (!isTransient) {
                        try {
                            await bot.api.sendMessage(userId, chunk);
                            sent = true;
                        } catch {
                            /* ignore fallback error */
                        }
                    }
                }
            }
        }
    }

    // Record notification for engagement tracking
    try {
        const { recordNotification } = await import("./proactive/notification-tracker.js");
        recordNotification("proactive", message);
    } catch {
        /* non-fatal */
    }
}

// ── Read Receipt Helpers ──────────────────────

export function getUnrespondedProactiveTopics(): string[] {
    const log = (globalThis as Record<string, unknown>).__atlasProactiveLog as
        | Array<{ sentAt: number; topic: string; responded: boolean }>
        | undefined;
    if (!log) return [];
    const now = Date.now();
    const STALE_THRESHOLD = 60 * 60 * 1000; // 1 hour
    return log.filter((e) => !e.responded && now - e.sentAt < STALE_THRESHOLD).map((e) => e.topic);
}
