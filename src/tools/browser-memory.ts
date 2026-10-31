// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Strategy Memory ───────────────────
// Learns from past browsing sessions — remembers what worked, what was fast
// Auto-saves sessions, expires stale strategies, adapts dynamically

import fs from "node:fs";
import path from "node:path";
import { getCurrentMode } from "./browser/browser-backend.js";

// ── Types ─────────────────────────────────────

interface BrowsingStep {
    tool: string;
    args: Record<string, unknown>;
    success: boolean;
    durationMs: number;
    mode?: "playwright" | "chrome"; // Which browser backend was used
}

interface BrowsingStrategy {
    id: string;
    taskPattern: string; // e.g. "search product on amazon", "login to site"
    domain: string; // e.g. "amazon.in", "google.com"
    steps: BrowsingStep[];
    totalDurationMs: number;
    successRate: number;
    timesUsed: number;
    lastUsed: string;
    notes: string; // LLM-generated tips
    version: number; // increments on each update
    createdAt: string; // when first created
}

interface DomainTipEntry {
    tip: string;
    addedAt: string;
}

interface StrategyStore {
    strategies: BrowsingStrategy[];
    domainTips: Record<string, DomainTipEntry[] | string[]>; // domain → tips (supports legacy string[] format)
}

// ── Constants ─────────────────────────────────

const STORE_PATH = path.join(process.env.BHAI_DATA_DIR || path.resolve("data"), "browser-strategies.json");
const STALE_DAYS = 30; // warn after 30 days
const EXPIRED_DAYS = 90; // auto-prune after 90 days (if low success)
const TIP_STALE_DAYS = 60; // warn for tips
const TIP_EXPIRED_DAYS = 120; // auto-prune tips

let store: StrategyStore = { strategies: [], domainTips: {} };
let strategyCounter = 0;

// ── Active Session Tracker ────────────────────
// Automatically tracks browser tool calls during a session

interface ActiveSession {
    domain: string;
    steps: BrowsingStep[];
    startTime: number;
    toolErrors: number;
    toolSuccesses: number;
}

let activeSession: ActiveSession | null = null;

// ── Initialize ────────────────────────────────

export function initBrowserMemory(): void {
    try {
        if (fs.existsSync(STORE_PATH)) {
            store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            // Migrate legacy string[] domainTips → DomainTipEntry[]
            for (const [domain, tips] of Object.entries(store.domainTips)) {
                if (tips.length > 0 && typeof tips[0] === "string") {
                    store.domainTips[domain] = (tips as string[]).map((t) => ({
                        tip: t,
                        addedAt: new Date().toISOString(),
                    }));
                }
            }
            // Migrate old strategies missing version/createdAt
            for (const s of store.strategies) {
                if (s.version === undefined) s.version = 1;
                if (!s.createdAt) s.createdAt = s.lastUsed || new Date().toISOString();
            }
            strategyCounter = store.strategies.length;
            // Prune expired strategies on load
            pruneExpiredStrategies();
            pruneExpiredTips();
            console.log(`🌐 Browser memory loaded: ${store.strategies.length} strategies`);
        }
    } catch {
        store = { strategies: [], domainTips: {} };
    }
}

