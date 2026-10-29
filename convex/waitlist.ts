// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Isolated waitlist subsystem — no coupling to accounts/sessions/store tables.
// Public submit handler in convex/http.ts calls `insertWaitlistEntry` /
// `getEmailDuplicate`; admin panel reads via the ADMIN_API_KEY-gated
// /api/admin/waitlist* routes that call the list/stats/update/delete fns here.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const STATS_SCAN_CAP = 2000; // matches the safety cap used by observability queries

export const insertWaitlistEntry = internalMutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    role: v.string(),
    company: v.optional(v.string()),
    useCase: v.string(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("waitlist", {
      ...args,
      status: "new",
      submittedAt: Date.now(),
    });
    return { id };
  },
});

export const getEmailDuplicate = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

export const listWaitlist = internalQuery({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const hasStatus = args.status && args.status !== "all";

    const baseQuery = hasStatus
      ? ctx.db
          .query("waitlist")
          .withIndex("by_status", (q) => q.eq("status", args.status as string))
      : ctx.db.query("waitlist").withIndex("by_submittedAt");

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

export const getWaitlistStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const recent: Doc<"waitlist">[] = await ctx.db
      .query("waitlist")
      .withIndex("by_submittedAt")
      .order("desc")
      .take(STATS_SCAN_CAP);

    let total = recent.length;
    let newCount = 0;
    let contacted = 0;
    let accepted = 0;
    let rejected = 0;
    let last24h = 0;
    let last7d = 0;

    for (const entry of recent) {
      if (entry.status === "new") newCount++;
      else if (entry.status === "contacted") contacted++;
      else if (entry.status === "accepted") accepted++;
      else if (entry.status === "rejected") rejected++;
      const age = now - entry.submittedAt;
      if (age <= day) last24h++;
      if (age <= 7 * day) last7d++;
    }

    return {
      total,
      new: newCount,
      contacted,
      accepted,
      rejected,
      last24h,
      last7d,
      scanCapped: total >= STATS_SCAN_CAP,
    };
  },
});

export const updateWaitlistEntry = internalMutation({
  args: {
    entryId: v.id("waitlist"),
    status: v.optional(v.string()),
    adminNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, string> = {};
    if (args.status !== undefined) patch.status = args.status;
    if (args.adminNotes !== undefined) patch.adminNotes = args.adminNotes;
    if (Object.keys(patch).length === 0) {
      return { success: false, error: "No fields to update" };
    }
    await ctx.db.patch(args.entryId, patch);
    return { success: true };
  },
});

export const deleteWaitlistEntry = internalMutation({
  args: { entryId: v.id("waitlist") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.entryId);
    return { success: true };
  },
});

// Admin-triggered batch insert. Dedupes against existing rows by email so the
// import is idempotent — replaying the same payload twice won't double-insert.
// Per-row submittedAt is honored when provided so historical signups keep
// their original date; otherwise it falls back to "now".
export const bulkImportWaitlist = internalMutation({
  args: {
    entries: v.array(
      v.object({
        firstName: v.string(),
        lastName: v.string(),
        email: v.string(),
        role: v.string(),
        company: v.optional(v.string()),
        useCase: v.string(),
        // Locked to the canonical status union. Free-form v.string() would let
        // a caller with the admin key set status to any value and break
        // downstream filters / queries.
        status: v.optional(
          v.union(
            v.literal("new"),
            v.literal("contacted"),
            v.literal("accepted"),
            v.literal("rejected"),
          ),
        ),
        adminNotes: v.optional(v.string()),
        submittedAt: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Cap the batch so a single mutation can't blow through Convex's 1MB
    // arg / per-transaction read limits (each entry does a by_email lookup).
    // For larger imports, chunk client-side.
    if (args.entries.length > 500) {
      throw new Error(`Batch too large (${args.entries.length}); chunk into ≤500-entry batches`);
    }
    const now = Date.now();
    // Allow backdating up to 2 years; nothing legitimate predates that. Future
    // timestamps are clamped to "now" — they're never honest.
    const earliest = now - 2 * 365 * 24 * 60 * 60 * 1000;
    let inserted = 0;
    let skipped = 0;
    const skippedEmails: string[] = [];

    for (const entry of args.entries) {
      // Normalize so a "Different@Case.com" duplicate import doesn't create
      // a parallel row that bypasses the by_email dedup index.
      const email = entry.email.trim().toLowerCase();
      if (!email) {
        skipped++;
        continue;
      }
      const existing = await ctx.db
        .query("waitlist")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (existing) {
        skipped++;
        skippedEmails.push(email);
        continue;
      }
      const submittedAt = entry.submittedAt
        ? Math.min(Math.max(entry.submittedAt, earliest), now)
        : now;
      await ctx.db.insert("waitlist", {
        firstName: entry.firstName,
        lastName: entry.lastName,
        email,
        role: entry.role,
        company: entry.company,
        useCase: entry.useCase,
        status: entry.status ?? "new",
        adminNotes: entry.adminNotes,
        submittedAt,
      });
      inserted++;
    }

    return { inserted, skipped, skippedEmails };
  },
});

// Lightweight read used by the mailer action so it doesn't have to receive
// the entire payload twice — submit handler schedules the action with just
// the entryId, the action loads the row, formats the email.
export const getEntryById = internalQuery({
  args: { entryId: v.id("waitlist") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.entryId);
  },
});

// Records the outcome of an applicant-facing send so the admin panel can
// flag failures and offer a Resend button. Called by the mailer actions.
export const recordEmailOutcome = internalMutation({
  args: {
    entryId: v.id("waitlist"),
    kind: v.union(v.literal("contacted"), v.literal("accepted")),
    status: v.union(v.literal("sent"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.entryId, {
      lastEmailKind: args.kind,
      lastEmailStatus: args.status,
      // Wipe stale error on success; preserve on failure.
      lastEmailError: args.status === "sent" ? undefined : (args.error ?? "unknown_error"),
      lastEmailAt: Date.now(),
    });
    return { success: true };
  },
});
