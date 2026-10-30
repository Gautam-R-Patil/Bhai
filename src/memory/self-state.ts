// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Self-State Layer ──────────────────────────
// Models the agent's internal cognitive state.
// Updated after sessions, during reflection, and during dream replay.
// Injected as subtle behavioral modifier (not shown explicitly to user).

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export type EngagementMode = "focused" | "exploratory" | "supportive";
export type EmotionalTone = "driven" | "stressed" | "excited" | "neutral" | "curious" | "frustrated";

export interface SelfState {
    user_id: string;
    energy_level: number;             // 0–1
    engagement_mode: EngagementMode;
    confidence_in_user_model: number; // 0–1
    relationship_depth: number;       // 0–1
    recent_emotional_tone: EmotionalTone;
    updated_at: string;
}

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;
let _cache: SelfState | null = null;
const DEFAULT_USER = "default";

// ── Initialize ────────────────────────────────

export function initSelfStateDB(db: Database): void {
    _db = db;

    // Ensure default row
    const existing = db.exec("SELECT user_id FROM self_state WHERE user_id = ?", [DEFAULT_USER]);
    if (existing.length === 0 || existing[0].values.length === 0) {
        db.run(
            `INSERT INTO self_state (user_id) VALUES (?)`,
            [DEFAULT_USER]
        );
    }

    _cache = null; // Force reload
    console.log("🧠 Self-state layer initialized");
}

// ── Get ───────────────────────────────────────

export function getSelfState(userId = DEFAULT_USER): SelfState {
    if (_cache && _cache.user_id === userId) return _cache;
    if (!_db) return defaultState(userId);

    const results = _db.exec(
        `SELECT user_id, energy_level, engagement_mode, confidence_in_user_model,
                relationship_depth, recent_emotional_tone, updated_at
         FROM self_state WHERE user_id = ?`,
        [userId]
    );

    if (results.length === 0 || results[0].values.length === 0) return defaultState(userId);

    const row = results[0].values[0];
    _cache = {
        user_id: row[0] as string,
        energy_level: row[1] as number,
        engagement_mode: (row[2] as EngagementMode) || "supportive",
        confidence_in_user_model: row[3] as number,
        relationship_depth: row[4] as number,
        recent_emotional_tone: (row[5] as EmotionalTone) || "neutral",
        updated_at: row[6] as string,
    };

    return _cache;
}

/** Invalidate the in-memory cache so the next getSelfState() re-reads from DB.
 * Call this after any external codepath (e.g. dream replay) modifies self_state directly. */
export function invalidateSelfStateCache(): void {
    _cache = null;
}

// ── Update ────────────────────────────────────

export function updateSelfState(updates: Partial<Omit<SelfState, "user_id" | "updated_at">>, userId = DEFAULT_USER): SelfState {
    if (!_db) return defaultState(userId);

    const current = getSelfState(userId);
    const next: SelfState = {
        ...current,
        ...updates,
        updated_at: new Date().toISOString(),
    };

    // Clamp numeric values
    next.energy_level = clamp(next.energy_level, 0, 1);
    next.confidence_in_user_model = clamp(next.confidence_in_user_model, 0, 1);
    next.relationship_depth = clamp(next.relationship_depth, 0, 1);

    _db.run(
        `INSERT OR REPLACE INTO self_state
         (user_id, energy_level, engagement_mode, confidence_in_user_model, relationship_depth, recent_emotional_tone, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [userId, next.energy_level, next.engagement_mode, next.confidence_in_user_model, next.relationship_depth, next.recent_emotional_tone]
    );

    _cache = next;
    return next;
}

// ── After-Session Update ──────────────────────

/**
 * Called after each session ends to adjust self-state based on session metrics.
 */
/**
 * Pure per-session deltas for the self-state, factored out so the dynamics are
 * testable without the DB. Note confDelta: confidence in the user model does
 * NOT only ever rise — a frustrated or stressed session is direct evidence the
 * model is off, so it pulls back. Without this, confidence saturated at 1.0 and
 * getSelfStateSnippet injected "high confidence — personalize confidently"
 * permanently, regardless of whether Bhai actually read the user right.
 */
export function computeSelfStateDeltas(
    turnCount: number,
    emotionalTone: EmotionalTone,
    currentMode: EngagementMode,
): { energyDelta: number; confDelta: number; depthDelta: number; mode: EngagementMode } {
    // Energy decays with long sessions, recovers on short ones.
    const energyDelta = turnCount > 20 ? -0.05 : turnCount > 10 ? -0.02 : 0.03;

    // Confidence tracks whether the session went well, not just how long it ran.
    const misread = emotionalTone === "frustrated" || emotionalTone === "stressed";
    const confDelta = misread ? -0.04 : Math.min(0.02, 0.005 * turnCount);

    // Relationship depth grows with engagement.
    const depthDelta = turnCount > 5 ? 0.01 : 0.005;

    // Engagement mode from tone.
    let mode: EngagementMode = currentMode;
    if (emotionalTone === "driven" || emotionalTone === "excited") mode = "focused";
    else if (emotionalTone === "curious") mode = "exploratory";
    else if (emotionalTone === "stressed" || emotionalTone === "frustrated") mode = "supportive";

    return { energyDelta, confDelta, depthDelta, mode };
}

export function updateSelfStateFromSession(
    turnCount: number,
    emotionalTone: EmotionalTone,
    userId = DEFAULT_USER
): SelfState {
    const current = getSelfState(userId);
    const { energyDelta, confDelta, depthDelta, mode } = computeSelfStateDeltas(
        turnCount,
        emotionalTone,
        current.engagement_mode,
    );

    return updateSelfState({
        energy_level: current.energy_level + energyDelta,
        engagement_mode: mode,
        confidence_in_user_model: current.confidence_in_user_model + confDelta,
        relationship_depth: current.relationship_depth + depthDelta,
        recent_emotional_tone: emotionalTone,
    }, userId);
}

// ── Prompt Snippet ────────────────────────────

/**
 * Returns subtle behavioral modifiers for the system prompt.
 * Not shown directly to user — influences AI's tone and approach.
 */
export function getSelfStateSnippet(userId = DEFAULT_USER): string {
    const state = getSelfState(userId);

    // Only inject meaningful modifiers
    const parts: string[] = [];

    if (state.engagement_mode !== "supportive") {
        parts.push(`- Engagement mode: ${state.engagement_mode}`);
    }
    if (state.confidence_in_user_model > 0.6) {
        parts.push(`- User model confidence: high — personalize responses confidently`);
    }
    if (state.recent_emotional_tone !== "neutral") {
        parts.push(`- Recent emotional context: ${state.recent_emotional_tone} — adapt tone accordingly`);
    }

    if (parts.length === 0) return "";
    return "🎭 INTERNAL STATE (behavioral modifiers, not visible to user):\n" + parts.join("\n");
}

// ── Helpers ───────────────────────────────────

function defaultState(userId: string): SelfState {
    return {
        user_id: userId,
        energy_level: 0.7,
        engagement_mode: "supportive",
        confidence_in_user_model: 0.3,
        relationship_depth: 0.1,
        recent_emotional_tone: "neutral",
        updated_at: new Date().toISOString(),
    };
}

function clamp(val: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, val));
}