function saveStore(): void {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ── Prune Expired Strategies ──────────────────

function pruneExpiredStrategies(): void {
    const now = Date.now();
    const before = store.strategies.length;
    store.strategies = store.strategies.filter((s) => {
        const daysSince = (now - new Date(s.lastUsed).getTime()) / 86_400_000;
        // Keep if: recent enough, OR high success rate, OR frequently used
        if (daysSince < EXPIRED_DAYS) return true;
        if (s.successRate >= 0.5 && s.timesUsed >= 3) return true;
        return false;
    });
    const pruned = before - store.strategies.length;
    if (pruned > 0) {
        console.log(`🗑️ Pruned ${pruned} expired browser strategies`);
        saveStore();
    }
}

function pruneExpiredTips(): void {
    const now = Date.now();
    let changed = false;
    for (const [domain, tips] of Object.entries(store.domainTips)) {
        const entries = tips as DomainTipEntry[];
        const filtered = entries.filter((t) => {
            if (!t.addedAt) return true;
            const daysSince = (now - new Date(t.addedAt).getTime()) / 86_400_000;
            return daysSince < TIP_EXPIRED_DAYS;
        });
        if (filtered.length < entries.length) {
            store.domainTips[domain] = filtered;
            changed = true;
        }
        if (filtered.length === 0) {
            delete store.domainTips[domain];
            changed = true;
        }
    }
    if (changed) saveStore();
}

// ── Auto Session Tracking ─────────────────────

/** Call this after each browser tool execution */
export function trackBrowserStep(
    tool: string,
    args: Record<string, unknown>,
    success: boolean,
    durationMs: number,
): void {
    // Detect domain from browser_navigate
    if (tool === "browser_navigate" && args.url) {
        try {
            const url = new URL(args.url as string);
            const domain = url.hostname;
            if (!activeSession || activeSession.domain !== domain) {
                // New session or domain changed — save old session first
                if (activeSession && activeSession.steps.length > 0) {
                    finalizeSession();
                }
                activeSession = {
                    domain,
                    steps: [],
                    startTime: Date.now(),
                    toolErrors: 0,
                    toolSuccesses: 0,
                };
                console.log(`  🌐 [auto-track] New browser session on ${domain}`);
            }
        } catch {
            /* invalid URL, ignore */
        }
    }

    if (!activeSession) {
        // First browser action without navigate — create a generic session
        activeSession = {
            domain: "unknown",
            steps: [],
            startTime: Date.now(),
            toolErrors: 0,
            toolSuccesses: 0,
        };
    }

    // Compact args for storage (don't store huge JS code or base64)
    const compactArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string" && v.length > 200) {
            compactArgs[k] = (v as string).substring(0, 100) + "…";
        } else {
            compactArgs[k] = v;
        }
    }

    // Track which browser backend was used for this step
    let browserMode: "playwright" | "chrome" | undefined;
    try {
        const mode = getCurrentMode();
        if (mode === "playwright" || mode === "chrome") browserMode = mode;
    } catch {
        /* backend manager not loaded */
    }

    activeSession.steps.push({ tool, args: compactArgs, success, durationMs, mode: browserMode });
    if (success) activeSession.toolSuccesses++;
    else activeSession.toolErrors++;
}

/** Call when agent finishes to auto-save the session strategy */
export function autoSaveSession(): void {
    if (!activeSession || activeSession.steps.length === 0) return;
    finalizeSession();
}

