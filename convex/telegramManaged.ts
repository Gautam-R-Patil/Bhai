// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// One-tap Telegram bots via Bot API "managed bots". XAGI runs one manager bot
// (Bot Management Mode on in BotFather); the desktop asks for a link with a
// suggested username, the user taps Create in Telegram, the manager's webhook
// gets the new bot, and the desktop picks up its token and owner once. The
// manager token lives only in Convex env; a bot's token is fetched only for a
// username someone claimed, and deleted when the desktop collects it.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const CLAIM_TTL_MS = 30 * 60 * 1000;

// Telegram usernames: 5-32 chars, letters/digits/underscore, bots end in "bot".
export function isBotUsername(u: unknown): u is string {
  return typeof u === "string" && /^[A-Za-z][A-Za-z0-9_]{3,30}bot$/i.test(u) && u.length <= 32;
}

export function managedBotLink(manager: string, username: string, name = "Bhai"): string {
  return `https://t.me/newbot/${encodeURIComponent(manager)}/${encodeURIComponent(username)}?name=${encodeURIComponent(name)}`;
}

export const claim = internalMutation({
  args: { otplessUserId: v.string(), username: v.string() },
  returns: v.null(),
  handler: async (ctx, { otplessUserId, username }) => {
    // One open claim per account: a new tap replaces the old one.
    const old = await ctx.db
      .query("telegram_bot_claims")
      .withIndex("by_otplessUserId", (q) => q.eq("otplessUserId", otplessUserId))
      .take(20);
    for (const row of old) await ctx.db.delete(row._id);
    await ctx.db.insert("telegram_bot_claims", { otplessUserId, username: username.toLowerCase(), status: "pending" });
    return null;
  },
});

export const isPending = internalQuery({
  args: { username: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { username }) => {
    const row = await ctx.db
      .query("telegram_bot_claims")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    return !!row && row.status === "pending" && Date.now() - row._creationTime < CLAIM_TTL_MS;
  },
});

export const fulfil = internalMutation({
  args: { username: v.string(), token: v.string(), ownerId: v.string(), ownerName: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { username, token, ownerId, ownerName }) => {
    const row = await ctx.db
      .query("telegram_bot_claims")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (!row || row.status !== "pending" || Date.now() - row._creationTime >= CLAIM_TTL_MS) return false;
    await ctx.db.patch(row._id, { status: "ready", token, ownerId, ownerName });
    return true;
  },
});

// Hands the token over once, only to the account that made the claim.
export const collect = internalMutation({
  args: { otplessUserId: v.string(), username: v.string() },
  returns: v.object({
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("expired")),
    token: v.optional(v.string()),
    ownerId: v.optional(v.string()),
    ownerName: v.optional(v.string()),
  }),
  handler: async (ctx, { otplessUserId, username }) => {
    const row = await ctx.db
      .query("telegram_bot_claims")
      .withIndex("by_username", (q) => q.eq("username", username.toLowerCase()))
      .first();
    if (!row || row.otplessUserId !== otplessUserId) return { status: "expired" as const };
    if (row.status === "ready") {
      await ctx.db.delete(row._id);
      return { status: "ready" as const, token: row.token, ownerId: row.ownerId, ownerName: row.ownerName };
    }
    if (Date.now() - row._creationTime >= CLAIM_TTL_MS) {
      await ctx.db.delete(row._id);
      return { status: "expired" as const };
    }
    return { status: "pending" as const };
  },
});
