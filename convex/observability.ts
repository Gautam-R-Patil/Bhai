// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Observability queries for the admin panel dashboard.
// Aggregates data from accounts, sessions, and activity logs.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

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

// ── System overview (one-shot fetch for the admin dashboard) ──────────────
// Aggregates accounts + sessions + waitlist + activity + model usage + recent
// errors into a single payload so the dashboard renders with one HTTP round-trip.
// All takes are capped at safe limits (same as getObservabilityData) — the
// dashboard intentionally never shows authoritative billing numbers, so a
// scan cap is acceptable here.
// Cheap heartbeat for live dashboard polling. Deliberately avoids the heavy
// table scans `getSystemOverview` does — just enough signal for the Health
// badge, error-count KPI, and connectivity probe to stay fresh between full
// refreshes. Roughly 3 reads vs ~30k for the full overview.
export const getDashboardHeartbeat = internalQuery({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const hourMs = 60 * 60 * 1000;
        const dayMs = 24 * hourMs;

        // Single small denorm table — same one the heavy query reads.
        const modelCounters = await ctx.db.query("llm_usage_counters").take(500);
        const lastLlmCall = modelCounters.reduce((max, m) => Math.max(max, m.lastCalledAt), 0);
        const totalLlmCalls = modelCounters.reduce((s, m) => s + m.count, 0);

        // Bounded: indexed read of the most-recent error rows. We don't return
        // payloads — only count, severity-broken-down, and the newest timestamp.
        const recentErrors = await ctx.db
            .query("error_log")
            .withIndex("by_timestamp")
            .order("desc")
            .take(50);
        const lastErrorAt = recentErrors[0]?.timestamp ?? null;
        const errorCount = recentErrors.filter((e) => e.severity === "error").length;

        let health: "healthy" | "idle" | "stale";
        if (lastLlmCall === 0 && totalLlmCalls === 0) {
            health = "healthy";
        } else if (now - lastLlmCall < hourMs) {
            health = "healthy";
        } else if (now - lastLlmCall < dayMs) {
            health = "idle";
        } else {
            health = "stale";
        }

        return {
            now,
            health,
            errorCount,
            lastErrorAt,
            lastLlmCallAt: lastLlmCall || null,
            totalLlmCalls,
        };
    },
});

