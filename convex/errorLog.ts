// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Generic error log. Any subsystem that wants a backend error to surface on
// the admin dashboard / Error Logs page calls `internal.errorLog.record`.
// The table is bounded by a nightly sweep (see convex/crons.ts).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const VALID_SOURCES = new Set([
    "llm_proxy",
    "auth",
    "session",
    "waitlist",
    "store",
    "admin",
    "system",
    "otpless",
]);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
const MESSAGE_MAX = 2000;
const METADATA_MAX = 8000;

export const record = internalMutation({
    args: {
        source: v.string(),
        type: v.string(),
        message: v.string(),
        metadata: v.optional(v.string()),
        accountId: v.optional(v.id("accounts")),
        otplessUserId: v.optional(v.string()),
        ipAddress: v.optional(v.string()),
        severity: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const source = VALID_SOURCES.has(args.source) ? args.source : "system";
        const severity = args.severity && VALID_SEVERITIES.has(args.severity)
            ? args.severity
            : "error";
        const message = args.message.slice(0, MESSAGE_MAX);
        const metadata = args.metadata ? args.metadata.slice(0, METADATA_MAX) : undefined;
        return await ctx.db.insert("error_log", {
            source,
            type: args.type.slice(0, 100),
            message,
            metadata,
            accountId: args.accountId,
            otplessUserId: args.otplessUserId,
            ipAddress: args.ipAddress,
            severity,
            timestamp: Date.now(),
        });
    },
});

export const listRecent = internalQuery({
    args: {
        source: v.optional(v.string()),
        severity: v.optional(v.string()),
        sinceMs: v.optional(v.number()),
        limit: v.optional(v.number()),
        cursor: v.optional(v.union(v.string(), v.null())),
    },
    handler: async (ctx, { source, severity, sinceMs, limit, cursor }) => {
        const pageSize = Math.max(1, Math.min(limit ?? 50, 200));
        const cutoff = sinceMs ? Date.now() - sinceMs : 0;

        let q;
        if (source && VALID_SOURCES.has(source)) {
            q = ctx.db.query("error_log").withIndex("by_source_timestamp", (b) => b.eq("source", source));
        } else if (severity && VALID_SEVERITIES.has(severity)) {
            q = ctx.db.query("error_log").withIndex("by_severity_timestamp", (b) => b.eq("severity", severity));
        } else {
            q = ctx.db.query("error_log").withIndex("by_timestamp");
        }

        const page = await q.order("desc").paginate({
            numItems: pageSize,
            cursor: cursor ?? null,
        });

        const filtered = cutoff > 0
            ? page.page.filter((e) => e.timestamp >= cutoff)
            : page.page;

        return {
            entries: filtered.map((e) => ({
                _id: e._id,
                source: e.source,
                type: e.type,
                message: e.message,
                metadata: e.metadata,
                accountId: e.accountId,
                otplessUserId: e.otplessUserId,
                ipAddress: e.ipAddress,
                severity: e.severity,
                timestamp: e.timestamp,
            })),
            isDone: page.isDone,
            continueCursor: page.continueCursor,
        };
    },
});

// Bounded nightly sweep. 30-day retention by default; callers can override.
// Deletes in batches of 500 so we never breach Convex's mutation row limit.
export const sweepOld = internalMutation({
    args: {
        olderThanMs: v.optional(v.number()),
        batchSize: v.optional(v.number()),
    },
    handler: async (ctx, { olderThanMs, batchSize }) => {
        const ttl = olderThanMs ?? 30 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - ttl;
        const size = Math.max(1, Math.min(batchSize ?? 500, 1000));

        const stale = await ctx.db
            .query("error_log")
            .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
            .take(size);

        for (const row of stale) {
            await ctx.db.delete(row._id);
        }
        return { deleted: stale.length, cutoff };
    },
});

export const getRecentForDashboard = internalQuery({
    args: { limit: v.optional(v.number()) },
    handler: async (ctx, { limit }) => {
        const n = Math.max(1, Math.min(limit ?? 10, 50));
        const rows = await ctx.db
            .query("error_log")
            .withIndex("by_timestamp")
            .order("desc")
            .take(n);
        return rows.map((e) => ({
            id: e._id,
            source: e.source,
            type: e.type,
            message: e.message,
            severity: e.severity,
            timestamp: e.timestamp,
        }));
    },
});
