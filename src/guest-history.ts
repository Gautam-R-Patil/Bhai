// © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// ── Guest conversations ───────────────────────
// A non-owner (a Slack/Discord guest, a web-widget visitor) must never run on the
// owner's conversation: the turn would see the owner's chat and memories, and the
// guest's words would land in it, read later as the owner's own. Each guest gets a
// short history of their own instead, keyed by channel + user.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const MAX_GUESTS = 100;
const MAX_MESSAGES = 40;
const guests = new Map<string, ChatCompletionMessageParam[]>();

/** This guest's history (oldest guest dropped past 100), trimmed to ~40 messages at a user turn. */
export function guestHistory(channel: string | undefined, userId: string | undefined): ChatCompletionMessageParam[] {
    const key = `${channel ?? "?"}:${userId ?? ""}`;
    const h = guests.get(key) ?? [];
    guests.delete(key); // re-insert: most recently used last
    guests.set(key, h);
    if (guests.size > MAX_GUESTS) guests.delete(guests.keys().next().value as string);
    if (h.length > MAX_MESSAGES) {
        // Cut at a user message so no tool result is left without the call that asked for it.
        const cut = h.findIndex((m, i) => i >= h.length - MAX_MESSAGES && m.role === "user");
        h.splice(0, cut === -1 ? h.length : cut);
    }
    return h;
}

/** The history a turn runs on: the caller's fork, or for a non-owner without one, their own. */
export function historyForCaller(
    historyFork: ChatCompletionMessageParam[] | undefined,
    ctx: { isOwner?: boolean; channel?: string; userId?: string } | undefined,
): ChatCompletionMessageParam[] | undefined {
    if (historyFork || ctx?.isOwner !== false) return historyFork;
    return guestHistory(ctx.channel, ctx.userId);
}
