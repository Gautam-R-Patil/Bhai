// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Per-user bot-authored prompt addenda. Layered on top of the core
// system_prompts at assembly time. Bot writes here via session-auth
// HTTP routes; admins read via admin-auth HTTP routes.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Reserved slugs the bot cannot use for addenda (would collide with core prompts).
const RESERVED_SLUGS = new Set([
  "identity",
  "rules",
  "rules-mac",
  "rules-windows",
  "browsing",
  "coding",
  "thinking",
  "spec",
  "proactive-composer",
  "monitor-rule-parser",
  "orchestrator-base",
]);

// User-controlled slugs the bot can only WRITE to via specific user-driven
// paths (wizard / Settings personality sync). The agent's self-improvement
// tools must NOT clobber these.
const USER_CONTROLLED_SLUGS = new Set(["user-personality"]);

const MAX_CONTENT_BYTES = 50_000;
const MAX_ADDENDA_PER_USER = 12;
const WRITE_RATE_LIMIT_PER_DAY = 10;

// ── Queries ──────────────────────────────────────

export const listForUser = internalQuery({
  args: { otplessUserId: v.string() },
  handler: async (ctx, { otplessUserId }) => {
    return await ctx.db
      .query("user_prompt_addenda")
      .withIndex("by_user", (q) => q.eq("otplessUserId", otplessUserId))
      .take(64);
  },
});

export const getActiveAddendaForUser = internalQuery({
  args: { otplessUserId: v.string() },
  handler: async (ctx, { otplessUserId }) => {
    return await ctx.db
      .query("user_prompt_addenda")
      .withIndex("by_user_active", (q) => q.eq("otplessUserId", otplessUserId).eq("isActive", true))
      .take(MAX_ADDENDA_PER_USER);
  },
});

export const getHistoryForAddendum = internalQuery({
  args: { addendumId: v.id("user_prompt_addenda"), limit: v.optional(v.number()) },
  handler: async (ctx, { addendumId, limit }) => {
    const rows = await ctx.db
      .query("user_prompt_addendum_history")
      .withIndex("by_addendum_version", (q) => q.eq("addendumId", addendumId))
      .order("desc")
      .take(Math.min(limit ?? 20, 100));
    return rows;
  },
});

// ── Helpers ──────────────────────────────────────

async function checkRateLimit(ctx: any, otplessUserId: string): Promise<{ allowed: boolean; recent: number }> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  // Use the composite [otplessUserId, authoredAt] index so the time window
  // is pushed to the index, not filtered post-scan.
  const recent = await ctx.db
    .query("user_prompt_addendum_history")
    .withIndex("by_user_authoredAt", (q: any) => q.eq("otplessUserId", otplessUserId).gte("authoredAt", dayAgo))
    .take(WRITE_RATE_LIMIT_PER_DAY + 1);
  return { allowed: recent.length < WRITE_RATE_LIMIT_PER_DAY, recent: recent.length };
}

function validateInput(input: { slug: string; content: string; reason: string }): string | null {
  if (!input.slug || input.slug.length < 1 || input.slug.length > 64) return "slug must be 1-64 chars";
  if (!/^[a-z0-9-]+$/.test(input.slug)) return "slug must be kebab-case (lowercase letters, digits, dashes)";
  if (RESERVED_SLUGS.has(input.slug)) return `slug '${input.slug}' is reserved for core prompts`;
  if (!input.content || input.content.length === 0) return "content cannot be empty";
  const bytes = new TextEncoder().encode(input.content).length;
  if (bytes > MAX_CONTENT_BYTES) return `content exceeds ${MAX_CONTENT_BYTES} bytes (got ${bytes})`;
  if (!input.reason || input.reason.trim().length < 8) return "reason must be at least 8 chars (explains why this edit was made)";
  return null;
}

// ── Mutations ──────────────────────────────────────