function finalizeSession(): void {
    if (!activeSession || activeSession.steps.length < 2) {
        activeSession = null;
        return;
    }

    const domain = activeSession.domain;
    const totalMs = Date.now() - activeSession.startTime;
    const successRate = activeSession.toolSuccesses / Math.max(1, activeSession.steps.length);

    // Auto-generate task pattern from the tools used
    const toolSet = [...new Set(activeSession.steps.map((s) => s.tool))];
    const hasForm = activeSession.steps.some(
        (s) => s.tool === "browser_type" || s.tool === "browser_select" || s.tool === "browser_click_at",
    );
    const hasExtract = activeSession.steps.some((s) => s.tool === "browser_extract" || s.tool === "browser_run_js");

    let taskType = "browse";
    if (hasForm) taskType = "interact with form on";
    else if (hasExtract) taskType = "extract data from";
    const taskPattern = `${taskType} ${domain}`;

    // Auto-generate tips from failure patterns
    const tips: string[] = [];
    const failedTools = activeSession.steps.filter((s) => !s.success);
    if (failedTools.length > 0) {
        const failedToolNames = [...new Set(failedTools.map((s) => s.tool))];
        tips.push(`Tools that failed: ${failedToolNames.join(", ")} — try alternative approaches next time`);
    }
    if (activeSession.steps.some((s) => s.tool === "browser_run_js" && !s.success)) {
        tips.push("browser_run_js failed — prefer individual browser_click_at with label IDs");
    }
    if (activeSession.steps.length > 30) {
        tips.push(`Task took ${activeSession.steps.length} steps — look for shortcuts next time`);
    }

    // Keep steps compact — only store the last 20 steps
    const stepsToSave = activeSession.steps.slice(-20);

    // Record strategy
    const existing = store.strategies.find((s) => s.domain === domain && s.taskPattern === taskPattern);

    if (existing) {
        existing.timesUsed++;
        existing.lastUsed = new Date().toISOString();
        existing.version = (existing.version || 1) + 1;
        // Update if this session was better
        if (successRate > existing.successRate || totalMs < existing.totalDurationMs) {
            existing.steps = stepsToSave;
            existing.totalDurationMs = totalMs;
            existing.successRate = successRate;
        }
        // Merge tips
        for (const tip of tips) {
            if (!existing.notes.includes(tip)) {
                existing.notes = existing.notes ? `${existing.notes}; ${tip}` : tip;
            }
        }
    } else {
        store.strategies.push({
            id: `strat_${++strategyCounter}`,
            taskPattern,
            domain,
            steps: stepsToSave,
            totalDurationMs: totalMs,
            successRate,
            timesUsed: 1,
            lastUsed: new Date().toISOString(),
            notes: tips.join("; "),
            version: 1,
            createdAt: new Date().toISOString(),
        });
    }

    // Keep store bounded
    if (store.strategies.length > 100) {
        store.strategies.sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime());
        store.strategies = store.strategies.slice(0, 100);
    }

    saveStore();
    console.log(
        `  💾 [auto-save] Browser strategy saved for "${taskPattern}" (${activeSession.steps.length} steps, ${(successRate * 100).toFixed(0)}% success)`,
    );

    activeSession = null;
}

// ── Record a Browsing Session (manual) ────────

export function recordStrategy(taskPattern: string, domain: string, steps: BrowsingStep[], notes: string): string {
    const id = `strat_${++strategyCounter}`;
    const totalMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
    const successCount = steps.filter((s) => s.success).length;
    const rate = steps.length ? successCount / steps.length : 0; // 0/0 was NaN: it never matched again

    const existing = store.strategies.find((s) => s.taskPattern === taskPattern && s.domain === domain);

    if (existing) {
        existing.timesUsed++;
        existing.lastUsed = new Date().toISOString();
        existing.version = (existing.version || 1) + 1;
        if (totalMs < existing.totalDurationMs || rate > existing.successRate) {
            existing.steps = steps;
            existing.totalDurationMs = totalMs;
            existing.successRate = rate;
            existing.notes = notes;
        }
        saveStore();
        return existing.id;
    }

    const strategy: BrowsingStrategy = {
        id,
        taskPattern,
        domain,
        steps,
        totalDurationMs: totalMs,
        successRate: rate,
        timesUsed: 1,
        lastUsed: new Date().toISOString(),
        notes,
        version: 1,
        createdAt: new Date().toISOString(),
    };

    store.strategies.push(strategy);
    saveStore();
    return id;
}

// ── Find Best Strategy ────────────────────────

// Words that say nothing about which site or task: "from" matched every "extract data from …".
const STRATEGY_STOP = new Set(
    "about after also been from have here into just know like make more need only please some than that them then there they this what when where which while with would your".split(" "),
);
const strategyWords = (text: string): string[] =>
    (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]*/gu) ?? [])
        // A site counts by its name too: the owner says "smartprix", the pattern has www.smartprix.com.
        .flatMap((w) => (w.includes(".") ? [w, w.replace(/^www\./, "").split(".")[0]] : [w]))
        .filter((w) => w.length > 3 && !STRATEGY_STOP.has(w));

