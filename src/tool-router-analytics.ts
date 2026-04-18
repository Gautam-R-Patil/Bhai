// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Router Analytics ─────────────────────────
// Tracks tool usage patterns to improve future selections:
// - Co-occurrence matrix: which tools are used together
// - Tool success rates: which tools complete without errors
// - Common task chains: pre-defined + learned workflows

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────

interface ToolUsageRecord {
    toolsUsed: string[];
    categories: string[];
    timestamp: number;
    success: boolean;
}

interface ToolFailurePattern {
    tool: string;
    failureCount: number;
    totalAttempts: number;
    lastFailure: number;
    lastSuccess: number;
    recoveryStrategy?: string;  // what worked after this tool failed
    recoveryTool?: string;      // e.g. "os_click_element"
}

interface UserToolPreferences {
    // intent → tool usage counts (e.g. "music_playback" → {"spotify": 47, "music_control": 2})
    intentToolMap: Record<string, Record<string, number>>;
    // tool → follow-up tools with timestamps (e.g. "spotify" → {"web_search": 12})
    followUpPatterns: Record<string, Record<string, number>>;
    // Category affinity scores — decaying average reflecting user's most-used categories
    categoryAffinity: Record<string, number>;
    // Timestamps for decay calculation
    intentToolTimestamps: Record<string, Record<string, number>>; // intent → tool → last_used_ts
    // Tool failure tracking — learn which tools are unreliable and what recoveries work
    toolFailures: Record<string, ToolFailurePattern>;
}

interface CoOccurrenceData {
    // tool -> other tools used in same session
    matrix: Record<string, Record<string, number>>;
    // How many times each tool has been used
    toolCounts: Record<string, number>;
    // Success rate per tool
    toolSuccess: Record<string, { success: number; total: number }>;
    // Last 100 usage records for analysis
    recentUsage: ToolUsageRecord[];
    // User tool preferences (personalization)
    preferences: UserToolPreferences;
    // Version for future migrations
    version: number;
}

// ── Pre-defined Task Chains ────────────────────
// Common multi-step workflows that should preload tools

export const COMMON_TASK_CHAINS: Record<string, string[]> = {
    // Research flows
    "web_research": ["web_search", "browser", "file_system"],
    "deep_investigation": ["web_search", "browser", "research", "file_system"],

    // Coding flows
    "code_project": ["shell", "file_system", "browser"],
    "build_website": ["shell", "file_system", "browser", "long_tasks"],
    "fix_bug": ["shell", "file_system"],

    // Media flows
    "create_content": ["browser", "media", "file_system"],
    "music_session": ["media", "web_search"],
    "audio_analysis": ["media", "file_system"],
    "smart_home_audio": ["media", "web_search"],
    "note_taking": ["scheduling", "web_search", "file_system"],

    // Automation flows
    "system_automation": ["os_control", "shell", "app_management"],
    "scheduled_task": ["scheduling", "shell", "communication"],

    // Communication flows
    "email_workflow": ["google_api", "communication", "file_system"],
    "meeting_prep": ["google_api", "scheduling", "web_search"],

    // Quick lookup flows
    "weather_check": ["web_search"],

    // Document flows (resumes, cover letters, reports)
    // Include `communication` so send_file is in the bundle for delivering the export.
    "resume_workflow": ["document", "communication", "file_system"],
    "cover_letter_workflow": ["document", "communication", "file_system"],
    "document_export": ["document", "communication"],
};

// ── State ─────────────────────────────────────

const DATA_DIR = join(homedir(), ".atlas", "data");
const ANALYTICS_FILE = join(DATA_DIR, "tool-analytics.json");
const MAX_RECENT_USAGE = 100;
const SAVE_DEBOUNCE_MS = 5000;