// Upsert: create the addendum if absent, otherwise replace its content.
// Used by the nightly synthesis pass — one call per slug per day.
// `allowUserControlled` MUST be true when writing to a user-controlled slug
// (e.g. "user-personality"). The bot's self-improvement tools default to
// false, which prevents them from clobbering wizard/Settings choices.
export const upsertAddendum = internalMutation({
  args: {
    otplessUserId: v.string(),
    slug: v.string(),
    kind: v.union(v.literal("personality"), v.literal("skill"), v.literal("memory")),
    title: v.string(),
    content: v.string(),
    reason: v.string(),
    allowUserControlled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const err = validateInput(args);
    if (err) return { success: false, error: err };

    // Gate user-controlled slugs.
    if (USER_CONTROLLED_SLUGS.has(args.slug) && !args.allowUserControlled) {
      return { success: false, error: `slug '${args.slug}' is user-controlled (set via wizard/Settings); the agent cannot write to it` };
    }

    const rate = await checkRateLimit(ctx, args.otplessUserId);
    if (!rate.allowed) {
      return { success: false, error: `rate limit exceeded (${rate.recent} writes in last 24h, max ${WRITE_RATE_LIMIT_PER_DAY})` };
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("user_prompt_addenda")
      .withIndex("by_user_slug", (q) => q.eq("otplessUserId", args.otplessUserId).eq("slug", args.slug))
      .unique();

    if (existing) {
      // Reject kind-mismatch on existing slug: prevents a slug:"user-personality",
      // kind:"skill" attack from clobbering the personality with skill content.
      if (existing.kind !== args.kind) {
        return { success: false, error: `slug '${args.slug}' is already kind '${existing.kind}'; cannot change to '${args.kind}'` };
      }
      // Update existing addendum
      const newVersion = existing.version + 1;
      await ctx.db.insert("user_prompt_addendum_history", {
        otplessUserId: args.otplessUserId,
        addendumId: existing._id,
        slug: args.slug,
        content: existing.content,
        version: existing.version,
        authoredAt: now,
        reason: args.reason,
      });
      await ctx.db.patch(existing._id, {
        kind: args.kind,
        title: args.title,
        content: args.content,
        version: newVersion,
        isActive: true,
        updatedAt: now,
      });
      return { success: true, addendumId: existing._id, version: newVersion, created: false };
    }

    // Enforce per-user cap on number of addenda
    const all = await ctx.db
      .query("user_prompt_addenda")
      .withIndex("by_user", (q) => q.eq("otplessUserId", args.otplessUserId))
      .take(MAX_ADDENDA_PER_USER + 1);
    if (all.length >= MAX_ADDENDA_PER_USER) {
      return { success: false, error: `user already has ${all.length} addenda (max ${MAX_ADDENDA_PER_USER})` };
    }

    const id = await ctx.db.insert("user_prompt_addenda", {
      otplessUserId: args.otplessUserId,
      slug: args.slug,
      kind: args.kind,
      title: args.title,
      content: args.content,
      version: 1,
      isActive: true,
      hits: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("user_prompt_addendum_history", {
      otplessUserId: args.otplessUserId,
      addendumId: id,
      slug: args.slug,
      content: args.content,
      version: 1,
      authoredAt: now,
      reason: args.reason,
    });
    return { success: true, addendumId: id, version: 1, created: true };
  },
});

// Revert: roll an addendum back to a prior version from its history.
export const revertAddendum = internalMutation({
  args: {
    otplessUserId: v.string(),
    slug: v.string(),
    toVersion: v.number(),
  },
  handler: async (ctx, { otplessUserId, slug, toVersion }) => {
    const current = await ctx.db
      .query("user_prompt_addenda")
      .withIndex("by_user_slug", (q) => q.eq("otplessUserId", otplessUserId).eq("slug", slug))
      .unique();
    if (!current) return { success: false, error: `no addendum with slug '${slug}' for this user` };
    if (current.otplessUserId !== otplessUserId) return { success: false, error: "not owner" };

    const historyRow = await ctx.db
      .query("user_prompt_addendum_history")
      .withIndex("by_addendum_version", (q) => q.eq("addendumId", current._id).eq("version", toVersion))
      .unique();
    if (!historyRow) return { success: false, error: `no history at version ${toVersion}` };

    const now = Date.now();
    const newVersion = current.version + 1;
    await ctx.db.insert("user_prompt_addendum_history", {
      otplessUserId,
      addendumId: current._id,
      slug,
      content: current.content,
      version: current.version,
      authoredAt: now,
      reason: `revert to v${toVersion}`,
      revertedFrom: current.version,
    });
    await ctx.db.patch(current._id, {
      content: historyRow.content,
      version: newVersion,
      updatedAt: now,
    });
    return { success: true, addendumId: current._id, version: newVersion, revertedToContentOfVersion: toVersion };
  },
});

// Soft delete: deactivate an addendum so it stops appearing in the prompt.
export const deactivateAddendum = internalMutation({
  args: { otplessUserId: v.string(), slug: v.string() },
  handler: async (ctx, { otplessUserId, slug }) => {
    const row = await ctx.db
      .query("user_prompt_addenda")
      .withIndex("by_user_slug", (q) => q.eq("otplessUserId", otplessUserId).eq("slug", slug))
      .unique();
    if (!row) return { success: false, error: "not found" };
    await ctx.db.patch(row._id, { isActive: false, updatedAt: Date.now() });
    return { success: true };
  },
});

// Increment the hits counter on addenda included in a request. Called by the
// system prompt assembler. Best-effort — failures here do not break the request.
export const incrementHits = internalMutation({
  args: { addendumIds: v.array(v.id("user_prompt_addenda")) },
  handler: async (ctx, { addendumIds }) => {
    for (const id of addendumIds) {
      const row = await ctx.db.get(id);
      if (row) {
        await ctx.db.patch(id, { hits: (row.hits ?? 0) + 1 });
      }
    }
  },
});
