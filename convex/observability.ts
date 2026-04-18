// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Observability queries for the admin panel dashboard.
// Aggregates data from accounts, sessions, and activity logs.

import { v } from "convex/values";
import { query } from "./_generated/server";

// ── Credit cost tiers (mirrors http.ts for estimation) ─────────────

const MODEL_COSTS: Record<string, { credits: number; costPer1kInput: number; costPer1kOutput: number; tier: string }> = {
    // Light tier (0.25 credits)
    "anthropic/claude-haiku-4.5":           { credits: 0.25, costPer1kInput: 0.0008, costPer1kOutput: 0.004,  tier: "light" },
    "google/gemini-2.0-flash-001":          { credits: 0.25, costPer1kInput: 0.0001, costPer1kOutput: 0.0004, tier: "light" },
    "google/gemini-2.5-flash-lite":         { credits: 0.25, costPer1kInput: 0.0001, costPer1kOutput: 0.0004, tier: "light" },
    "google/gemini-3-flash-preview":        { credits: 0.25, costPer1kInput: 0.0001, costPer1kOutput: 0.0004, tier: "light" },
    "google/gemini-3.1-flash-lite-preview": { credits: 0.25, costPer1kInput: 0.0001, costPer1kOutput: 0.0004, tier: "light" },
    "amazon/nova-micro-v1":                 { credits: 0.25, costPer1kInput: 0.0001, costPer1kOutput: 0.0004, tier: "light" },
    "amazon/nova-lite-v1":                  { credits: 0.25, costPer1kInput: 0.0002, costPer1kOutput: 0.0008, tier: "light" },
    "gpt-4o-mini":                          { credits: 0.25, costPer1kInput: 0.00015, costPer1kOutput: 0.0006, tier: "light" },
    // Mid tier (0.5 credits)
    "google/gemini-2.5-flash":              { credits: 0.5,  costPer1kInput: 0.00015, costPer1kOutput: 0.001, tier: "mid" },
    "amazon/nova-pro-v1":                   { credits: 0.5,  costPer1kInput: 0.0008,  costPer1kOutput: 0.003, tier: "mid" },
    // Pro tier (1 credit)
    "anthropic/claude-sonnet-4.5":          { credits: 1,  costPer1kInput: 0.003,  costPer1kOutput: 0.015,  tier: "pro" },
    "anthropic/claude-sonnet-4.6":          { credits: 1,  costPer1kInput: 0.003,  costPer1kOutput: 0.015,  tier: "pro" },
    "gpt-4o":                               { credits: 1,  costPer1kInput: 0.0025, costPer1kOutput: 0.01,   tier: "pro" },
    "google/gemini-3.1-pro-preview-customtools": { credits: 1, costPer1kInput: 0.00125, costPer1kOutput: 0.005, tier: "pro" },
    // Heavy tier (3 credits)
    "anthropic/claude-opus-4.6":            { credits: 3,  costPer1kInput: 0.015, costPer1kOutput: 0.075, tier: "heavy" },
    "openai/gpt-5-image":                   { credits: 3,  costPer1kInput: 0.005, costPer1kOutput: 0.015, tier: "heavy" },
};

// ── Get observability overview ──────────────────────

