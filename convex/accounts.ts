// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Convex backend functions for Bhai account management.
// These run server-side and are called via ConvexHttpClient from Electron main + bot process.

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

// ── Internal credit deduction (called by HTTP proxy, not by clients) ──
// Returns { success, remaining, error? } or { success: false } on failure.
// Convex mutations are serializable transactions — concurrent calls to the same
// account are automatically serialized via OCC, so the read-then-write is atomic.
export const deductCreditsInternal = internalMutation({
  args: {
    otplessUserId: v.string(),
    amount: v.number(),
  },
  handler: async (ctx, { otplessUserId, amount }) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", otplessUserId))
      .unique();

    if (!account) return { success: false, remaining: -1, error: "account_not_found" };

    // Block deductions for non-active accounts
    if (account.status !== "active") {
      return { success: false, remaining: account.ai_credits, error: `account_${account.status}` };
    }

    const deductAmount = Math.max(0, amount);

    // Reject if insufficient credits
    if (account.ai_credits < deductAmount) {
      return { success: false, remaining: account.ai_credits, error: "insufficient_credits" };
    }

    const newCredits = account.ai_credits - deductAmount;
    await ctx.db.patch(account._id, { ai_credits: newCredits });
    return { success: true, remaining: newCredits };
  },
});

// ══════════════════════════════════════════════════
// ADMIN FUNCTIONS — used by the admin dashboard
// ══════════════════════════════════════════════════

// ── List all accounts ─────────────────────────────
// 10k cap; switch to paginated version if user base grows past this.
export const listAll = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("accounts").take(10000);
  },
});

// ── Update account fields (admin) ─────────────────
export const updateAccount = internalMutation({
  args: {
    id: v.id("accounts"),
    status: v.optional(v.string()),
    plan: v.optional(v.string()),
    ai_credits: v.optional(v.number()),
    activations: v.optional(v.number()),
    max_activations: v.optional(v.number()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    // Filter out undefined values
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) updates[key] = value;
    }
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(id, updates);
    }
    return await ctx.db.get(id);
  },
});

// ── Add credits to an account ─────────────────────
export const addCredits = internalMutation({
  args: {
    id: v.id("accounts"),
    amount: v.number(),
  },
  handler: async (ctx, { id, amount }) => {
    const account = await ctx.db.get(id);
    if (!account) return null;
    const newCredits = Math.max(0, account.ai_credits + amount);
    await ctx.db.patch(id, { ai_credits: newCredits });
    return newCredits;
  },
});

// ── Aggregate stats ───────────────────────────────
// TODO: denormalize to a single counters doc updated by each
// mutation so this is O(1) instead of O(N) scan at 10k cap.
export const getStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").take(10000);
    const total = accounts.length;
    const active = accounts.filter((a) => a.status === "active").length;
    const suspended = accounts.filter((a) => a.status === "suspended").length;
    const blocked = accounts.filter((a) => a.status === "blocked").length;
    const totalCredits = accounts.reduce((sum, a) => sum + a.ai_credits, 0);
    const planCounts: Record<string, number> = {};
    for (const a of accounts) {
      planCounts[a.plan] = (planCounts[a.plan] || 0) + 1;
    }
    return { total, active, suspended, blocked, totalCredits, planCounts };
  },
});

// ── Delete account ────────────────────────────────
export const deleteAccount = internalMutation({
  args: { id: v.id("accounts") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { success: true };
  },
});

// ══════════════════════════════════════════════════
// INTERNAL variants — called by HTTP actions only
// These will replace the public functions above once
// all clients migrate to session-authenticated HTTP endpoints.
// ══════════════════════════════════════════════════

export const getByOtplessIdInternal = internalQuery({
  args: { otplessUserId: v.string() },
  handler: async (ctx, { otplessUserId }) => {
    return await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", otplessUserId))
      .unique();
  },
});

export const upsertAccountInternal = internalMutation({
  args: {
    otplessUserId: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { otplessUserId, email, phone, name }) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", otplessUserId))
      .unique();

    if (existing) {
      const updates: Record<string, unknown> = {};
      if (email && email !== existing.email) updates.email = email;
      if (phone && phone !== existing.phone) updates.phone = phone;
      if (name && name !== existing.name) updates.name = name;
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(existing._id, updates);
      }
      return existing._id;
    }

    const id = await ctx.db.insert("accounts", {
      otplessUserId,
      email,
      phone,
      name,
      status: "active",
      plan: "free",
      ai_credits: 100,
      activations: 1,
      max_activations: 3,
    });

    return id;
  },
});

export const listAllInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("accounts").take(10000);
  },
});

export const getStatsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").take(10000);
    const total = accounts.length;
    const active = accounts.filter((a) => a.status === "active").length;
    const suspended = accounts.filter((a) => a.status === "suspended").length;
    const blocked = accounts.filter((a) => a.status === "blocked").length;
    const totalCredits = accounts.reduce((sum, a) => sum + a.ai_credits, 0);
    const planCounts: Record<string, number> = {};
    for (const a of accounts) {
      planCounts[a.plan] = (planCounts[a.plan] || 0) + 1;
    }
    return { total, active, suspended, blocked, totalCredits, planCounts };
  },
});

export const updateAccountInternal = internalMutation({
  args: {
    id: v.id("accounts"),
    status: v.optional(v.string()),
    plan: v.optional(v.string()),
    ai_credits: v.optional(v.number()),
    activations: v.optional(v.number()),
    max_activations: v.optional(v.number()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) updates[key] = value;
    }
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(id, updates);
    }
    return await ctx.db.get(id);
  },
});

export const addCreditsInternal = internalMutation({
  args: {
    id: v.id("accounts"),
    amount: v.number(),
  },
  handler: async (ctx, { id, amount }) => {
    const account = await ctx.db.get(id);
    if (!account) return null;
    const newCredits = Math.max(0, account.ai_credits + amount);
    await ctx.db.patch(id, { ai_credits: newCredits });
    return newCredits;
  },
});

export const deleteAccountInternal = internalMutation({
  args: { id: v.id("accounts") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { success: true };
  },
});

// ══════════════════════════════════════════════════
// ONE-SHOT: wipe legacy synthetic IDs (phone_*, google_*) pre-OTPless migration.
// Removed in a follow-up commit after rollout.
// ══════════════════════════════════════════════════

export const wipeLegacyIdsInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("accounts").take(10000);
    let deleted = 0;
    for (const a of all) {
      if (/^(phone_|google_)/.test(a.otplessUserId)) {
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_user", (q) => q.eq("otplessUserId", a.otplessUserId))
          .take(1000);
        for (const s of sessions) await ctx.db.delete(s._id);
        await ctx.db.delete(a._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});