let data: CoOccurrenceData = {
    matrix: {},
    toolCounts: {},
    toolSuccess: {},
    recentUsage: [],
    preferences: {
        intentToolMap: {},
        followUpPatterns: {},
        categoryAffinity: {},
        intentToolTimestamps: {},
        toolFailures: {},
    },
    version: 3,
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// ── Initialize ────────────────────────────────

export function initAnalytics(): void {
    if (initialized) return;

    try {
        mkdirSync(DATA_DIR, { recursive: true });

        if (existsSync(ANALYTICS_FILE)) {
            const raw = readFileSync(ANALYTICS_FILE, "utf-8");
            const loaded = JSON.parse(raw);
            // Migrate v1/v2 → v3: add preferences + toolFailures if missing
            if (!loaded.preferences) {
                loaded.preferences = {
                    intentToolMap: {},
                    followUpPatterns: {},
                    categoryAffinity: {},
                    intentToolTimestamps: {},
                    toolFailures: {},
                };
            }
            if (!loaded.preferences.toolFailures) {
                loaded.preferences.toolFailures = {};
            }
            loaded.version = 3;
            data = loaded;
            console.log(`📊 Tool Analytics: Loaded ${Object.keys(data.matrix).length} tool patterns, ${Object.keys(data.preferences.intentToolMap).length} learned intents`);
        } else {
            console.log(`📊 Tool Analytics: Starting fresh`);
        }
    } catch (err) {
        console.warn(`📊 Tool Analytics: Failed to load, starting fresh:`, (err as Error).message);
    }

    initialized = true;
}

// ── Save (debounced) ──────────────────────────

function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
        } catch (err) {
            console.warn(`📊 Tool Analytics: Failed to save:`, (err as Error).message);
        }
    }, SAVE_DEBOUNCE_MS);
}

// ── Record Tool Usage ─────────────────────────

export function recordToolUsage(opts: {
    toolsUsed: string[];
    categories: string[];
    success?: boolean;
}): void {
    if (!initialized) initAnalytics();

    const { toolsUsed, categories, success = true } = opts;
    if (toolsUsed.length === 0) return;

    // Update co-occurrence matrix
    for (const tool of toolsUsed) {
        if (!data.matrix[tool]) data.matrix[tool] = {};
        if (!data.toolCounts[tool]) data.toolCounts[tool] = 0;
        if (!data.toolSuccess[tool]) data.toolSuccess[tool] = { success: 0, total: 0 };

        data.toolCounts[tool]++;
        data.toolSuccess[tool].total++;
        if (success) data.toolSuccess[tool].success++;

        // Record co-occurrence with other tools in this session
        for (const otherTool of toolsUsed) {
            if (otherTool !== tool) {
                data.matrix[tool][otherTool] = (data.matrix[tool][otherTool] || 0) + 1;
            }
        }
    }

    // Add to recent usage
    data.recentUsage.push({
        toolsUsed,
        categories,
        timestamp: Date.now(),
        success,
    });

    // Trim to max size
    if (data.recentUsage.length > MAX_RECENT_USAGE) {
        data.recentUsage = data.recentUsage.slice(-MAX_RECENT_USAGE);
    }

    scheduleSave();
}

// ── Get Co-occurring Tools ────────────────────

