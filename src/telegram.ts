// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { promises as fs, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename as nodeBasename } from "node:path";
import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
    type AgentResponse,
    type ChannelContext,
    clearConversation,
    type GeneratedImage,
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
    getThinkingPhrase,
    getVoiceStagePhrase,
    getWaitPhrase,
} from "./alive-ux.js";
import {
    chunkMarkdownForTelegram,
    isStopCommand,
    markdownToPlainText,
    markdownToTelegramHtml,
    sanitizeIncomingChannelText,
    stuckCallbackMessage,
    stuckKeyboard,
    withStuckReplyLine,
} from "./channel-text.js";
import { getThinkingLevel, handleCommand, initCommands } from "./commands/index.js";
import { getConvexSiteUrl } from "./config/keys.js";
import { getDataDir, getDownloadsDir, getImagesDir } from "./config/paths.js";
import type { Config } from "./config.js";
import { encryptedFetch } from "./crypto-transport.js";
import type { LLMClient } from "./llm.js";
import { MODELS } from "./llm.js";
import { registerImageDelivery } from "./media/image-jobs.js";
import {
    conversationKey,
    lastInboundImages,
    markPhotoQuestion,
    rememberInboundImages,
    takePhotoQuestion,
} from "./media/image-memory.js";
import { classifyQuery } from "./memory/classifier.js";
import { memoryUndoAction, pruneDigestTap, undoMemoryTap } from "./memory/forget.js";
import { getSessionToken } from "./session.js";
import { mapStepStatus, parseStepLine, STEP_HEARTBEAT_MS } from "./step-status.js";
import { batchKey } from "./telegram-batch.js";
import type { ProactiveButton } from "./tools/channel-send.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a Telegram API call, waiting out 429s (`retry_after`) a few times before giving up. */
async function withTelegramRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const retryAfter =
                err instanceof GrammyError && err.error_code === 429 ? err.parameters.retry_after : undefined;
            if (retryAfter === undefined || attempt >= maxAttempts) throw err;
            console.warn(`  ⏳ Telegram rate limit — retrying in ${retryAfter}s`);
            await sleep(retryAfter * 1000 + 250);
        }
    }
}

type TelegramReply = (text: string, opts?: Record<string, unknown>) => Promise<{ message_id?: number } | undefined>;

/**
 * Send Markdown as one or more HTML messages (each ≤4096 after conversion), with
 * 429 retry and a plain-text fallback per chunk. Returns the last message sent.
 */
async function sendTelegramMarkdown(
    reply: TelegramReply,
    md: string,
    opts: Record<string, unknown> = {},
    onSent?: (messageId: number) => void,
): Promise<{ messageId?: number; md: string }> {
    let last: { messageId?: number; md: string } = { md: "" };
    for (const chunk of chunkMarkdownForTelegram(sanitizeReply(md))) {
        let sent: { message_id?: number } | undefined;
        try {
            sent = await withTelegramRetry(() => reply(chunk.html, { parse_mode: "HTML", ...opts }));
        } catch {
            try {
                sent = await withTelegramRetry(() => reply(markdownToPlainText(chunk.md), opts));
            } catch (err) {
                console.warn("[TELEGRAM] Failed to send chunk:", (err as Error).message);
                continue;
            }
        }
        if (sent?.message_id) onSent?.(sent.message_id);
        last = { messageId: sent?.message_id, md: chunk.md };
    }
    return last;
}

/** A stuck report gets one-tap handoff buttons only in the owner's private chat. */
function wantsStuckButtons(res: { stuck?: boolean }, senderIsOwner: boolean, chatType?: string): boolean {
    return res.stuck === true && senderIsOwner && chatType === "private";
}

/** The owner's private chat gets buttons under a reply: the stuck handoff and/or "Forget that" for what it just noted. */
function replyKeyboard(
    res: Pick<AgentResponse, "stuck" | "memoryUndo">,
    senderIsOwner: boolean,
    chatType?: string,
): InlineKeyboardMarkup | undefined {
    if (!senderIsOwner || chatType !== "private") return undefined;
    const rows = res.stuck ? stuckKeyboard().inline_keyboard : [];
    if (res.memoryUndo) rows.push([{ text: "Forget that", callback_data: memoryUndoAction(res.memoryUndo) }]);
    return rows.length ? { inline_keyboard: rows } : undefined;
}

/**
 * Put the reply's buttons under its last bubble. If that edit fails (or nothing was sent), the
 * stuck report's I'll take over / Retry / Skip go out under a short follow-up, so they are never
 * silently lost; a lone "Forget that" is just dropped (memory_forget still works).
 */
async function attachReplyKeyboard(
    api: Bot["api"],
    chatId: number,
    messageId: number | undefined,
    reply_markup: InlineKeyboardMarkup | undefined,
    stuck: boolean | undefined,
    lastEditAt = 0,
): Promise<void> {
    if (!reply_markup) return;
    if (messageId) {
        // Telegram throttles rapid edits of one message — keep them ≥1s apart
        const wait = lastEditAt + 1000 - Date.now();
        if (wait > 0) await sleep(wait);
        try {
            await withTelegramRetry(() => api.editMessageReplyMarkup(chatId, messageId, { reply_markup }));
            return;
        } catch (err) {
            console.warn("[TELEGRAM] Failed to attach reply keyboard:", (err as Error).message);
        }
    }
    if (!stuck) return;
    // As a reply to the report, so a tap still carries the report as its reply context.
    const reply_parameters = messageId ? { message_id: messageId, allow_sending_without_reply: true } : undefined;
    await withTelegramRetry(() => api.sendMessage(chatId, "What next?", { reply_markup, reply_parameters })).catch(
        (err: Error) => console.warn("[TELEGRAM] Failed to send stuck keyboard:", err.message),
    );
}

/**
 * Done comes with the receipt: the screenshot taken after the last action, right after
 * the reply and threaded like it. No caption: the photo never claims more than the reply.
 */
