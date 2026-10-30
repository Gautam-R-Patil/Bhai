// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

// ── Engagement Streak ─────────────────────────

/**
 * Consecutive-active-DAY streak. Counts calendar days, not sessions:
 * +1 only on the next calendar day, unchanged for same-day sessions (so ten
 * chats in one hour don't inflate it), reset to 1 after a gap of ≥ 2 days.
 * The old `< 2 / > 2` form left a dead-zone at exactly 2.0 days and counted
 * every session, contradicting "consecutive active days".
 */
export function nextEngagementStreak(current: number, lastInteraction: string, now: Date = new Date()): number {
    const last = new Date(lastInteraction);
    if (Number.isNaN(last.getTime())) return 1;
    const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((dayStart(now) - dayStart(last)) / (1000 * 60 * 60 * 24));
    if (dayDiff === 1) return current + 1; // consecutive day
    if (dayDiff >= 2) return 1;            // gap — reset
    return current;                        // same day, or clock skew
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

    const streak = nextEngagementStreak(current.engagement_streak, current.last_interaction, now);

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

const STREAK_MILESTONES = [7, 30, 100];

/**
 * The milestone due today that was never offered before: a 7/30/100-day
 * streak, or a first-chat anniversary (within a week after it).
 */
export function pickMilestone(
    streak: number,
    firstChat: string | null,
    said: string[],
    now: Date = new Date(),
): { key: string; line: string } | null {
    if (STREAK_MILESTONES.includes(streak) && !said.includes(`streak_${streak}`)) {
        return { key: `streak_${streak}`, line: `${streak} days in a row with them` };
    }
    if (!firstChat) return null;
    // SQLite's datetime('now') is UTC without a zone marker.
    const first = new Date(firstChat.includes("T") ? firstChat : `${firstChat.replace(" ", "T")}Z`);
    const days = (now.getTime() - first.getTime()) / (1000 * 60 * 60 * 24);
    const years = Math.floor(days / 365.25);
    if (years >= 1 && days - years * 365.25 < 7 && !said.includes(`year_${years}`)) {
        return {
            key: `year_${years}`,
            line: `${years === 1 ? "a year" : `${years} years`} since they first talked to you`,
        };
    }
    return null;
}

export function getRelationshipSnippet(userId = DEFAULT_USER): string {
    const state = getRelationshipState(userId);
    const parts: string[] = [];

    // ponytail: marked said when offered, not when the reply says it.
    if (_db) {
        const row = _db.exec("SELECT milestones_said FROM relationship_state WHERE user_id = ?", [userId]);
        const said = String(row[0]?.values[0]?.[0] ?? "");
        const firstChat = _db.exec("SELECT MIN(created_at) FROM conversations")[0]?.values[0]?.[0];
        const m = pickMilestone(state.engagement_streak, (firstChat as string) ?? null, said.split(","));
        if (m) {
            _db.run("UPDATE relationship_state SET milestones_said = ? WHERE user_id = ?", [
                said ? `${said},${m.key}` : m.key,
                userId,
            ]);
            parts.push(`- Milestone today: ${m.line}. Mention it once in one line, then drop it.`);
        }
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