export function getCoOccurringTools(tool: string, minCount: number = 3): string[] {
    if (!initialized) initAnalytics();
    if (!data.matrix[tool]) return [];

    const coOccurring = Object.entries(data.matrix[tool])
        .filter(([_, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1])
        .map(([t, _]) => t);

    return coOccurring;
}

// ── Get Likely Needed Categories ──────────────

export function getLikelyCategories(selectedCategories: string[]): string[] {
    if (!initialized) initAnalytics();

    // Check pre-defined chains first
    for (const [chainName, chainCategories] of Object.entries(COMMON_TASK_CHAINS)) {
        const overlap = selectedCategories.filter(c => chainCategories.includes(c));
        if (overlap.length >= 2) {
            // User is likely doing this task chain — return missing categories
            const missing = chainCategories.filter(c => !selectedCategories.includes(c));
            if (missing.length > 0) {
                return missing;
            }
        }
    }

    // Analyze recent usage patterns
    const recentWithSameCategories = data.recentUsage.filter(record => {
        const overlap = record.categories.filter(c => selectedCategories.includes(c));
        return overlap.length >= 1;
    });

    if (recentWithSameCategories.length < 3) return [];

    // Find categories that frequently appear with selected ones
    const categoryCounts: Record<string, number> = {};
    for (const record of recentWithSameCategories) {
        for (const cat of record.categories) {
            if (!selectedCategories.includes(cat)) {
                categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            }
        }
    }

    // Return categories that appear in >30% of matching sessions
    const threshold = recentWithSameCategories.length * 0.3;
    return Object.entries(categoryCounts)
        .filter(([_, count]) => count >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)  // Max 2 preloaded categories
        .map(([cat, _]) => cat);
}

// ── Get Tool Success Rate ─────────────────────

export function getToolSuccessRate(tool: string): number {
    if (!initialized) initAnalytics();
    const stats = data.toolSuccess[tool];
    if (!stats || stats.total === 0) return 1.0; // Assume good until proven otherwise
    return stats.success / stats.total;
}

// ── Get Most Used Tools ───────────────────────

export function getMostUsedTools(limit: number = 10): { tool: string; count: number }[] {
    if (!initialized) initAnalytics();

    return Object.entries(data.toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tool, count]) => ({ tool, count }));
}

// ── Detect Task Chain ─────────────────────────

export function detectTaskChain(message: string): string | null {
    const lower = message.toLowerCase();

    // Simple pattern matching for common task types
    if (lower.includes("research") && (lower.includes("deep") || lower.includes("investigate") || lower.includes("thorough"))) {
        return "deep_investigation";
    }
    if (lower.includes("search") && (lower.includes("web") || lower.includes("google") || lower.includes("look up"))) {
        return "web_research";
    }
    if (lower.includes("build") && (lower.includes("website") || lower.includes("site") || lower.includes("app"))) {
        return "build_website";
    }
    if (lower.includes("code") || lower.includes("program") || lower.includes("develop")) {
        return "code_project";
    }
    if (lower.includes("fix") && (lower.includes("bug") || lower.includes("error") || lower.includes("issue"))) {
        return "fix_bug";
    }
    if (lower.includes("music") || lower.includes("spotify") || lower.includes("play")) {
        return "music_session";
    }
    if (lower.includes("email") || lower.includes("gmail")) {
        return "email_workflow";
    }
    if (lower.includes("meeting") || lower.includes("calendar")) {
        return "meeting_prep";
    }
    if (lower.includes("automate") || lower.includes("script") || lower.includes("shortcut")) {
        return "system_automation";
    }
    if (lower.includes("weather") || lower.includes("forecast") || lower.includes("temperature")) {
        return "weather_check";
    }
    if (lower.includes("note") && (lower.includes("create") || lower.includes("write") || lower.includes("add") || lower.includes("make") || lower.includes("take"))) {
        return "note_taking";
    }
    if (lower.includes("gif") || lower.includes("meme")) {
        return "create_content";
    }
    if (lower.includes("sonos") || lower.includes("speaker")) {
        return "smart_home_audio";
    }
    // Document/resume flows — detected before generic "make/write" so they
    // pre-load the `document` category instead of falling through to file_system.
    if (/\b(cover.?letter|cover letter)\b/.test(lower)) {
        return "cover_letter_workflow";
    }
    if (/\b(resume|resumé|curriculum vitae|\bcv\b)\b/.test(lower)) {
        return "resume_workflow";
    }
    if (/\b(export.*(pdf|docx|word)|render (to|as) pdf|save as pdf)\b/.test(lower)) {
        return "document_export";
    }

    return null;
}

// ── Get Categories for Task Chain ─────────────

export function getCategoriesForChain(chainName: string): string[] {
    return COMMON_TASK_CHAINS[chainName] || [];
}

// ── User Tool Preference Functions ──────────────
// Personalization layer — learns which tools the user prefers for each intent

const DECAY_HALF_LIFE_DAYS = 30; // Preferences halve in weight after 30 days

function decayWeight(count: number, lastUsedTs: number): number {
    const ageDays = (Date.now() - lastUsedTs) / (1000 * 60 * 60 * 24);
    return count * Math.exp(-0.693 * ageDays / DECAY_HALF_LIFE_DAYS); // ln(2) ≈ 0.693
}