export const getSystemOverview = internalQuery({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        const week = 7 * day;

        const accounts = await ctx.db.query("accounts").take(10000);
        const totalAccounts = accounts.length;
        const activeAccounts = accounts.filter((a) => a.status === "active").length;
        const suspendedAccounts = accounts.filter((a) => a.status === "suspended").length;
        const blockedAccounts = accounts.filter((a) => a.status === "blocked").length;
        const totalCreditsRemaining = accounts.reduce((s, a) => s + (a.ai_credits || 0), 0);
        const planCounts: Record<string, number> = {};
        for (const a of accounts) {
            const plan = a.plan || "free";
            planCounts[plan] = (planCounts[plan] || 0) + 1;
        }

        const sessions = await ctx.db.query("sessions").take(5000);
        const activeSessions = sessions.filter((s) => s.expiresAt > now).length;
        const sessionsToday = sessions.filter((s) => s.createdAt > now - day).length;
        const sessionsThisWeek = sessions.filter((s) => s.createdAt > now - week).length;

        const waitlist = await ctx.db.query("waitlist").take(2000);
        const waitlistTotal = waitlist.length;
        const waitlistNew = waitlist.filter((w) => w.status === "new").length;
        const waitlistContacted = waitlist.filter((w) => w.status === "contacted").length;
        const waitlistAccepted = waitlist.filter((w) => w.status === "accepted").length;
        const waitlistRejected = waitlist.filter((w) => w.status === "rejected").length;
        const waitlist24h = waitlist.filter((w) => w.submittedAt > now - day).length;
        const waitlist7d = waitlist.filter((w) => w.submittedAt > now - week).length;

        const developers = await ctx.db.query("developers").take(5000);
        const pendingDevelopers = developers.filter((d) => d.status === "pending").length;

        const items = await ctx.db.query("store_items").take(5000);
        const totalItems = items.length;
        const activeItems = items.filter((i) => i.status === "active").length;
        const totalInstalls = items.reduce((s, i) => s + (i.installCount || 0), 0);

        const submissions = await ctx.db.query("submissions").take(5000);
        const pendingSubmissions = submissions.filter((s) => s.status === "pending").length;

        // Model usage from the denormalized counter table
        const modelCounters = await ctx.db.query("llm_usage_counters").take(500);
        modelCounters.sort((a, b) => b.count - a.count);
        const topModels = modelCounters.slice(0, 10).map((m) => ({
            model: m.model,
            count: m.count,
            creditsCharged: m.creditsCharged,
            lastCalledAt: m.lastCalledAt,
        }));
        const totalLlmCalls = modelCounters.reduce((s, m) => s + m.count, 0);
        const totalCreditsCharged = modelCounters.reduce((s, m) => s + m.creditsCharged, 0);
        const lastLlmCall = modelCounters.reduce((max, m) => Math.max(max, m.lastCalledAt), 0);

        // Recent errors: union the new generic error_log (any subsystem)
        // with the legacy store_activity_log metadata-scan (marketplace
        // events). The error_log is the authoritative source going
        // forward; the activity-log scan stays so already-recorded store
        // events don't disappear from the dashboard.
        const ACTIVITY_SCAN_LIMIT = 5000;
        const activityLogs = await ctx.db
            .query("store_activity_log")
            .withIndex("by_timestamp")
            .order("desc")
            .take(ACTIVITY_SCAN_LIMIT);
        const activityScanCapped = activityLogs.length >= ACTIVITY_SCAN_LIMIT;

        const errorLogRows = await ctx.db
            .query("error_log")
            .withIndex("by_timestamp")
            .order("desc")
            .take(50);

        const storeErrorRows = activityLogs
            .filter((l) => {
                if (!l.metadata) return false;
                try {
                    const m = JSON.parse(l.metadata);
                    return m.error || m.status === "error" || m.status === "failed";
                } catch {
                    return l.metadata.toLowerCase().includes("error");
                }
            })
            .slice(0, 20)
            .map((l) => ({
                id: String(l._id),
                source: "store",
                type: l.type,
                message: l.metadata ?? "",
                severity: "error",
                timestamp: l.timestamp,
            }));

        const recentErrors = [
            ...errorLogRows.map((e) => ({
                id: String(e._id),
                source: e.source,
                type: e.type,
                message: e.message,
                severity: e.severity,
                timestamp: e.timestamp,
            })),
            ...storeErrorRows,
        ]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 15);

        const activity24h = activityLogs.filter((l) => l.timestamp > now - day).length;
        const activity7d = activityLogs.filter((l) => l.timestamp > now - week).length;

        // Health signal — anchored on whether the deployment has EVER seen
        // LLM traffic. A fresh prod deploy with no calls yet should NOT show
        // red — it should show "Awaiting traffic". Once traffic has happened,
        // recency of the last call decides healthy vs idle.
        const hourMs = 60 * 60 * 1000;
        const dayMs = 24 * hourMs;
        let health: "healthy" | "idle" | "stale";
        if (lastLlmCall === 0 && totalLlmCalls === 0) {
            // Never received an LLM call. Backend is reachable (we're answering
            // this query) — it's just a fresh deploy waiting for first traffic.
            health = "healthy";
        } else if (now - lastLlmCall < hourMs) {
            health = "healthy";
        } else if (now - lastLlmCall < dayMs || activity24h > 0) {
            health = "idle";
        } else {
            health = "stale";
        }

        return {
            now,
            health,
            accounts: {
                total: totalAccounts,
                active: activeAccounts,
                suspended: suspendedAccounts,
                blocked: blockedAccounts,
                totalCreditsRemaining,
                planCounts,
            },
            sessions: { active: activeSessions, today: sessionsToday, week: sessionsThisWeek },
            waitlist: {
                total: waitlistTotal,
                new: waitlistNew,
                contacted: waitlistContacted,
                accepted: waitlistAccepted,
                rejected: waitlistRejected,
                last24h: waitlist24h,
                last7d: waitlist7d,
            },
            store: {
                totalDevelopers: developers.length,
                pendingDevelopers,
                totalItems,
                activeItems,
                totalInstalls,
                pendingSubmissions,
            },
            llm: {
                topModels,
                totalCalls: totalLlmCalls,
                totalCreditsCharged,
                lastCalledAt: lastLlmCall || null,
            },
            activity: {
                last24h: activity24h,
                last7d: activity7d,
                // True when activity24h/7d may under-report because the scan
                // hit the 5000-row ceiling. The UI shows "5000+" instead of
                // a definite number when this is true.
                scanCapped: activityScanCapped,
            },
            recentErrors,
        };
    },
});

// ── Get observability overview ──────────────────────

export const getObservabilityData = internalQuery({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const oneDayAgo  = now - 24 * 60 * 60 * 1000;
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

        // ── Fetch all accounts for credit overview ──
        // Hard cap at 10k rows. Once the user base grows past this, the
        // admin panel should switch to a denormalized aggregate document
        // maintained by mutations (totalAccounts, creditsByPlan, etc.)
        // instead of summing over every account on every dashboard load.
        const accounts = await ctx.db.query("accounts").take(10000);

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
        // 10k cap. Sessions accumulate quickly — Phase 3 session TTL
        // sweeping (convex/sessions.ts:cleanup) keeps this honest.
        const sessions = await ctx.db.query("sessions").take(10000);
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

export const getCreditUsagePerUser = internalQuery({
    args: {},
    handler: async (ctx) => {
        // See getObservabilityData for the 10k cap rationale. TODO:
        // expose a paginated variant with cursor support for the admin
        // UI so the full list is reachable without a single 10k-row load.
        const accounts = await ctx.db.query("accounts").take(10000);

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
