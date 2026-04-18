// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Relationship State Modeling ────────────────
// Tracks trust, engagement, and depth of the user-AI relationship.
// Modulates tone: low trust → formal, high trust → relaxed.

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface RelationshipState {
    user_id: string;
    trust_score: number;           // 0–1
    engagement_streak: number;     // consecutive active days
    depth_score: number;           // 0–1
    last_interaction: string;
}

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;
let _cache: RelationshipState | null = null;
const DEFAULT_USER = "default";

// ── Initialize ────────────────────────────────

export function initRelationshipState(db: Database): void {
    _db = db;

    const existing = db.exec("SELECT user_id FROM relationship_state WHERE user_id = ?", [DEFAULT_USER]);
    if (existing.length === 0 || existing[0].values.length === 0) {
        db.run("INSERT INTO relationship_state (user_id) VALUES (?)", [DEFAULT_USER]);
    }

    _cache = null;
    console.log("🤝 Relationship state initialized");
}

// ── Get ───────────────────────────────────────

export function getRelationshipState(userId = DEFAULT_USER): RelationshipState {
    if (_cache && _cache.user_id === userId) return _cache;
    if (!_db) return defaultState(userId);

    const results = _db.exec(
        `SELECT user_id, trust_score, engagement_streak, depth_score, last_interaction
         FROM relationship_state WHERE user_id = ?`,
        [userId]
    );

    if (results.length === 0 || results[0].values.length === 0) return defaultState(userId);

    const row = results[0].values[0];
    _cache = {
        user_id: row[0] as string,
        trust_score: row[1] as number,
        engagement_streak: row[2] as number,
        depth_score: row[3] as number,
        last_interaction: row[4] as string,
    };

    return _cache;
}

// ── Update After Session ──────────────────────

/**
 * Called after each session to update relationship metrics.
 */
export function updateRelationshipAfterSession(
    sessionTurnCount: number,
    hadEmotionalSignals: boolean,
    hadEpisodicSignals: boolean,
    userId = DEFAULT_USER
): RelationshipState {
    if (!_db) return defaultState(userId);

    const current = getRelationshipState(userId);
    const now = new Date();
    const lastDate = new Date(current.last_interaction);

    // Engagement streak: increment if same or next day, reset if gap > 1 day
    const daysSinceLast = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
    let streak = current.engagement_streak;
    if (daysSinceLast < 2) {
        streak++;
    } else if (daysSinceLast > 2) {
        streak = 1; // Reset
    }

    // Trust grows slowly with consistent usage
    const trustDelta = 0.005 * Math.min(streak, 10) + (sessionTurnCount > 10 ? 0.01 : 0.005);
    const trustScore = Math.min(1.0, current.trust_score + trustDelta);

    // Depth increases with emotional + episodic signals
    let depthDelta = 0.005;
    if (hadEmotionalSignals) depthDelta += 0.02;
    if (hadEpisodicSignals) depthDelta += 0.015;
    const depthScore = Math.min(1.0, current.depth_score + depthDelta);

    const next: RelationshipState = {
        user_id: userId,
        trust_score: trustScore,
        engagement_streak: streak,
        depth_score: depthScore,
        last_interaction: now.toISOString(),
    };

    _db.run(
        `UPDATE relationship_state
         SET trust_score = ?, engagement_streak = ?, depth_score = ?, last_interaction = datetime('now')
         WHERE user_id = ?`,
        [next.trust_score, next.engagement_streak, next.depth_score, userId]
    );

    _cache = next;
    return next;
}

// ── Prompt Snippet ────────────────────────────

export function getRelationshipSnippet(userId = DEFAULT_USER): string {
    const state = getRelationshipState(userId);

    // Only inject when meaningful
    if (state.trust_score < 0.3 && state.depth_score < 0.2) return "";

    const parts: string[] = [];

    if (state.trust_score > 0.7) {
        parts.push("- High trust established — use confident, relaxed tone");
    } else if (state.trust_score > 0.4) {
        parts.push("- Building trust — be helpful and precise");
    }

    if (state.engagement_streak > 5) {
        parts.push(`- Active streak: ${state.engagement_streak} sessions`);
    }

    if (state.depth_score > 0.5) {
        parts.push("- Deep relationship — natural callbacks and anticipation appropriate");
    }

    if (parts.length === 0) return "";
    return "🤝 RELATIONSHIP STATE:\n" + parts.join("\n");
}

// ── Can Trigger Initiative? ───────────────────

/**
 * Returns true if the relationship is deep enough for proactive suggestions.
 */
export function canTriggerInitiative(userId = DEFAULT_USER): boolean {
    const state = getRelationshipState(userId);
    return state.depth_score > 0.6 || (state.trust_score > 0.7 && state.depth_score > 0.6);
}

// ── Helpers ───────────────────────────────────

function defaultState(userId: string): RelationshipState {
    return {
        user_id: userId,
        trust_score: 0.3,
        engagement_streak: 0,
        depth_score: 0.1,
        last_interaction: new Date().toISOString(),
    };
}