/** Record which tools the user actually used for a given intent */
export function recordIntentToolUsage(intent: string, toolsUsed: string[]): void {
    if (!initialized) initAnalytics();
    if (!intent || toolsUsed.length === 0) return;

    const prefs = data.preferences;
    if (!prefs.intentToolMap[intent]) prefs.intentToolMap[intent] = {};
    if (!prefs.intentToolTimestamps[intent]) prefs.intentToolTimestamps[intent] = {};

    for (const tool of toolsUsed) {
        prefs.intentToolMap[intent][tool] = (prefs.intentToolMap[intent][tool] || 0) + 1;
        prefs.intentToolTimestamps[intent][tool] = Date.now();
    }

    // Track follow-up patterns (tool A used → tool B used in same session)
    for (let i = 0; i < toolsUsed.length; i++) {
        for (let j = i + 1; j < toolsUsed.length; j++) {
            if (!prefs.followUpPatterns[toolsUsed[i]]) prefs.followUpPatterns[toolsUsed[i]] = {};
            prefs.followUpPatterns[toolsUsed[i]][toolsUsed[j]] =
                (prefs.followUpPatterns[toolsUsed[i]][toolsUsed[j]] || 0) + 1;
        }
    }

    scheduleSave();
}

/** Get candidate tools sorted by user preference for a given intent */
export function getPreferredTools(intent: string, candidateTools: string[]): string[] {
    if (!initialized) initAnalytics();
    const prefs = data.preferences;
    const intentMap = prefs.intentToolMap[intent];
    if (!intentMap) return candidateTools;

    const timestamps = prefs.intentToolTimestamps[intent] || {};

    // Score each candidate by decayed usage count
    const scored = candidateTools.map(tool => {
        const count = intentMap[tool] || 0;
        const lastUsed = timestamps[tool] || 0;
        const weight = count > 0 ? decayWeight(count, lastUsed) : 0;
        return { tool, weight };
    });

    // Sort by weight descending, stable sort preserves original order for ties
    scored.sort((a, b) => b.weight - a.weight);
    return scored.map(s => s.tool);
}

/** Get tools the user typically uses after the given tools */
export function getFollowUpTools(currentTools: string[]): string[] {
    if (!initialized) initAnalytics();
    const prefs = data.preferences;
    const followUps: Record<string, number> = {};

    for (const tool of currentTools) {
        const patterns = prefs.followUpPatterns[tool];
        if (!patterns) continue;
        for (const [followTool, count] of Object.entries(patterns)) {
            if (count >= 3 && !currentTools.includes(followTool)) { // Min 3 co-occurrences
                followUps[followTool] = (followUps[followTool] || 0) + count;
            }
        }
    }

    return Object.entries(followUps)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3) // Max 3 follow-up tools
        .map(([tool]) => tool);
}

/** Update category affinity scores based on actual usage */
export function updateCategoryAffinity(categories: string[]): void {
    if (!initialized) initAnalytics();
    const prefs = data.preferences;
    const ALPHA = 0.1; // Exponential moving average factor

    for (const cat of categories) {
        const current = prefs.categoryAffinity[cat] || 0;
        prefs.categoryAffinity[cat] = current * (1 - ALPHA) + ALPHA;
    }

    // Decay unused categories
    for (const cat of Object.keys(prefs.categoryAffinity)) {
        if (!categories.includes(cat)) {
            prefs.categoryAffinity[cat] *= (1 - ALPHA * 0.5);
            if (prefs.categoryAffinity[cat] < 0.01) {
                delete prefs.categoryAffinity[cat];
            }
        }
    }

    scheduleSave();
}

/** Get user's category affinity scores */
export function getCategoryAffinity(): Record<string, number> {
    if (!initialized) initAnalytics();
    return { ...data.preferences.categoryAffinity };
}

// ── Tool Failure Tracking ────────────────────────
// Tracks which tools fail and what recovery strategies work