export function findStrategy(task: string, domain?: string): BrowsingStrategy | null {
    const keywords = strategyWords(task);
    const now = Date.now();

    let bestMatch: BrowsingStrategy | null = null;
    let bestScore = 0;

    for (const strategy of store.strategies) {
        const daysSinceUse = (now - new Date(strategy.lastUsed).getTime()) / 86_400_000;

        // Skip fully expired strategies with low success
        if (daysSinceUse > EXPIRED_DAYS && strategy.successRate < 0.5) continue;

        let score = 0;
        const patternWords = new Set(strategyWords(strategy.taskPattern));

        // Keyword matching: whole words ("know" isn't in "unknown"), two of them at least
        for (const kw of keywords) {
            if (patternWords.has(kw)) score += 2;
        }

        // Domain match bonus
        const domainMatch = !!domain && strategy.domain === domain;
        if (domainMatch) score += 5;
        // Relevance first: the bonuses below alone used to clear the bar, so a
        // saved strategy was offered for every message, even "hello".
        if (score < 4 && !domainMatch) continue;

        // Success rate bonus
        score += strategy.successRate * 3;

        // Recency bonus / staleness penalty
        if (daysSinceUse < 7) score += 3;
        else if (daysSinceUse < STALE_DAYS) score += 1;
        else if (daysSinceUse > STALE_DAYS) score -= 2; // stale penalty

        // Usage frequency bonus
        score += Math.min(strategy.timesUsed, 5);

        if (score > bestScore) {
            bestScore = score;
            bestMatch = strategy;
        }
    }

    return bestScore > 3 ? bestMatch : null;
}

// ── Domain Tips ───────────────────────────────

export function addDomainTip(domain: string, tip: string): void {
    if (!store.domainTips[domain]) store.domainTips[domain] = [];
    const entries = store.domainTips[domain] as DomainTipEntry[];
    if (!entries.some((e) => (typeof e === "string" ? e : e.tip) === tip)) {
        entries.push({ tip, addedAt: new Date().toISOString() });
        if (entries.length > 10) entries.shift();
        saveStore();
    }
}

export function getDomainTips(domain: string): string[] {
    const entries = store.domainTips[domain];
    if (!entries) return [];
    return entries.map((e) => (typeof e === "string" ? e : e.tip));
}

// ── Get Context for Agent ─────────────────────

export function getBrowserContext(task: string): string {
    const parts: string[] = [];
    const now = Date.now();

    // Find matching strategy
    const strategy = findStrategy(task);
    if (strategy) {
        const daysSince = (now - new Date(strategy.lastUsed).getTime()) / 86_400_000;
        const staleWarning =
            daysSince > STALE_DAYS
                ? `\n   ⚠️ This strategy is ${Math.round(daysSince)} days old — the site may have changed. Verify each step works.`
                : "";

        parts.push(`📋 PREVIOUS STRATEGY FOUND for similar task "${strategy.taskPattern}":`);
        parts.push(
            `   Domain: ${strategy.domain} | Success rate: ${(strategy.successRate * 100).toFixed(0)}% | Used ${strategy.timesUsed}x | v${strategy.version || 1}${staleWarning}`,
        );
        parts.push(`   Steps:`);
        for (const step of strategy.steps) {
            parts.push(
                `   - ${step.tool}(${JSON.stringify(step.args)}) → ${step.success ? "✅" : "❌"} (${step.durationMs}ms)`,
            );
        }
        if (strategy.notes) {
            parts.push(`   Tips: ${strategy.notes}`);
        }
    }

    // Check domain tips from all known domains
    for (const [domain, tips] of Object.entries(store.domainTips)) {
        if (task.toLowerCase().includes(domain.split(".")[0])) {
            const entries = tips as DomainTipEntry[];
            const activeTips = entries.map((e) => {
                const t = typeof e === "string" ? e : e.tip;
                const addedAt = typeof e === "string" ? null : e.addedAt;
                if (addedAt) {
                    const daysOld = (now - new Date(addedAt).getTime()) / 86_400_000;
                    if (daysOld > TIP_STALE_DAYS) return `${t} (⚠️ ${Math.round(daysOld)}d old — may be outdated)`;
                }
                return t;
            });

            if (activeTips.length > 0) {
                parts.push(`\n🌐 Tips for ${domain}:`);
                for (const tip of activeTips) {
                    parts.push(`   - ${tip}`);
                }
            }
        }
    }

    return parts.join("\n");
}

// ── Get All Strategies ────────────────────────

export function getAllStrategies(): BrowsingStrategy[] {
    return store.strategies;
}
