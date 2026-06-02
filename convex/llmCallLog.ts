// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Per-call LLM log. One row per /api/llm/chat invocation (success or failure)
// so the admin panel can drill from "Sonnet was called 1,247 times" down to
// "user X called Sonnet at 3:42pm, 1.2s latency, 500 input tokens". The
// aggregate counters in `llm_usage_counters` stay authoritative for top-models
// rendering — this table is the audit trail, swept nightly.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const VALID_STATUSES = new Set(["success", "failed", "rejected"]);
const ERROR_MAX = 2000;

export const record = internalMutation({
    args: {
        accountId: v.optional(v.id("accounts")),
        otplessUserId: v.optional(v.string()),
        model: v.string(),
        status: v.string(),
        credits: v.number(),
        latencyMs: v.number(),
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
        cachedTokens: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        hasMedia: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        const status = VALID_STATUSES.has(args.status) ? args.status : "failed";
        return await ctx.db.insert("llm_call_log", {
            accountId: args.accountId,
            otplessUserId: args.otplessUserId,
            model: args.model.slice(0, 200),
            status,
            credits: Math.max(0, args.credits),
            latencyMs: Math.max(0, args.latencyMs),
            inputTokens: args.inputTokens,
            outputTokens: args.outputTokens,
            cachedTokens: args.cachedTokens,
            errorMessage: args.errorMessage ? args.errorMessage.slice(0, ERROR_MAX) : undefined,
            hasMedia: args.hasMedia,
            timestamp: Date.now(),
        });
    },
});

export const listRecent = internalQuery({
    args: {
        accountId: v.optional(v.id("accounts")),
        model: v.optional(v.string()),
        status: v.optional(v.string()),
        sinceMs: v.optional(v.number()),
        limit: v.optional(v.number()),
        cursor: v.optional(v.union(v.string(), v.null())),
    },
    handler: async (ctx, { accountId, model, status, sinceMs, limit, cursor }) => {
        const pageSize = Math.max(1, Math.min(limit ?? 50, 200));
        const cutoff = sinceMs ? Date.now() - sinceMs : 0;

        let q;
        if (accountId) {
            q = ctx.db
                .query("llm_call_log")
                .withIndex("by_account_timestamp", (b) => b.eq("accountId", accountId));
        } else if (model) {
            q = ctx.db
                .query("llm_call_log")
                .withIndex("by_model_timestamp", (b) => b.eq("model", model));
        } else if (status && VALID_STATUSES.has(status)) {
            q = ctx.db
                .query("llm_call_log")
                .withIndex("by_status_timestamp", (b) => b.eq("status", status));
        } else {
            q = ctx.db.query("llm_call_log").withIndex("by_timestamp");
        }

        const page = await q.order("desc").paginate({
            numItems: pageSize,
            cursor: cursor ?? null,
        });

        let rows = page.page;
        if (cutoff > 0) rows = rows.filter((r) => r.timestamp >= cutoff);
        // Secondary filter when the user picks two facets at once (e.g.
        // model + status) — index supports one of them, in-memory the other.
        if (status && VALID_STATUSES.has(status) && !["status"].includes("status")) {
            rows = rows.filter((r) => r.status === status);
        }

        return {
            entries: rows.map((e) => ({
                _id: e._id,
                accountId: e.accountId,
                otplessUserId: e.otplessUserId,
                model: e.model,
                status: e.status,
                credits: e.credits,
                latencyMs: e.latencyMs,
                inputTokens: e.inputTokens,
                outputTokens: e.outputTokens,
                cachedTokens: e.cachedTokens,
                errorMessage: e.errorMessage,
                hasMedia: e.hasMedia,
                timestamp: e.timestamp,
            })),
            isDone: page.isDone,
            continueCursor: page.continueCursor,
        };
    },
});

// Aggregate stats over a recent window — latency percentiles + success rate
// per model. Bounded scan (5000 rows max) so it stays fast even on busy days;
// the UI shows a `scanCapped: true` flag when the window contains more.
export const getStats = internalQuery({
    args: { sinceMs: v.optional(v.number()) },
    handler: async (ctx, { sinceMs }) => {
        const SCAN_LIMIT = 5000;
        const window = sinceMs ?? 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - window;

        const rows = await ctx.db
            .query("llm_call_log")
            .withIndex("by_timestamp", (q) => q.gte("timestamp", cutoff))
            .order("desc")
            .take(SCAN_LIMIT);

        const totalCalls = rows.length;
        const successes = rows.filter((r) => r.status === "success").length;
        const failures = rows.filter((r) => r.status === "failed").length;
        const rejections = rows.filter((r) => r.status === "rejected").length;

        const latencies = rows
            .filter((r) => r.status === "success")
            .map((r) => r.latencyMs)
            .sort((a, b) => a - b);
        const pct = (p: number): number => {
            if (latencies.length === 0) return 0;
            const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
            return latencies[idx];
        };

        const byModel: Record<
            string,
            { calls: number; successes: number; failures: number; rejections: number; totalLatency: number; totalCredits: number }
        > = {};
        for (const r of rows) {
            const m = byModel[r.model] ??= {
                calls: 0,
                successes: 0,
                failures: 0,
                rejections: 0,
                totalLatency: 0,
                totalCredits: 0,
            };
            m.calls++;
            if (r.status === "success") m.successes++;
            if (r.status === "failed") m.failures++;
            if (r.status === "rejected") m.rejections++;
            m.totalLatency += r.latencyMs;
            m.totalCredits += r.credits;
        }
        const perModel = Object.entries(byModel)
            .map(([model, s]) => ({
                model,
                calls: s.calls,
                successRate: s.calls > 0 ? s.successes / s.calls : 0,
                failures: s.failures,
                rejections: s.rejections,
                avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatency / s.calls) : 0,
                creditsCharged: s.totalCredits,
            }))
            .sort((a, b) => b.calls - a.calls);

        return {
            windowMs: window,
            scanCapped: rows.length >= SCAN_LIMIT,
            totalCalls,
            successes,
            failures,
            rejections,
            successRate: totalCalls > 0 ? successes / totalCalls : 0,
            latencyP50: pct(50),
            latencyP95: pct(95),
            latencyP99: pct(99),
            perModel,
        };
    },
});

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
            .query("llm_call_log")
            .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
            .take(size);

        for (const row of stale) {
            await ctx.db.delete(row._id);
        }
        return { deleted: stale.length, cutoff };
    },
});