/** Record a tool failure */
export function recordToolFailure(tool: string, errorMsg: string): void {
    if (!initialized) initAnalytics();
    const prefs = data.preferences;
    if (!prefs.toolFailures[tool]) {
        prefs.toolFailures[tool] = { tool, failureCount: 0, totalAttempts: 0, lastFailure: 0, lastSuccess: 0 };
    }
    prefs.toolFailures[tool].failureCount++;
    prefs.toolFailures[tool].totalAttempts++;
    prefs.toolFailures[tool].lastFailure = Date.now();
    scheduleSave();
}

/** Record a tool success (to balance failure rate) */
export function recordToolSuccess(tool: string): void {
    if (!initialized) initAnalytics();
    const prefs = data.preferences;
    if (!prefs.toolFailures[tool]) {
        prefs.toolFailures[tool] = { tool, failureCount: 0, totalAttempts: 0, lastFailure: 0, lastSuccess: 0 };
    }
    prefs.toolFailures[tool].totalAttempts++;
    prefs.toolFailures[tool].lastSuccess = Date.now();
    scheduleSave();
}

/** Record what tool/strategy recovered after a failure */
export function recordToolRecovery(failedTool: string, recoveryTool: string, strategy: string): void {
    if (!initialized) initAnalytics();
    const prefs = data.preferences;
    if (prefs.toolFailures[failedTool]) {
        prefs.toolFailures[failedTool].recoveryTool = recoveryTool;
        prefs.toolFailures[failedTool].recoveryStrategy = strategy;
        scheduleSave();
        console.log(`📊 Recovery recorded: ${failedTool} → ${recoveryTool} ("${strategy}")`);
    }
}

/** Check if a tool should be skipped due to high failure rate (>70% in last 24h) */
export function shouldSkipTool(tool: string): boolean {
    if (!initialized) initAnalytics();
    const pattern = data.preferences.toolFailures[tool];
    if (!pattern || pattern.totalAttempts < 3) return false; // Need at least 3 attempts

    // Only consider recent failures (last 24 hours)
    const recentWindow = 24 * 60 * 60 * 1000;
    if (Date.now() - pattern.lastFailure > recentWindow) return false;

    const failRate = pattern.failureCount / pattern.totalAttempts;
    return failRate > 0.7;
}

/** Get recommended recovery strategy for a tool */
export function getRecommendedRecovery(tool: string): { recoveryTool?: string; strategy?: string } | null {
    if (!initialized) initAnalytics();
    const pattern = data.preferences.toolFailures[tool];
    if (!pattern || !pattern.recoveryTool) return null;
    return { recoveryTool: pattern.recoveryTool, strategy: pattern.recoveryStrategy };
}

/** Get failure rate for a tool (0-1) */
export function getToolFailureRate(tool: string): number {
    if (!initialized) initAnalytics();
    const pattern = data.preferences.toolFailures[tool];
    if (!pattern || pattern.totalAttempts === 0) return 0;
    return pattern.failureCount / pattern.totalAttempts;
}

/** Record user feedback (thumbs up/down) for the most recent task */
export function recordTaskFeedback(isGood: boolean): void {
    if (!initialized) initAnalytics();
    const recent = data.recentUsage[data.recentUsage.length - 1];
    if (!recent) return;

    // Mark the recent usage record with feedback
    (recent as any).feedback = isGood ? "good" : "bad";

    // If bad, reduce success rate for the tools used (penalize unreliable tools)
    if (!isGood) {
        for (const tool of recent.toolsUsed) {
            const stats = data.toolSuccess[tool];
            if (stats) {
                stats.success = Math.max(0, stats.success - 1);
            }
        }
    } else {
        // If good, boost the success rate
        for (const tool of recent.toolsUsed) {
            if (!data.toolSuccess[tool]) data.toolSuccess[tool] = { success: 0, total: 0 };
            data.toolSuccess[tool].success++;
        }
    }

    console.log(`📊 Feedback recorded: ${isGood ? "👍" : "👎"} for tools [${recent.toolsUsed.join(", ")}]`);
    scheduleSave();
}
