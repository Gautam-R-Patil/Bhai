// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Isolated contact-form subsystem for xagilab.com — same shape as waitlist,
// different funnel. Public submit handler in convex/http.ts calls
// `insertContactSubmission` / `getRecentDuplicate`; admin panel reads via
// ADMIN_API_KEY-gated /api/admin/contact* routes (list / stats / update / delete).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const STATS_SCAN_CAP = 2000;
const DEDUP_WINDOW_MS = 30 * 60_000; // collapse re-submits within 30 min

export const insertContactSubmission = internalMutation({
  args: {
    name: v.string(),
    email: v.string(),
    company: v.optional(v.string()),
    inquiry: v.string(),
    message: v.string(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    origin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("contact_submissions", {
      ...args,
      status: "new",
      submittedAt: Date.now(),
    });
    return { id };
  },
});

export const getRecentDuplicate = internalQuery({
  args: { email: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const recent = await ctx.db
      .query("contact_submissions")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .order("desc")
      .take(5);
    return recent.find((r) => r.submittedAt > cutoff && r.message === args.message) ?? null;
  },
});

export const listContactSubmissions = internalQuery({
  args: {
    status: v.optional(v.string()),
    inquiry: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const hasStatus = args.status && args.status !== "all";
    const hasInquiry = args.inquiry && args.inquiry !== "all";

    const baseQuery = hasStatus
      ? ctx.db
          .query("contact_submissions")
          .withIndex("by_status", (q) => q.eq("status", args.status as string))
      : hasInquiry
        ? ctx.db
            .query("contact_submissions")
            .withIndex("by_inquiry", (q) => q.eq("inquiry", args.inquiry as string))
        : ctx.db.query("contact_submissions").withIndex("by_submittedAt");

    const result = await baseQuery
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    return {
      entries: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getContactStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const recent: Doc<"contact_submissions">[] = await ctx.db
      .query("contact_submissions")
      .withIndex("by_submittedAt")
      .order("desc")
      .take(STATS_SCAN_CAP);

    const total = recent.length;
    const scanCapped = total >= STATS_SCAN_CAP;
    let last24h = 0;
    let last7d = 0;
    const byStatus: Record<string, number> = { new: 0, replied: 0, archived: 0 };
    const byInquiry: Record<string, number> = {};
    const bySource: Record<string, number> = { xagilab: 0, tryatlasagi: 0, other: 0 };

    for (const r of recent) {
      const age = now - r.submittedAt;
      if (age <= day) last24h++;
      if (age <= 7 * day) last7d++;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byInquiry[r.inquiry] = (byInquiry[r.inquiry] ?? 0) + 1;
      const host = (r.origin ?? "").toLowerCase();
      if (host.includes("xagilab")) bySource.xagilab++;
      else if (host.includes("tryatlasagi")) bySource.tryatlasagi++;
      else bySource.other++;
    }

    return {
      total,
      scanCapped,
      new: byStatus.new ?? 0,
      replied: byStatus.replied ?? 0,
      archived: byStatus.archived ?? 0,
      last24h,
      last7d,
      byInquiry,
      bySource,
    };
  },
});

export const updateContactSubmission = internalMutation({
  args: {
    entryId: v.id("contact_submissions"),
    status: v.optional(v.string()),
    adminNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.status !== undefined) patch.status = args.status;
    if (args.adminNotes !== undefined) patch.adminNotes = args.adminNotes;
    if (Object.keys(patch).length === 0) return { ok: true };
    await ctx.db.patch(args.entryId, patch);
    return { ok: true };
  },
});

export const deleteContactSubmission = internalMutation({
  args: { entryId: v.id("contact_submissions") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.entryId);
    return { ok: true };
  },
});
