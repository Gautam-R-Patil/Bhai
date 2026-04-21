// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Chat-channel fallback for the agent inbox. When the overlay is offline,
// review-mode intents still surface — on Telegram via InlineKeyboard,
// on WhatsApp via a numbered-reply prompt.
//
// Task 4.3 of the proactiveness overhaul.

import { globalInboxBus, getInboxManager } from "./manager.js";
import type { InboxItem } from "./store.js";
import { debugProactive } from "../kill-switches.js";

const WA_REPLY_TTL_MS = 6 * 3600_000; // remember the prompt's context for 6h

type WaitingReply = {
    inboxId: string;
    sentAt: number;
};

const waitingByJid = new Map<string, WaitingReply>();

function getPrimaryChannel(): "telegram" | "whatsapp" {
    const p = (process.env.PRIMARY_CHANNEL || "telegram").toLowerCase();
    if (p === "whatsapp") return "whatsapp";
    return "telegram";
}

async function isOverlayActiveSafely(): Promise<boolean> {
    // Lazy import so test environments / non-overlay builds don't blow up
    try {
        const mod = await import("../../overlay/overlay-chat.js");
        const fn = (mod as { isOverlayConnected?: () => boolean }).isOverlayConnected;
        return typeof fn === "function" ? fn() : false;
    } catch {
        return false;
    }
}

let started = false;
let unsub: (() => void) | null = null;

/** Start listening for inbox "added" events and route to the primary chat
 *  channel when the overlay isn't connected. Idempotent. */
export function startInboxChatFallback(): void {
    if (started) return;
    started = true;
    unsub = globalInboxBus.subscribe((ev) => {
        if (ev.kind !== "added") return;
        void (async () => {
            try {
                // Don't intercept if the overlay is live — Task 4.2 handles that path.
                if (await isOverlayActiveSafely()) {
                    debugProactive("inbox_fallback_skipped_overlay_live", { id: ev.item.intent.id });
                    return;
                }
                await dispatchToPrimary(ev.item);
            } catch (err) {
                debugProactive("inbox_fallback_dispatch_failed", {
                    id: ev.item.intent.id,
                    err: (err as Error).message,
                });
            }
        })();
    });
}

/** Stop the subscription. Used for teardown + tests. */
export function stopInboxChatFallback(): void {
    if (unsub) {
        unsub();
        unsub = null;
    }
    started = false;
    waitingByJid.clear();
}

/** Exported for tests: dispatch a single item to the primary channel. */
export async function dispatchToPrimary(item: InboxItem): Promise<void> {
    const channel = getPrimaryChannel();
    if (channel === "telegram") {
        await dispatchTelegram(item);
    } else {
        await dispatchWhatsApp(item);
    }
}

async function dispatchTelegram(item: InboxItem): Promise<void> {
    try {
        const { getTelegramBot, getTelegramConfig } = await import("../../telegram.js");
        const bot = getTelegramBot();
        if (!bot) throw new Error("telegram bot not initialized");
        const config = getTelegramConfig();
        const firstUserId = config?.allowedUserIds ? Array.from(config.allowedUserIds)[0] : undefined;
        if (!firstUserId) throw new Error("no owner chatId available");

        const { InlineKeyboard } = await import("grammy");
        const kb = new InlineKeyboard()
            .text("✓ Approve", `inbox:approve:${item.intent.id}`)
            .text("⏰ Defer 3h", `inbox:defer:${item.intent.id}:180`)
            .text("✗ Skip", `inbox:reject:${item.intent.id}`);

        const body = item.composedText
            ? `${item.composedText}\n\n(inbox action — no overlay connected)`
            : `(inbox action — no overlay connected)`;

        await bot.api.sendMessage(Number(firstUserId), body, { reply_markup: kb });
        debugProactive("inbox_fallback_tg_sent", { id: item.intent.id });
    } catch (err) {
        debugProactive("inbox_fallback_tg_err", { id: item.intent.id, err: (err as Error).message });
        throw err;
    }
}