async function sendReceipt(
    api: Bot["api"],
    chatId: number,
    receipt: AgentResponse["receipt"],
    opts: { reply_parameters?: { message_id: number } } = {},
): Promise<void> {
    if (!receipt) return;
    const photo = new InputFile(
        Buffer.from(receipt.imageBase64, "base64"),
        `receipt.${receipt.mimeType.split("/")[1] || "png"}`,
    );
    await withTelegramRetry(() => api.sendPhoto(chatId, photo, opts)).catch((err: Error) =>
        console.warn("[TELEGRAM] Failed to send receipt:", err.message),
    );
}

/** "sending a photo…" while generate_image runs (its milestone, or a step line quoting it), else "typing". */
export function chatActionFor(progress: string): "typing" | "upload_photo" {
    return /Editing your photo|Painting the image/.test(progress) ? "upload_photo" : "typing";
}

/** A file's id in an image button's callback data: its name's hash, found again in the Images folder. */
const imageId = (file: string) => createHash("sha1").update(nodeBasename(file)).digest("hex").slice(0, 12);

/** The one-tap follow-ups under a generated image; the callback data maps to IMAGE_ACTIONS. */
export function imageKeyboard(images: GeneratedImage[]): InlineKeyboard {
    // The buttons name their image, so a tap after a restart or after newer images acts on this one.
    const id = imageId(images[images.length - 1].path);
    const kb = new InlineKeyboard().text("🔁 Another version", `img:again:${id}`).text("✨ HD", `img:hq:${id}`);
    // Undo only when there is a before file to go back to (a combine of photos has none). It stays
    // plain: generate_image's undo walks the saved history, so naming a file would fight it.
    const canUndo = images.some((img) => img.kind !== "generated" && img.sourcePath);
    return canUndo ? kb.text("↩️ Undo", "img:undo") : kb;
}

/** An image button's tap becomes the owner's next message, like the stuck-report buttons. */
const IMAGE_ACTIONS: Record<string, string> = {
    again: "Make one more version of that image",
    hq: "Make that image again, one copy, in high quality",
    undo: "Undo that last image edit",
};

/**
 * img:again|hq[:<id>] or img:undo → the owner's next message, naming the file the id finds in the
 * Images folder. No id (an old button) or no such file: the plain message.
 */
export function imageCallbackMessage(data: string): string | undefined {
    const m = /^img:(?:(again|hq)(?::([0-9a-f]{12}))?|(undo))$/.exec(data);
    if (!m) return undefined;
    let file: string | undefined;
    if (m[2])
        try {
            const dir = getImagesDir();
            const name = readdirSync(dir).find((n) => imageId(n) === m[2]);
            if (name) file = join(dir, name);
        } catch {
            /* no Images folder: the plain message */
        }
    const action = m[1] ?? m[3];
    return file ? `${IMAGE_ACTIONS[action]}: ${file}` : IMAGE_ACTIONS[action];
}

/** The owner's photo with no words gets "What should I do with it?": button label → the message a tap sends. */
const PHOTO_CHOICES: Record<string, [string, string]> = {
    describe: ["Describe it", "Describe the photo I just sent"],
    nobg: ["Remove the background", "Remove the background from the photo I just sent"],
    light: ["Improve the lighting", "Improve the lighting of the photo I just sent"],
    cartoon: ["Make it a cartoon", "Make the photo I just sent a cartoon"],
};

export function photoKeyboard(): InlineKeyboard {
    const kb = new InlineKeyboard();
    Object.entries(PHOTO_CHOICES).forEach(([key, [label]], i) => {
        kb.text(label, `photo:${key}`);
        if (i === 1) kb.row(); // two rows of two
    });
    return kb;
}

/** photo:describe|nobg|light|cartoon → the owner's next message. */
export const photoCallbackMessage = (data: string): string | undefined =>
    Object.hasOwn(PHOTO_CHOICES, data.slice(6)) ? PHOTO_CHOICES[data.slice(6)][1] : undefined;

/** sendPhoto re-encodes to a ≤1280px JPEG: past that, the full file goes too. */
const PHOTO_MAX_EDGE = 1280;

/**
 * The turn's generated or edited images right after the reply, uncaptioned (the reply says what
 * they are): photos (one, or an album for 2-4), and as documents a PNG (instead of the photo, which
 * would flatten its transparency) or an image over 1280px (after the photo). The owner's private
 * chat gets the follow-up buttons. A photo Telegram refuses goes out as a document. Never throws.
 */
export async function sendImages(
    api: Bot["api"],
    chatId: number,
    images: GeneratedImage[] | undefined,
    withButtons: boolean,
    opts: { reply_parameters?: { message_id: number } } = {},
): Promise<void> {
    if (!images?.length) return;
    const reply_markup = withButtons ? imageKeyboard(images) : undefined;
    try {
        const sharp = (await import("sharp")).default;
        const files = await Promise.all(
            images.map(async (img) => {
                const buf = await fs.readFile(img.path);
                const meta = await sharp(buf)
                    .metadata()
                    .catch(() => ({ width: 0, height: 0 }));
                const png = img.mimeType === "image/png";
                const large = Math.max(meta.width ?? 0, meta.height ?? 0) > PHOTO_MAX_EDGE;
                return { buf, name: nodeBasename(img.path), png, large };
            }),
        );
        type File = (typeof files)[number];
        const input = (f: File) => new InputFile(f.buf, f.name);
        // One file carries the buttons when it is the only image; returns whether it did.
        const send = async (type: "photo" | "document", list: File[], markup?: InlineKeyboard) => {
            if (!list.length) return false;
            const doc = (f: File) =>
                withTelegramRetry(() => api.sendDocument(chatId, input(f), { reply_markup: markup, ...opts }));
            if (list.length === 1) {
                if (type === "document") await doc(list[0]);
                else
                    await withTelegramRetry(() =>
                        api.sendPhoto(chatId, input(list[0]), { reply_markup: markup, ...opts }),
                    ).catch(() => doc(list[0]));
                return !!markup;
            }
            const album = (t: "photo" | "document") => list.map((f) => ({ type: t, media: input(f) }));
            await withTelegramRetry(() => api.sendMediaGroup(chatId, album(type), opts)).catch((err) => {
                if (type === "document") throw err;
                return withTelegramRetry(() => api.sendMediaGroup(chatId, album("document"), opts));
            });
            return false;
        };
        const single = files.length === 1 ? reply_markup : undefined;
        const onPhoto = await send(
            "photo",
            files.filter((f) => !f.png),
            single,
        );
        const onDoc = await send(
            "document",
            files.filter((f) => f.png || f.large),
            onPhoto ? undefined : single,
        );
        if (reply_markup && !onPhoto && !onDoc)
            await withTelegramRetry(() => api.sendMessage(chatId, "Want another go?", { reply_markup, ...opts }));
    } catch (err) {
        console.warn("[TELEGRAM] Failed to send images:", (err as Error).message);
    }
}

