// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Lightweight per-model usage counters. Bumped from convex/http.ts after each
// successful /api/llm/chat call. The admin dashboard reads via getTopModels.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const incrementModelUsage = internalMutation({
    args: {
        model: v.string(),
        credits: v.number(),
    },
    handler: async (ctx, { model, credits }) => {
        const now = Date.now();
        const existing = await ctx.db
            .query("llm_usage_counters")
            .withIndex("by_model", (q) => q.eq("model", model))
            .first();
        if (existing) {
            await ctx.db.patch(existing._id, {
                count: existing.count + 1,
                creditsCharged: existing.creditsCharged + credits,
                lastCalledAt: now,
            });
            return existing._id;
        }
        return await ctx.db.insert("llm_usage_counters", {
            model,
            count: 1,
            creditsCharged: credits,
            lastCalledAt: now,
        });
    },
});

export const getTopModels = internalQuery({
    args: { limit: v.optional(v.number()) },
    handler: async (ctx, { limit }) => {
        // The table only has one row per model (~16 rows max with the
        // current MODEL_COSTS catalog), so taking all and sorting in-memory
        // is cheap. The limit just trims the response payload.
        const all = await ctx.db.query("llm_usage_counters").take(500);
        all.sort((a, b) => b.count - a.count);
        return all.slice(0, Math.max(1, Math.min(limit ?? 10, 50)));
    },
});
