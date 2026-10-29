// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Episodic Memory Layer ─────────────────────
// Stores meaningful milestones and events.
// Used for natural callbacks, confidence reinforcement, and narrative building.

import type { Database } from "./sqlite.js";
import { generateUUID } from "../utils/uuid.js";

// ── Types ─────────────────────────────────────

export interface EpisodicMemory {
    id: string;
    user_id: string;
    type: string;          // "achievement" | "struggle" | "decision" | "milestone" | "project_launch"
    description: string;
    importance_score: number;  // 0–1
    timestamp: string;
}

// ── Constants ─────────────────────────────────

const MAX_INJECTION_ITEMS = 3;
const MAX_EPISODES_PER_USER = 500;

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;

// ── Initialize ────────────────────────────────

export function initEpisodicMemory(db: Database): void {
    _db = db;
    console.log("📌 Episodic memory initialized");
}

// ── Record Episode ────────────────────────────

export function recordEpisode(
    type: string,
    description: string,
    importanceScore = 0.5,
    userId = "default"
): void {
    if (!_db) throw new Error("Episodic memory not initialized");
    const importance = Math.max(0, Math.min(1, importanceScore));

    // Reflection re-extracts the same milestone every run: refresh it instead of duplicating.
    const dup = _db.exec(
        "SELECT id FROM episodic_memory WHERE user_id = ? AND lower(description) = lower(?) LIMIT 1",
        [userId, description]
    )[0]?.values[0]?.[0];
    if (dup) {
        _db.run(
            "UPDATE episodic_memory SET timestamp = datetime('now'), importance_score = max(importance_score, ?) WHERE id = ?",
            [importance, dup]
        );
        return;
    }

    _db.run(
        `INSERT INTO episodic_memory (id, user_id, type, description, importance_score)
         VALUES (?, ?, ?, ?, ?)`,
        [generateUUID(), userId, type, description, importance]
    );
    // ponytail: keeps the newest 500; rank by the decay score if old high-importance milestones matter
    _db.run(
        `DELETE FROM episodic_memory WHERE user_id = ? AND id NOT IN
         (SELECT id FROM episodic_memory WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?)`,
        [userId, userId, MAX_EPISODES_PER_USER]
    );

    console.log(`[MEMORY][EPISODIC] Recorded: [${type}] ${description.substring(0, 60)} (importance=${importance.toFixed(2)})`);
}

// ── Get Recent Episodes ───────────────────────

/** Importance with a 14-day hyperbolic decay, so a 0.9 milestone from months ago yields to fresh ones. */
export function getRecentEpisodes(userId = "default", limit = 10, minImportance = 0): EpisodicMemory[] {
    if (!_db) return [];

    const results = _db.exec(
        `SELECT id, user_id, type, description, importance_score, timestamp
         FROM episodic_memory WHERE user_id = ? AND importance_score >= ?
         ORDER BY importance_score / (1 + (julianday('now') - julianday(timestamp)) / 14.0) DESC, timestamp DESC
         LIMIT ?`,
        [userId, minImportance, limit]
    );

    if (results.length === 0) return [];
    return results[0].values.map(rowToEpisode);
}

// ── Prompt Snippet ────────────────────────────

export function getEpisodicSnippet(userId = "default"): string {
    const episodes = getRecentEpisodes(userId, MAX_INJECTION_ITEMS, 0.4);

    if (episodes.length === 0) return "";

    const lines = episodes.map(e => {
        const age = daysSince(e.timestamp);
        const timeLabel = age < 1 ? "today" : age < 7 ? `${Math.round(age)}d ago` : `${Math.round(age / 7)}w ago`;
        return `- [${e.type}] ${e.description} (${timeLabel})`;
    });

    return "📌 KEY MILESTONES (use naturally for callbacks):\n" + lines.join("\n");
}

// ── Helpers ───────────────────────────────────

function rowToEpisode(row: unknown[]): EpisodicMemory {
    return {
        id: row[0] as string,
        user_id: row[1] as string,
        type: row[2] as string,
        description: row[3] as string,
        importance_score: row[4] as number,
        timestamp: row[5] as string,
    };
}

function daysSince(ts: string): number {
    // SQLite's datetime('now') is UTC without a zone marker.
    const utc = ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
    return (Date.now() - new Date(utc).getTime()) / (1000 * 60 * 60 * 24);
}

// generateId moved to ../utils/uuid.ts as generateUUID