async function dispatchWhatsApp(item: InboxItem): Promise<void> {
    try {
        const { sendWhatsAppProactiveMessage, getOwners } = await import("../../whatsapp.js");
        const owners = typeof getOwners === "function" ? getOwners() : [];
        const ownerJid = owners?.[0]?.jid;
        if (!ownerJid) throw new Error("no whatsapp owner registered");

        const body =
            (item.composedText || "(no preview)") +
            "\n\nReply 1 to approve, 2 to defer 3h, 3 to skip.";
        await sendWhatsAppProactiveMessage(body);

        waitingByJid.set(ownerJid, { inboxId: item.intent.id, sentAt: Date.now() });
        debugProactive("inbox_fallback_wa_sent", { id: item.intent.id, ownerJid });
    } catch (err) {
        debugProactive("inbox_fallback_wa_err", { id: item.intent.id, err: (err as Error).message });
        throw err;
    }
}

// ── Inbound handlers ──────────────────────────────────────────

/** Telegram callback_data dispatch entrypoint. Returns a short ack for
 *  `ctx.answerCallbackQuery({ text: ... })`. */
export async function handleTelegramInboxCallback(data: string): Promise<string> {
    const inbox = getInboxManager();
    if (!inbox) return "inbox not available";

    const parts = data.split(":");
    const action = parts[1];
    const id = parts[2];
    if (!id) return "bad callback";

    if (action === "approve") {
        const updated = inbox.approve(id);
        return updated ? "approved" : "not found";
    }
    if (action === "defer") {
        const minutes = parts[3] ? Number(parts[3]) : 180;
        const until = Date.now() + minutes * 60_000;
        const updated = inbox.defer(id, until);
        return updated ? `deferred ${minutes}m` : "not found";
    }
    if (action === "reject") {
        const updated = inbox.reject(id);
        return updated ? "skipped" : "not found";
    }
    return "unknown action";
}

/** WhatsApp reply-text dispatch entrypoint. Returns { handled: true, ack }
 *  if the text matched a pending inbox prompt for this JID. Returns
 *  { handled: false } if nothing matched — caller should fall through to
 *  normal message handling. */
export async function handleWhatsAppInboxReply(
    text: string,
    fromJid: string,
): Promise<{ handled: boolean; ack?: string }> {
    // Garbage-collect expired waiting entries
    const now = Date.now();
    for (const [jid, w] of waitingByJid.entries()) {
        if (now - w.sentAt > WA_REPLY_TTL_MS) waitingByJid.delete(jid);
    }

    const waiting = waitingByJid.get(fromJid);
    if (!waiting) return { handled: false };

    const inbox = getInboxManager();
    if (!inbox) return { handled: false };

    const lower = text.trim().toLowerCase();

    // Strict matches only — avoid consuming regular chat messages.
    if (lower === "1" || lower === "approve" || lower === "yes" || lower === "ok") {
        inbox.approve(waiting.inboxId);
        waitingByJid.delete(fromJid);
        return { handled: true, ack: "approved." };
    }
    if (lower === "2" || lower === "defer" || lower === "later" || lower === "snooze") {
        inbox.defer(waiting.inboxId, Date.now() + 3 * 3600_000);
        waitingByJid.delete(fromJid);
        return { handled: true, ack: "deferred 3 hours." };
    }
    if (lower === "3" || lower === "skip" || lower === "no" || lower === "reject") {
        inbox.reject(waiting.inboxId);
        waitingByJid.delete(fromJid);
        return { handled: true, ack: "skipped." };
    }

    // Not a recognized action — don't consume the message.
    return { handled: false };
}

// ── Test helpers ──────────────────────────────────────────────

export function _resetChatFallbackForTests(): void {
    waitingByJid.clear();
    started = false;
    if (unsub) {
        unsub();
        unsub = null;
    }
}

export function _peekWaitingForTests(fromJid: string): WaitingReply | undefined {
    return waitingByJid.get(fromJid);
}

export function _setWaitingForTests(fromJid: string, inboxId: string): void {
    waitingByJid.set(fromJid, { inboxId, sentAt: Date.now() });
}
