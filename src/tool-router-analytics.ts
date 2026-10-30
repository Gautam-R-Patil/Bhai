// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Router Analytics ─────────────────────────
// Learns which tools the owner uses for each intent (and what follows what),
// plus the pre-defined task chains that preload categories.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────

interface UserToolPreferences {
    // intent → tool usage counts (e.g. "music_playback" → {"spotify": 47, "music_control": 2})
    intentToolMap: Record<string, Record<string, number>>;
    // tool → follow-up tools with counts (e.g. "spotify" → {"web_search": 12})
    followUpPatterns: Record<string, Record<string, number>>;
    // Timestamps for decay calculation
    intentToolTimestamps: Record<string, Record<string, number>>; // intent → tool → last_used_ts
}

interface AnalyticsData {
    // User tool preferences (personalization)
    preferences: UserToolPreferences;
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
const SAVE_DEBOUNCE_MS = 5000;

let data: AnalyticsData = {
    preferences: {
        intentToolMap: {},
        followUpPatterns: {},
        intentToolTimestamps: {},
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
            // Files written before v3 have no preferences; older fields are ignored.
            data = {
                preferences: { intentToolMap: {}, followUpPatterns: {}, intentToolTimestamps: {}, ...loaded.preferences },
                version: 3,
            };
            console.log(`📊 Tool Analytics: Loaded ${Object.keys(data.preferences.intentToolMap).length} learned intents`);
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

// ── Get Likely Needed Categories ──────────────

export function getLikelyCategories(selectedCategories: string[]): string[] {
    for (const chainCategories of Object.values(COMMON_TASK_CHAINS)) {
        const overlap = selectedCategories.filter(c => chainCategories.includes(c));
        if (overlap.length >= 2) {
            // User is likely doing this task chain — return missing categories
            const missing = chainCategories.filter(c => !selectedCategories.includes(c));
            if (missing.length > 0) {
                return missing;
            }
        }
    }

    return [];
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