export const getObservabilityData = query({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const oneDayAgo  = now - 24 * 60 * 60 * 1000;
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

        // ── Fetch all accounts for credit overview ──
        const accounts = await ctx.db.query("accounts").collect();

        const totalCreditsRemaining = accounts.reduce((s, a) => s + (a.ai_credits || 0), 0);
        const activeAccounts = accounts.filter(a => a.status === "active").length;

        // Credit usage by plan
        const creditsByPlan: Record<string, { count: number; totalCredits: number }> = {};
        for (const a of accounts) {
            const plan = a.plan || "free";
            if (!creditsByPlan[plan]) creditsByPlan[plan] = { count: 0, totalCredits: 0 };
            creditsByPlan[plan].count++;
            creditsByPlan[plan].totalCredits += a.ai_credits || 0;
        }

        // ── Session activity (proxy for LLM request volume) ──
        const sessions = await ctx.db.query("sessions").collect();
        const activeSessions = sessions.filter(s => s.expiresAt > now).length;
        const todaySessions = sessions.filter(s => s.createdAt > oneDayAgo).length;
        const weekSessions = sessions.filter(s => s.createdAt > oneWeekAgo).length;
        const monthSessions = sessions.filter(s => s.createdAt > oneMonthAgo).length;

        // ── Activity logs (real usage data) ──
        const activityLogs = await ctx.db
            .query("store_activity_log")
            .withIndex("by_timestamp")
            .order("desc")
            .take(500);

        // Activity by day (last 30 days)
        const dailyActivity: Record<string, number> = {};
        for (const log of activityLogs) {
            const dayKey = new Date(log.timestamp).toISOString().split("T")[0];
            dailyActivity[dayKey] = (dailyActivity[dayKey] || 0) + 1;
        }

        // Activity by type
        const activityByType: Record<string, number> = {};
        for (const log of activityLogs) {
            activityByType[log.type] = (activityByType[log.type] || 0) + 1;
        }

        // Recent errors (last 20 -- from metadata containing "error")
        const recentErrors = activityLogs
            .filter(l => {
                if (!l.metadata) return false;
                try {
                    const m = JSON.parse(l.metadata);
                    return m.error || m.status === "error" || m.status === "failed";
                } catch {
                    return l.metadata.toLowerCase().includes("error");
                }
            })
            .slice(0, 20)
            .map(l => ({
                id: l._id,
                type: l.type,
                timestamp: l.timestamp,
                metadata: l.metadata,
            }));

        // ── Model usage estimation ──
        // Build model distribution from known cost tiers
        const modelNames = Object.keys(MODEL_COSTS);
        const modelUsage = modelNames.map(model => {
            const info = MODEL_COSTS[model];
            const shortName = model.split("/").pop() || model;
            return {
                model: shortName,
                fullModel: model,
                tier: info.tier,
                creditsPerCall: info.credits,
                costPer1kInput: info.costPer1kInput,
                costPer1kOutput: info.costPer1kOutput,
            };
        });

        // ── Tier distribution (estimate from credit costs) ──
        const tierBreakdown = {
            light:  { label: "Light (Haiku/Flash)", credits: 0.25, color: "#34c759" },
            mid:    { label: "Mid (Flash/Nova Pro)", credits: 0.5, color: "#ff9500" },
            pro:    { label: "Pro (Sonnet/GPT-4o)", credits: 1, color: "#0066cc" },
            heavy:  { label: "Heavy (Opus/GPT-5)", credits: 3, color: "#ff3b30" },
        };

        // ── Build daily request estimates (last 14 days) ──
        const requestsOverTime: Array<{ date: string; requests: number }> = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now - i * 24 * 60 * 60 * 1000);
            const dayKey = d.toISOString().split("T")[0];
            requestsOverTime.push({
                date: dayKey,
                requests: dailyActivity[dayKey] || 0,
            });
        }

        return {
            // Summary stats
            totalAccounts: accounts.length,
            activeAccounts,
            totalCreditsRemaining,
            creditsByPlan,

            // Session stats
            activeSessions,
            sessionsToday: todaySessions,
            sessionsThisWeek: weekSessions,
            sessionsThisMonth: monthSessions,

            // Activity
            requestsOverTime,
            activityByType,

            // Models
            modelUsage,
            tierBreakdown,

            // Errors
            recentErrors,
            errorCount: recentErrors.length,
        };
    },
});

// ── Get credit usage per user ───────────────────────

export const getCreditUsagePerUser = query({
    args: {},
    handler: async (ctx) => {
        const accounts = await ctx.db.query("accounts").collect();

        return accounts
            .map(a => ({
                userId: a.otplessUserId,
                name: a.name || a.email || a.phone || a.otplessUserId.slice(0, 8),
                email: a.email || "",
                plan: a.plan,
                status: a.status,
                creditsRemaining: a.ai_credits,
                activations: a.activations,
            }))
            .sort((a, b) => a.creditsRemaining - b.creditsRemaining); // lowest credits first
    },
});
