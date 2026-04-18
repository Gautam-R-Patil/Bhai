// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Thought Journal ──────────────────────────────
 * Persistent SQLite store for the Inner Thoughts Engine.
 * Records every thought candidate (formed, scored, decision, user response).
 * Enables learning from user engagement patterns over time.
 */

import type { Database } from "../memory/sqlite.js";

// ── Types ─────────────────────────────────────

export interface ThoughtRecord {
    id: number;
    content: string;
    trigger_type: string;
    relevance: number;
    urgency: number;
    novelty: number;
    appropriateness: number;
    composite_score: number;
    decision: "suppressed" | "queued" | "surfaced";
    user_response: string | null; // "engaged" | "ignored" | "dismissed" | null
    created_at: string;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function initThoughtJournal(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS thoughts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            trigger_type TEXT,
            relevance REAL,
            urgency REAL,
            novelty REAL,
            appropriateness REAL,
            composite_score REAL,
            decision TEXT,
            user_response TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_thoughts_decision ON thoughts(decision)"); } catch { /* */ }
    try { db.run("CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at)"); } catch { /* */ }

    console.log("[THOUGHT-JOURNAL] Initialized");
}

// ── Write ─────────────────────────────────────

export function recordThought(
    content: string,
    triggerType: string,
    scores: { relevance: number; urgency: number; novelty: number; appropriateness: number; composite: number },
    decision: "suppressed" | "queued" | "surfaced"
): number {
    if (!db) return 0;

    db.run(
        `INSERT INTO thoughts (content, trigger_type, relevance, urgency, novelty, appropriateness, composite_score, decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [content, triggerType, scores.relevance, scores.urgency, scores.novelty, scores.appropriateness, scores.composite, decision]
    );

    const result = db.exec("SELECT last_insert_rowid() as id");
    return (result[0]?.values[0]?.[0] as number) || 0;
}

export function updateThoughtResponse(thoughtId: number, response: "engaged" | "ignored" | "dismissed"): void {
    if (!db) return;
    db.run("UPDATE thoughts SET user_response = ? WHERE id = ?", [response, thoughtId]);
}

// ── Read ──────────────────────────────────────

/**
 * Get recent thoughts for novelty comparison.
 * Returns thoughts from the last N hours.
 */
export function getRecentThoughts(hoursBack = 24, limit = 50): ThoughtRecord[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT id, content, trigger_type, relevance, urgency, novelty, appropriateness,
                composite_score, decision, user_response, created_at
         FROM thoughts
         WHERE created_at > datetime('now', '-${hoursBack} hours')
         ORDER BY created_at DESC
         LIMIT ?`,
        [limit]
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        id: row[0] as number,
        content: row[1] as string,
        trigger_type: row[2] as string,
        relevance: row[3] as number,
        urgency: row[4] as number,
        novelty: row[5] as number,
        appropriateness: row[6] as number,
        composite_score: row[7] as number,
        decision: row[8] as "suppressed" | "queued" | "surfaced",
        user_response: row[9] as string | null,
        created_at: row[10] as string,
    }));
}

/**
 * Get surfaced thoughts that haven't received a response yet.
 * Used to track engagement with the most recent proactive messages.
 */
export function getUnrespondedSurfacedThoughts(limit = 5): ThoughtRecord[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT id, content, trigger_type, relevance, urgency, novelty, appropriateness,
                composite_score, decision, user_response, created_at
         FROM thoughts
         WHERE decision = 'surfaced' AND user_response IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
        [limit]
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        id: row[0] as number,
        content: row[1] as string,
        trigger_type: row[2] as string,
        relevance: row[3] as number,
        urgency: row[4] as number,
        novelty: row[5] as number,
        appropriateness: row[6] as number,
        composite_score: row[7] as number,
        decision: row[8] as "suppressed" | "queued" | "surfaced",
        user_response: row[9] as string | null,
        created_at: row[10] as string,
    }));
}

/**
 * Get queued thoughts that should be surfaced during next interaction.
 */
export function getQueuedThoughts(limit = 10): ThoughtRecord[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT id, content, trigger_type, relevance, urgency, novelty, appropriateness,
                composite_score, decision, user_response, created_at
         FROM thoughts
         WHERE decision = 'queued' AND user_response IS NULL
         ORDER BY composite_score DESC
         LIMIT ?`,
        [limit]
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        id: row[0] as number,
        content: row[1] as string,
        trigger_type: row[2] as string,
        relevance: row[3] as number,
        urgency: row[4] as number,
        novelty: row[5] as number,
        appropriateness: row[6] as number,
        composite_score: row[7] as number,
        decision: row[8] as "suppressed" | "queued" | "surfaced",
        user_response: row[9] as string | null,
        created_at: row[10] as string,
    }));
}

/**
 * Mark queued thoughts as surfaced (when they're finally delivered).
 */
export function markQueuedAsSurfaced(thoughtIds: number[]): void {
    if (!db || thoughtIds.length === 0) return;
    for (const id of thoughtIds) {
        db.run("UPDATE thoughts SET decision = 'surfaced' WHERE id = ?", [id]);
    }
}

/**
 * Get journal entries for Rust-side suppression stats computation.
 * Returns data in the format expected by native compute_suppression_stats.
 */
export function getJournalEntriesForStats(hoursBack = 24): Array<{
    composite_score: number;
    decision: string;
    user_response: string;
    created_at_ms: number;
}> {
    if (!db) return [];

    const results = db.exec(
        `SELECT composite_score, decision, user_response, created_at
         FROM thoughts
         WHERE created_at > datetime('now', '-${hoursBack} hours')`,
        []
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        composite_score: row[0] as number,
        decision: row[1] as string,
        user_response: (row[2] as string) || "",
        created_at_ms: new Date(row[3] as string).getTime(),
    }));
}

/**
 * Cleanup old thoughts (keep last 30 days).
 */
export function cleanupOldThoughts(): void {
    if (!db) return;
    db.run("DELETE FROM thoughts WHERE created_at < datetime('now', '-30 days')");
}