/** Send a media or voice turn's reply as bubbles; a stuck report gets the handoff buttons or the reply line. */
async function replyInBubbles(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    result: Pick<AgentResponse, "text" | "stuck" | "receipt" | "memoryUndo" | "images">,
    senderIsOwner: boolean,
): Promise<void> {
    const buttons = wantsStuckButtons(result, senderIsOwner, ctx.chat?.type);
    const bubbles = splitIntoBubbles(buttons ? result.text : withStuckReplyLine(result, senderIsOwner));
    let lastId: number | undefined;
    for (let i = 0; i < bubbles.length; i++) {
        const bubble = bubbles[i];
        if (i > 0) {
            await ctx.replyWithChatAction("typing");
            const delay = Math.min(600, Math.max(300, bubble.length * 2));
            await new Promise((r) => setTimeout(r, delay));
        }
        const sent = await sendTelegramMarkdown((text, opts) => ctx.reply(text, opts), bubble);
        lastId = sent.messageId ?? lastId;
    }
    const keyboard = replyKeyboard(result, senderIsOwner, ctx.chat?.type);
    await attachReplyKeyboard(ctx.api, ctx.chat.id, lastId, keyboard, result.stuck);
    await sendReceipt(ctx.api, ctx.chat.id, result.receipt);
    await sendImages(ctx.api, ctx.chat.id, result.images, senderIsOwner && ctx.chat?.type === "private");
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
export function parseTelegramOwners(config: Config): Set<number> {
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

/** A turn running alongside another gets a copy of the owner's history: the owner's private turns
 *  only. Anyone else's gets none, so runAgent gives them their own guest history. */
export function concurrentHistoryFork(concurrent: boolean, senderIsOwner: boolean) {
    return concurrent && senderIsOwner ? [...getConversationHistory()] : undefined;
}

export function isOwnerPrivateChat(owners: Set<number>, fromId: number | undefined, chatType: string | undefined): boolean {
    return chatType === "private" && !!fromId && owners.has(fromId);
}

export function isPlatformOwner(channel: "telegram", userId: number, config: Config): boolean {
    if (channel !== "telegram") return false;
    return parseTelegramOwners(config).has(userId);
}

export function createTelegramBot(config: Config, llm: LLMClient): Bot {
    const bot = new Bot(config.telegramBotToken);
    _moduleBot = bot;
    _moduleConfig = config;
    registerImageDelivery("telegram", async (to, images, text, ownerDm) => {
        // A scheduled task's: the owners, as its own result goes (not while DND or offline holds it).
        if (to === "owner") {
            if (!(await sendProactiveMessage(bot, config, text))) return false;
            for (const id of parseTelegramOwners(config)) await sendImages(bot.api, id, images, ownerDm);
            return true;
        }
        await withTelegramRetry(() => bot.api.sendMessage(Number(to), text));
        await sendImages(bot.api, Number(to), images, ownerDm);
        return true;
    });
    const startTime = Date.now();
    const telegramOwners = parseTelegramOwners(config);

    // A research asked here gets one status message, edited as it moves, with Status/Cancel.
    const researchKeyboard = (id: string) =>
        new InlineKeyboard().text("Status", `research:status:${id}`).text("Cancel", `research:cancel:${id}`);
    void import("./research/index.js").then(({ registerResearchStatusCard }) =>
        registerResearchStatusCard("telegram", async (origin, id, text) => {
            const chatId = Number(origin.userId);
            if (!telegramOwners.has(chatId)) return null; // the owner's private chat only
            const sent = await bot.api.sendMessage(chatId, text, { reply_markup: researchKeyboard(id) });
            let last = text;
            return async (next, done) => {
                if (next === last && !done) return; // Telegram refuses an edit that changes nothing
                last = next;
                await bot.api.editMessageText(chatId, sent.message_id, next, done ? undefined : { reply_markup: researchKeyboard(id) });
            };
        }),
    );

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
        /** Who started it: in a group, "stop" from one member must not cancel another's work. */
        senderId?: number;
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
    (globalThis as Record<string, unknown>).__bhaiProactiveLog = proactiveMessageLog;

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
        if (isStopCommand(userMessage)) {
            // Clear any buffered messages too
            const buf = messageBuffer.get(bufKey);
            if (buf) {
                clearTimeout(buf.timer);
                messageBuffer.delete(bufKey);
            }

            // The owner may stop anything; anyone else only what they started.
            const isOwnerSender = !!ctx.from?.id && telegramOwners.has(ctx.from.id);
            const allTasks = activeTasks.get(chatId) || [];
            const tasks = isOwnerSender ? allTasks : allTasks.filter((t) => t.senderId === ctx.from?.id);

            // If replying "stop" to a specific bot message, cancel only that task
            if (replyToText && ctx.message.reply_to_message) {
                const repliedToMsgId = ctx.message.reply_to_message.message_id;
                const targetTaskId = botMessageToTask.get(repliedToMsgId);
                const targetTask = targetTaskId ? tasks.find((t) => t.taskId === targetTaskId) : null;
                if (targetTask) {
                    targetTask.controller.abort();
                    activeTasks.set(
                        chatId,
                        allTasks.filter((t) => t.taskId !== targetTaskId),
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
                const rest = allTasks.filter((t) => !tasks.includes(t));
                if (rest.length) activeTasks.set(chatId, rest);
                else activeTasks.delete(chatId);
                console.log(`  🛑 Aborting all ${tasks.length} active task(s) for chat ${chatId}`);
                await ctx.reply(`🛑 Stopping ${tasks.length} active task(s)...`);
            } else {
                await ctx.reply("No active task to stop.");
            }
            return;
        }

        // ── Proactive-subsystem commands (shut up / resume / set posture / status + monitor CRUD) ──
        // Owner only: another allowed user must not silence the owner's Bhai or add monitors.
        if (ctx.from?.id && telegramOwners.has(ctx.from.id)) {
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
            // /new, /compact, /status… act on (or show) the owner's own session: owner, in private.
            if (!(ctx.chat?.type === "private" && ctx.from?.id && telegramOwners.has(ctx.from.id))) {
                await ctx.reply("Commands are only for Bhai's owner, in a private chat.", {
                    reply_parameters: { message_id: triggerMessageId },
                });
                return;
            }
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

        bufferMessage(ctx, chatId, triggerMessageId, userMessage, replyToText, replyToAuthor);
    });

    // ── Buffer a message from the sender of `ctx` and debounce ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function bufferMessage(
        ctx: any,
        chatId: number,
        triggerMessageId: number,
        userMessage: string,
        replyToText?: string,
        replyToAuthor?: string,
    ) {
        const bufKey = batchKey(chatId, ctx.from?.id);
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
    }

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
        // Fire-and-forget: deliver dream results if available. They come from the owner's own
        // conversation and memory, and delivery empties the queue: the owner's private chat only.
        if (isOwnerPrivateChat(telegramOwners, ctx.from?.id, ctx.chat?.type)) (async () => {
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
            senderId: ctx.from?.id,
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
            let chatAction = chatActionFor("");
            const typingInterval = setInterval(async () => {
                try {
                    await ctx.replyWithChatAction(chatAction);
                } catch {
                    /* ignore */
                }
            }, 4000);

            // Track response time for awareness
            const taskStartTime = Date.now();

            try {
                // send_file goes to the chat set here (one per process): only the owner's private
                // turns may set it, or another chat's turn would redirect the owner's files.
                if (ctx.chat?.type === "private" && ctx.from?.id && telegramOwners.has(ctx.from.id)) {
                    setTelegramContext(bot, chatId);
                }

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
                let quickAckId: number | undefined; // the quick ack, later edited into the agent's contract line
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
                        quickAckId = (await ctx.reply(ack)).message_id;
                    }
                    console.log(`  🧠 Model routing: ${complexity}`);
                }
                // ─────────────────────────────────────────────────────────────

                // ── Live-status + varied thinking indicators ──────────────────
                // One editable message that cycles between thinking phrases and
                // tool milestone updates. Deleted before the real answer arrives.
                let statusMessageId: number | null = null;
                let lastStatusText = "";
                let lastStatusAt = 0; // when a tool/step status last landed
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
                            // A fresh step line says what's actually running; filler never covers it.
                            // Once it goes quiet (the batch ended, a long model call runs), rotate again.
                            if (parseStepLine(lastStatusText) && Date.now() - lastStatusAt < STEP_HEARTBEAT_MS + 5000)
                                return;

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
                    chatAction = chatActionFor(msg);
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

                    // ── Ack: the turn's contract line replaces the quick ack ──
                    if (msg.startsWith("[ACK] ")) {
                        await sendContractLine(bot.api, chatId, quickAckId, msg.slice(6));
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

                    const humanized = mapStepStatus(msg, humanizeProgress);
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
                                            lastStatusAt = Date.now();
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
                                lastStatusAt = Date.now();
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

                // Owner powers (tools, memory, history) only in the owner's private chat: in a
                // group the reply — and whatever a tool or memory put in it — is everyone's.
                const senderIsOwner =
                    !!ctx.from?.id && telegramOwners.has(ctx.from.id) && ctx.chat?.type === "private";
                const historyFork = concurrentHistoryFork(shouldFork, senderIsOwner);

                // Wire progress so sub-agent/research updates flow through our live-status. The
                // hooks are process-wide and only owner tools use them, so only an owner turn
                // registers (and clears) them: otherwise the owner's task progress lands here.
                if (senderIsOwner) {
                    setSwarmProgress(progressCallback);
                    setDeepResearchProgress(progressCallback);
                    setLongTaskProgress(progressCallback);
                }
                // The answer to "What should I do with it?" (a button or typed) is about that photo:
                // the model sees it (already remembered, so `capture` keeps it from being added twice).
                const photo = senderIsOwner
                    ? takePhotoQuestion(conversationKey("telegram", String(ctx.from.id))).map(
                          (i): MediaAttachment => ({ type: "image", ...i, capture: true }),
                      )
                    : [];
                const response = await runAgent(
                    llm,
                    agentMessage,
                    progressCallback,
                    photo.length ? photo : undefined,
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
                        replyTo: String(ctx.chat?.id ?? ""),
                    },
                );
                if (senderIsOwner) {
                    clearSwarmProgress();
                    clearDeepResearchProgress();
                    clearLongTaskProgress();
                }

                clearTimeout(thinkingFallback);
                // Aborted, or the agent decided no reply is needed: stay silent.
                if (controller.signal.aborted || response.text.trim() === "[NO_REPLY]") {
                    await clearStatusMessage();
                    return;
                }

                const taskDurationMs = Date.now() - taskStartTime;
                console.log(`🤖 Bhai: ${response.text.substring(0, 200)}... (${(taskDurationMs / 1000).toFixed(1)}s)`);
                if (response.toolCalls > 0) {
                    console.log(`   (${response.toolCalls} tool call(s))`);
                }

                // A stuck report gets one-tap handoff buttons in the owner's private chat, else the plain reply line.
                const stuckButtons = wantsStuckButtons(response, senderIsOwner, ctx.chat?.type);
                const responseText = stuckButtons ? response.text : withStuckReplyLine(response, senderIsOwner);

                // Split into human-like multiple messages at paragraph breaks
                await clearStatusMessage();
                const bubbles = splitIntoBubbles(responseText);

                // Streamed edit-in-place: for long responses, send first part then edit to append more
                const totalLength = bubbles.reduce((s, b) => s + b.length, 0);
                const useStreaming = totalLength > 300 && bubbles.length > 1;

                const replyOpts = shouldFork ? { reply_parameters: { message_id: triggerMessageId } } : {};
                const reply: TelegramReply = (text, opts) => ctx.reply(text, opts);
                let lastSentId: number | undefined;
                let lastEditAt = 0;
                const track = (id: number) => {
                    botMessageToTask.set(id, taskId);
                    lastSentId = id;
                };

                if (useStreaming) {
                    // Send first bubble immediately, then append the rest by editing it in place
                    let { messageId: sentMsgId, md: currentText } = await sendTelegramMarkdown(
                        reply,
                        bubbles[0],
                        replyOpts,
                        track,
                    );
                    lastEditAt = Date.now();

                    for (let i = 1; i < bubbles.length; i++) {
                        const delay = Math.min(600, Math.max(200, bubbles[i].length * 1.5));
                        await sleep(delay);
                        const candidate = `${currentText}\n\n${bubbles[i]}`;
                        const candidateChunks = chunkMarkdownForTelegram(sanitizeReply(candidate));

                        let edited = false;
                        const editId = sentMsgId;
                        if (editId && candidateChunks.length === 1) {
                            // Telegram throttles rapid edits of one message — keep them ≥1s apart
                            const wait = lastEditAt + 1000 - Date.now();
                            if (wait > 0) await sleep(wait);
                            try {
                                await withTelegramRetry(() =>
                                    ctx.api.editMessageText(ctx.chat.id, editId, candidateChunks[0].html, {
                                        parse_mode: "HTML",
                                    }),
                                );
                                edited = true;
                            } catch (err) {
                                edited =
                                    err instanceof GrammyError && err.description.includes("message is not modified");
                                if (!edited)
                                    console.warn(
                                        "[TELEGRAM] Streaming edit failed, sending as new message:",
                                        (err as Error).message,
                                    );
                            }
                            lastEditAt = Date.now();
                        }

                        if (edited) {
                            currentText = candidate;
                        } else {
                            // Too long for one message, or the edit failed: never drop the text — send it fresh
                            await ctx.replyWithChatAction("typing").catch(() => {});
                            const last = await sendTelegramMarkdown(reply, bubbles[i], {}, track);
                            if (last.messageId) {
                                sentMsgId = last.messageId;
                                currentText = last.md;
                                lastEditAt = Date.now();
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
                            await sleep(delay);
                        }
                        await sendTelegramMarkdown(reply, bubble, replyOpts, track);
                    }
                }
                const keyboard = replyKeyboard(response, senderIsOwner, ctx.chat?.type);
                await attachReplyKeyboard(ctx.api, chatId, lastSentId, keyboard, response.stuck, lastEditAt);
                await sendReceipt(ctx.api, chatId, response.receipt, replyOpts);
                await sendImages(
                    ctx.api,
                    chatId,
                    response.images,
                    senderIsOwner && ctx.chat?.type === "private",
                    replyOpts,
                );
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
            return;
        }

        // Other documents (PDF, CSV, txt…): save to the workspace, let the agent read it with its file tools
        const doc = ctx.message.document;
        const MAX_DOC_BYTES = 20 * 1024 * 1024; // Bot API getFile limit
        if ((doc.file_size ?? 0) > MAX_DOC_BYTES) {
            await ctx.reply(
                `That file is too big for me to download (${Math.round((doc.file_size ?? 0) / 1024 / 1024)} MB). Telegram limits bots to 20 MB.`,
            );
            return;
        }
        try {
            await ctx.replyWithChatAction("typing");
            const file = await bot.api.getFile(doc.file_id);
            const res = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`, {
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length > MAX_DOC_BYTES) throw new Error(`Document body too large: ${buffer.length} bytes`);

            const { randomUUID } = await import("node:crypto");
            const safeName =
                nodeBasename(doc.file_name || "document")
                    .replace(/[^\w.\- ]/g, "_")
                    .slice(-120) || "document";
            const savedPath = join(getDownloadsDir(), `${randomUUID().slice(0, 8)}_${safeName}`);
            await fs.writeFile(savedPath, buffer, { mode: 0o600 });
            console.log(
                `\n📄 ${ctx.from.first_name || "User"} sent a document: ${safeName} (${Math.round(buffer.length / 1024)}KB)`,
            );

            const caption = sanitizeIncomingChannelText(ctx.message.caption || `User sent a document: ${safeName}`);
            const safeMime = mime.replace(/[^\w.+/-]/g, "") || "unknown type";
            const agentMessage = `<channel_message_content>\n${caption}\n</channel_message_content>\n\n[BHAI-INTERNAL — not from user: Document "${safeName}" (${safeMime}) saved at ${savedPath}. Use file tools to read it if needed.]`;
            processBuffered(ctx.chat.id, ctx.message.message_id, agentMessage, ctx);
        } catch (err) {
            console.error("❌ Document download failed:", (err as Error).message);
            await ctx.reply("I couldn't download that file. Mind sending it again?");
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

        // Buttons act on the owner's inbox, memory, tasks and approvals (an interrupt's
        // "Approve" resumes the owner's agent): only the owner, in their private chat. A
        // stuck report's Retry/Skip in someone's own private chat is theirs to press.
        const inPrivate = ctx.chat?.type === "private";
        const pressedByOwner = !!ctx.from?.id && telegramOwners.has(ctx.from.id);
        if (!inPrivate || (!pressedByOwner && !data.startsWith("stuck:"))) {
            await ctx.answerCallbackQuery({ text: "Only Bhai's owner can do that." }).catch(() => {});
            return;
        }

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

        // ── Stuck-report handoff: stuck:takeover|retry|skip → that user's next message ──
        if (data.startsWith("stuck:")) {
            // A tap queued while the bot was down is "too old" to answer; still run the turn.
            await ctx.answerCallbackQuery().catch(() => {});
            await ctx.editMessageReplyMarkup().catch(() => {});
            const message = stuckCallbackMessage(data);
            const stuckMsg = ctx.callbackQuery.message;
            // Carry the report as reply context, so an old or concurrent tap answers this report, not the latest turn.
            // Buttons under the "What next?" fallback reply to the report: carry that instead.
            const reportText = stuckMsg?.reply_to_message?.text ?? stuckMsg?.text;
            if (message && chatId && stuckMsg) bufferMessage(ctx, chatId, stuckMsg.message_id, message, reportText);
            return;
        }

        // ── Image follow-ups under a generated photo: img:again|hq|undo → the owner's next message ──
        if (data.startsWith("img:")) {
            await ctx.answerCallbackQuery().catch(() => {});
            await ctx.editMessageReplyMarkup().catch(() => {});
            const message = imageCallbackMessage(data);
            const imgMsg = ctx.callbackQuery.message;
            if (message && chatId && imgMsg)
                bufferMessage(ctx, chatId, imgMsg.message_id, message, imgMsg.caption ?? imgMsg.reply_to_message?.text);
            return;
        }

        // ── The question under a photo sent with no words: photo:<choice> → the owner's next message ──
        if (data.startsWith("photo:")) {
            await ctx.answerCallbackQuery().catch(() => {});
            await ctx.editMessageReplyMarkup().catch(() => {});
            const message = photoCallbackMessage(data);
            const question = ctx.callbackQuery.message;
            if (message && chatId && question) bufferMessage(ctx, chatId, question.message_id, message);
            return;
        }

        // ── "Forget that" under a reply that noted something (mem:forget:<id>:<storedAt>), or a
        //    weekly digest's "Forget #n" (mem:digest:<id>:<sentAt>) ──
        if (data.startsWith("mem:forget:") || data.startsWith("mem:digest:")) {
            const owner = !!ctx.from?.id && telegramOwners.has(ctx.from.id) && ctx.chat?.type === "private";
            const text = owner ? (undoMemoryTap(data) ?? pruneDigestTap(data)) : "Only the owner can do that.";
            await ctx.answerCallbackQuery({ text }).catch(() => {});
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

        // ── Research status message: research:status:<id> / research:cancel:<id> ──
        if (data.startsWith("research:status:") || data.startsWith("research:cancel:")) {
            const id = data.slice(data.indexOf(":", 9) + 1);
            const { cancelResearchById, researchStatusLine } = await import("./research/index.js");
            if (data.startsWith("research:status:")) {
                await ctx.answerCallbackQuery({ text: (await researchStatusLine(id)).slice(0, 190), show_alert: true });
            } else {
                const stopped = await cancelResearchById(id);
                // Not running may mean failed or interrupted, not finished: say which.
                await ctx.answerCallbackQuery({
                    text: stopped ? "Stopping the research…" : `Not running. ${(await researchStatusLine(id)).slice(0, 170)}`,
                });
            }
            return;
        }

        // ── Unknown callback — acknowledge to stop Telegram loading indicator ──
        await ctx.answerCallbackQuery({ text: "Unknown action" });
    });

    return bot;
}

// ── Media Message Handler ─────────────────────

type MediaMessage = {
    caption?: string;
    media_group_id?: string;
    photo?: Array<{ file_id: string }>;
    video?: { file_id: string; mime_type?: string };
    document?: { file_id: string; mime_type?: string };
};
type MediaItem = { message: MediaMessage; mediaType: "image" | "video" };
type MediaCtx = {
    message: MediaMessage;
    from: { id?: number; first_name?: string };
    chat: { id: number };
    reply: Function;
    replyWithChatAction: Function;
};
type TextBuffer = Map<string, { messages: string[]; timer: ReturnType<typeof setTimeout>; ctx: never }>;

const mediaGroups = new Map<
    string,
    { items: unknown[]; run: (items: never[]) => void; timer?: ReturnType<typeof setTimeout> }
>();

/**
 * An album arrives as one update per photo: buffer them by media_group_id and call the first
 * part's `run` once with all of them, `delayMs` after the last part.
 */
export function bufferMediaGroup<T>(key: string, item: T, run: (items: T[]) => void, delayMs = 1500): void {
    const group = mediaGroups.get(key) ?? { items: [], run: run as (items: never[]) => void };
    group.items.push(item);
    clearTimeout(group.timer);
    group.timer = setTimeout(() => {
        mediaGroups.delete(key);
        group.run(group.items as never[]);
    }, delayMs);
    mediaGroups.set(key, group);
}

async function handleMediaMessage(
    ctx: MediaCtx,
    bot: Bot,
    config: Config,
    llm: LLMClient,
    mediaType: "image" | "video",
    messageBuffer?: TextBuffer,
) {
    const item: MediaItem = { message: ctx.message, mediaType };
    const groupId = ctx.message.media_group_id;
    if (!groupId) return runMediaTurn(ctx, bot, config, llm, [item], messageBuffer, true);
    // Return at once (grammY polls one update at a time, so the other parts must get in): one turn
    // for the whole album runs from the first part's handler.
    bufferMediaGroup(`${ctx.chat.id}:${groupId}`, item, (items: MediaItem[]) => {
        runMediaTurn(ctx, bot, config, llm, items, messageBuffer, false).catch((err) =>
            console.error("❌ Media album error:", err),
        );
    });
}

/** Downloads one media part and saves it to a temp file; replies and returns null when it can't. */
async function fetchMedia(
    ctx: MediaCtx,
    bot: Bot,
    config: Config,
    { message, mediaType }: MediaItem,
): Promise<{ base64: string; mimeType: string; path: string; mediaType: "image" | "video" } | null> {
    // Get file ID
    let fileId: string;
    let mimeType: string;
    if (mediaType === "image" && message.photo) {
        // Photos come as array of sizes — take the largest
        fileId = message.photo[message.photo.length - 1].file_id;
        mimeType = "image/jpeg";
    } else if (mediaType === "video" && message.video) {
        fileId = message.video.file_id;
        mimeType = message.video.mime_type || "video/mp4";
    } else if (message.document) {
        fileId = message.document.file_id;
        mimeType = message.document.mime_type || (mediaType === "image" ? "image/jpeg" : "video/mp4");
    } else {
        await ctx.reply("Couldn't process this media.");
        return null;
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
        return null;
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
            console.warn(`  ⚠️ Media download attempt ${attempt}/${MAX_RETRIES} failed:`, (fetchErr as Error).message);
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
    const mediaDir = join(tmpdir(), "bhai_media");
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
    console.log(`  💾 Saved media to bhai_media/...`);

    return { base64, mimeType, path: tmpFilePath, mediaType };
}

/** One media turn for a photo/video, or for an album's parts together. */
export async function runMediaTurn(
    ctx: MediaCtx,
    bot: Bot,
    config: Config,
    llm: LLMClient,
    items: MediaItem[],
    messageBuffer: TextBuffer | undefined,
    waitForText: boolean,
) {
    const userName = ctx.from.first_name || "User";
    const { mediaType } = items[0];
    const given = items.map((i) => i.message.caption).find(Boolean);
    let caption = given || (items.length > 1 ? "What's in these?" : `What's in this ${mediaType}?`);
    const senderIsOwner =
        !!ctx.from?.id && isPlatformOwner("telegram", ctx.from.id, config) && (ctx.chat as { type?: string })?.type === "private";
    // The owner's photos with no words at all: ask what to do with them, no model call.
    let askFirst = senderIsOwner && !given && items.every((i) => i.message.photo);

    console.log(`\n📎 ${userName} sent ${items.length > 1 ? `${items.length} files` : `a ${mediaType}`}: ${caption}`);

    // Wait briefly so follow-up text messages (like 👍 or a comment) can arrive (an album already did)
    if (waitForText) await sleep(1500);

    // Absorb any buffered text messages sent right after the image
    if (messageBuffer) {
        const key = batchKey(ctx.chat.id, ctx.from?.id);
        const buf = messageBuffer.get(key);
        if (buf && buf.messages.length > 0) {
            const extra = buf.messages.join("\n");
            caption += "\n" + extra;
            askFirst = false;
            console.log(
                `  📦 Absorbed ${buf.messages.length} follow-up text(s) into media context: "${extra.substring(0, 60)}"`,
            );
            clearTimeout(buf.timer);
            messageBuffer.delete(key);
        }
    }

    await ctx.replyWithChatAction("typing");
    let chatAction = chatActionFor("");
    const typingInterval = setInterval(async () => {
        try {
            await ctx.replyWithChatAction(chatAction);
        } catch {
            /* ignore */
        }
    }, 4000);

    try {
        // An album keeps the parts that came through; it fails only when none did.
        const fetched = await Promise.allSettled(items.map((item) => fetchMedia(ctx, bot, config, item)));
        const saved = fetched.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
        if (!saved.length) {
            const failed = fetched.find((r) => r.status === "rejected");
            if (failed) throw failed.reason;
            return; // already told the user
        }
        if (askFirst) {
            // Kept under agent.ts's key for this chat, so a tap's source "attached" is this photo.
            const key = conversationKey("telegram", String(ctx.from.id));
            const photos = saved.map(({ base64, mimeType }) => ({ base64, mimeType }));
            rememberInboundImages(key, photos);
            // Asked only when these photos were kept (an oversized one isn't): else the usual turn sees them.
            if (photos.every((p) => lastInboundImages(key).includes(p))) {
                markPhotoQuestion(key);
                await ctx.reply("What should I do with it?", { reply_markup: photoKeyboard() });
                return;
            }
        }

        // Wrap attacker-controlled caption in delimiters and strip framing tokens.
        // The tmp file paths are Bhai-internal hints, separately marked.
        const notes = saved.map((m) =>
            m.mediaType === "image"
                ? `[BHAI-INTERNAL — not from user: this image is saved at ${m.path}. To change what's in it use generate_image with source "attached"; use the path only for desktop apps like DaVinci Resolve.]`
                : `[BHAI-INTERNAL — not from user: This video is saved at ${m.path}. Use this absolute path for DaVinci Resolve or Filmora edits.]`,
        );
        caption = `<channel_message_content>\n${sanitizeIncomingChannelText(caption)}\n</channel_message_content>\n\n${notes.join("\n")}`;

        // Build media attachments
        const media: MediaAttachment[] = saved.map((m) => ({
            type: m.mediaType,
            base64: m.base64,
            mimeType: m.mimeType,
        }));

        if ((ctx.chat as { type?: string })?.type === "private" && ctx.from?.id && isPlatformOwner("telegram", ctx.from.id, config)) {
            setTelegramContext(bot, ctx.chat.id); // owner's private chat only (see the text path)
        }

        // ── Send one natural acknowledgement before work starts ──
        const { ack: mediaAck } = await classifyAndAck(llm, caption);
        const mediaAckId: number | undefined = mediaAck ? (await ctx.reply(mediaAck)).message_id : undefined;

        // Progress is silent on Telegram — only logged to console — except the
        // turn's contract line, which replaces the quick ack.
        const progressCallback = async (msg: string) => {
            chatAction = chatActionFor(msg);
            console.log(`  📊 [progress] ${msg}`);
            if (msg.startsWith("[ACK] ")) await sendContractLine(bot.api, ctx.chat.id, mediaAckId, msg.slice(6));
        };

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
                userId: String(ctx.from?.id ?? ctx.chat.id), // the sender: a group's id would merge its members
                userName: ctx.from?.first_name,
                isOwner: senderIsOwner,
                isPrivate: (ctx.chat as { type?: string })?.type === "private",
                replyTo: String(ctx.chat.id),
            },
        );

        console.log(`🤖 Bhai: ${result.text.substring(0, 200)}...`);

        // If the agent decided no reply is needed, stay silent
        if (result.text.trim() === "[NO_REPLY]") {
            console.log("  🤫 No reply needed — staying silent");
            return;
        }

        await replyInBubbles(ctx, result, senderIsOwner);
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

        if (ctx.chat?.type === "private" && ctx.from?.id && isPlatformOwner("telegram", ctx.from.id as number, config)) {
            setTelegramContext(bot, ctx.chat.id); // owner's private chat only (see the text path)
        }

        const progressCallback = async (msg: string) => {
            console.log(`  📊 [progress] ${msg}`);
            if (msg.startsWith("[ACK] ")) await sendContractLine(bot.api, ctx.chat.id, undefined, msg.slice(6));
        };

        const senderIsOwner =
            !!ctx.from?.id && isPlatformOwner("telegram", ctx.from.id as number, config) && ctx.chat?.type === "private";
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
                replyTo: String(ctx.chat?.id ?? ""),
            },
        );

        console.log(`🤖 Bhai: ${result.text.substring(0, 200)}...`);

        if (result.text.trim() === "[NO_REPLY]") {
            console.log("  🤫 No reply needed — staying silent");
            return;
        }

        // Send response
        await replyInBubbles(ctx, result, senderIsOwner);
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
 * Delivers the agent's contract line ("on it — …; done = …"): edits the quick
 * ack already sent into it, so the user sees one ack, or sends it if none was.
 */
async function sendContractLine(
    api: Bot["api"],
    chatId: number,
    quickAckId: number | undefined,
    text: string,
): Promise<void> {
    try {
        if (quickAckId) await api.editMessageText(chatId, quickAckId, text);
        else await api.sendMessage(chatId, text);
    } catch {
        /* non-fatal: the reply still arrives */
    }
}

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
    buttons?: ProactiveButton[],
    _ownerOnly = false, // all proactive sends are owner-only now
): Promise<boolean> {
    if (config.allowedUserIds.size === 0) {
        console.warn("⚠️ No allowed Telegram users to send proactive message to.");
        return false;
    }

    // Proactive messages are the owner's (briefings, reminders, alerts carry their calendar,
    // tasks and mail, research reports): owners only, never every allowed user.
    const recipients = parseTelegramOwners(config);

    // File attachment path — send document/photo/video based on extension
    const refusedFile = filePath ? (await import("./security/sensitive-paths.js")).outboundFileRefusal(filePath) : null;
    if (refusedFile) console.warn(`[TG] ${refusedFile}`);
    if (filePath && !refusedFile) {
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
                // A short message rides as the caption, rendered like the text path; a longer one
                // follows as its own message below.
                const md = chunkMarkdownForTelegram(sanitizeReply(message));
                const cap = message.length <= 1024 && md.length === 1 ? md[0] : undefined;
                let fileSent = false;
                for (const userId of recipients) {
                    const send = (opts: { caption?: string; parse_mode?: "HTML" }): Promise<unknown> => {
                        const inputFile = new InputFile(buf, fileName);
                        if (isImage) return bot.api.sendPhoto(userId, inputFile, opts);
                        if (isVideo) return bot.api.sendVideo(userId, inputFile, opts);
                        return bot.api.sendDocument(userId, inputFile, opts);
                    };
                    try {
                        try {
                            await withTelegramRetry(() => send(cap ? { caption: cap.html, parse_mode: "HTML" } : {}));
                        } catch (err) {
                            if (!cap) throw err;
                            await withTelegramRetry(() => send({ caption: markdownToPlainText(cap.md) }));
                        }
                        fileSent = true;
                    } catch (err) {
                        console.error(`❌ Failed to send proactive file to ${userId}:`, (err as Error).message);
                    }
                }
                // Done only when the file went out and carried the message; otherwise the text path
                // below still delivers the message (and reports failure if nothing got through).
                if (fileSent && (cap || !message.trim())) return true;
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
            return false;
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
            return false;
        }
    } catch {
        /* DND check failed — deliver anyway */
    }

    // Track proactive message for read receipt awareness
    const log = (globalThis as Record<string, unknown>).__bhaiProactiveLog as
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

    const chunks = chunkMarkdownForTelegram(sanitizeReply(message));
    const keyboard = buttons?.length ? new InlineKeyboard() : undefined;
    for (const [i, b] of (buttons ?? []).entries()) {
        keyboard?.text(b.text, b.data);
        if (i % 4 === 3) keyboard?.row();
    }
    let delivered = false;
    for (const userId of recipients) {
        for (const [ci, chunk] of chunks.entries()) {
            const reply_markup = ci === chunks.length - 1 ? keyboard : undefined;
            let sent = false;
            for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
                try {
                    await withTelegramRetry(() =>
                        bot.api.sendMessage(userId, chunk.html, { parse_mode: "HTML", reply_markup }),
                    );
                    sent = delivered = true;
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
                            await bot.api.sendMessage(userId, markdownToPlainText(chunk.md), { reply_markup });
                            sent = delivered = true;
                        } catch {
                            /* ignore fallback error */
                        }
                    }
                }
            }
        }
    }

    if (!delivered) return false;

    // Record notification for engagement tracking
    try {
        const { recordNotification } = await import("./proactive/notification-tracker.js");
        recordNotification("proactive", message);
    } catch {
        /* non-fatal */
    }
    return true;
}

// ── Read Receipt Helpers ──────────────────────

export function getUnrespondedProactiveTopics(): string[] {
    const log = (globalThis as Record<string, unknown>).__bhaiProactiveLog as
        | Array<{ sentAt: number; topic: string; responded: boolean }>
        | undefined;
    if (!log) return [];
    const now = Date.now();
    const STALE_THRESHOLD = 60 * 60 * 1000; // 1 hour
    return log.filter((e) => !e.responded && now - e.sentAt < STALE_THRESHOLD).map((e) => e.topic);
}
