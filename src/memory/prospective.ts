// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Prospective Memory (Future Triggers) ─────────────────────
 * Brain analog: Prospective memory — "remember to buy milk when I pass the store".
 * The brain sets retrieval triggers that fire when matching conditions appear.
 *
 * Triggers are stored with an embedding of the trigger pattern.
 * On each incoming message, we check if any trigger fires (cosine sim > 0.75).
 * Triggers expire after 90 days or when fired.
 */

import type { Database } from "./sqlite.js";
import { embedText } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";

// ── Constants ─────────────────────────────────

const FIRE_THRESHOLD = 0.75;
const DEFAULT_EXPIRY_DAYS = 90;

// ── Types ─────────────────────────────────────

export interface ProspectiveTrigger {
    id: number;
    content: string;
    trigger_pattern: string;
    created_at: string;
    expires_at: string;
    fired: boolean;
    fired_at?: string;
}

interface FiredTrigger {
    id: number;
    content: string;
    trigger_pattern: string;
    similarity: number;
}

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;

// ── Initialize ────────────────────────────────

export function initProspectiveDB(db: Database): void {
    _db = db;

    db.run(`
    CREATE TABLE IF NOT EXISTS prospective_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      trigger_embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      fired INTEGER DEFAULT 0,
      fired_at TEXT
    )
  `);

    console.log("🔮 Prospective memory initialized");
}

// ── Create Trigger ────────────────────────────

/**
 * Store a prospective memory trigger.
 * "Remind me about {content} when {triggerPattern}"
 */
export async function createTrigger(
    content: string,
    triggerPattern: string,
    expiryDays = DEFAULT_EXPIRY_DAYS
): Promise<number | null> {
    if (!_db) return null;

    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

    // Embed the trigger pattern for semantic matching
    let embeddingBuf: Buffer | null = null;
    try {
        const embedding = await embedText(triggerPattern);
        if (embedding) {
            const buf = Buffer.alloc(embedding.length * 4);
            for (let i = 0; i < embedding.length; i++) {
                buf.writeFloatLE(embedding[i], i * 4);
            }
            embeddingBuf = buf;
        }
    } catch { /* non-fatal, will fall back to keyword matching */ }

    _db.run(
        `INSERT INTO prospective_memories (content, trigger_pattern, trigger_embedding, expires_at)
         VALUES (?, ?, ?, ?)`,
        [content, triggerPattern, embeddingBuf, expiresAt]
    );

    const result = _db.exec("SELECT last_insert_rowid()");
    const id = result.length > 0 ? (result[0].values[0][0] as number) : null;

    console.log(`[PROSPECTIVE] Created trigger #${id}: "${triggerPattern}" → "${content.substring(0, 50)}..." (expires ${expiresAt.substring(0, 10)})`);
    return id;
}

// ── Check Triggers ────────────────────────────

/**
 * Check all active triggers against the current message.
 * Returns fired triggers (and marks them as fired).
 */
export async function checkTriggers(
    currentMessage: string
): Promise<FiredTrigger[]> {
    if (!_db) return [];

    // Get active (unfired, unexpired) triggers
    const now = new Date().toISOString();
    const results = _db.exec(
        `SELECT id, content, trigger_pattern, trigger_embedding
         FROM prospective_memories
         WHERE fired = 0 AND expires_at > ?`,
        [now]
    );

    if (results.length === 0 || results[0].values.length === 0) return [];

    const fired: FiredTrigger[] = [];

    // Embed current message for comparison
    let messageEmbedding: Float32Array | null = null;
    try {
        messageEmbedding = await embedText(currentMessage);
    } catch { /* will fall back to keyword */ }

    for (const row of results[0].values) {
        const id = row[0] as number;
        const content = row[1] as string;
        const triggerPattern = row[2] as string;
        const embeddingBuf = row[3] as Buffer | null;

        let similarity = 0;

        // Method 1: Semantic similarity (preferred)
        if (messageEmbedding && embeddingBuf) {
            const ab = new ArrayBuffer(embeddingBuf.length);
            const view = new Uint8Array(ab);
            for (let i = 0; i < embeddingBuf.length; i++) view[i] = embeddingBuf[i];
            const triggerEmbedding = new Float32Array(ab);

            similarity = cosineSimilarity(messageEmbedding, triggerEmbedding);
        }

        // Method 2: Keyword fallback
        if (similarity < FIRE_THRESHOLD) {
            const msgLower = currentMessage.toLowerCase();
            const triggerWords = triggerPattern.toLowerCase().split(/\s+/)
                .filter(w => w.length > 3);
            const matchedWords = triggerWords.filter(w => msgLower.includes(w));
            const keywordSim = triggerWords.length > 0
                ? matchedWords.length / triggerWords.length
                : 0;
            similarity = Math.max(similarity, keywordSim);
        }

        if (similarity >= FIRE_THRESHOLD) {
            // FIRE!
            _db.run(
                "UPDATE prospective_memories SET fired = 1, fired_at = datetime('now') WHERE id = ?",
                [id]
            );

            fired.push({ id, content, trigger_pattern: triggerPattern, similarity });
            console.log(`[PROSPECTIVE] 🔔 Trigger #${id} fired! (sim=${similarity.toFixed(2)}) "${triggerPattern}" → "${content.substring(0, 50)}..."`);
        }
    }

    return fired;
}

// ── Prompt Snippet ────────────────────────────

/**
 * Get recently fired triggers for injection into system prompt.
 * Shows triggers fired in the last 10 minutes.
 */
export function getProspectiveSnippet(): string {
    if (!_db) return "";

    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // last 10 min
    const results = _db.exec(
        `SELECT content, trigger_pattern FROM prospective_memories
         WHERE fired = 1 AND fired_at > ?
         ORDER BY fired_at DESC LIMIT 3`,
        [cutoff]
    );

    if (results.length === 0 || results[0].values.length === 0) return "";

    const lines = results[0].values.map(row =>
        `🔔 REMINDER: "${row[0]}" (triggered by context matching: "${row[1]}")`
    );

    return "### TRIGGERED REMINDERS\n" + lines.join("\n");
}

// ── List Active Triggers ──────────────────────

export function listActiveTriggers(): ProspectiveTrigger[] {
    if (!_db) return [];

    const now = new Date().toISOString();
    const results = _db.exec(
        `SELECT id, content, trigger_pattern, created_at, expires_at, fired, fired_at
         FROM prospective_memories
         WHERE fired = 0 AND expires_at > ?
         ORDER BY created_at DESC`,
        [now]
    );

    if (results.length === 0) return [];
    return results[0].values.map(row => ({
        id: row[0] as number,
        content: row[1] as string,
        trigger_pattern: row[2] as string,
        created_at: row[3] as string,
        expires_at: row[4] as string,
        fired: (row[5] as number) === 1,
        fired_at: row[6] as string | undefined,
    }));
}

// ── Cleanup ───────────────────────────────────

/** Remove expired and old fired triggers */
export function cleanupTriggers(): number {
    if (!_db) return 0;

    const now = new Date().toISOString();
    // Delete expired unfired triggers
    _db.run("DELETE FROM prospective_memories WHERE fired = 0 AND expires_at < ?", [now]);
    // Delete fired triggers older than 7 days
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    _db.run("DELETE FROM prospective_memories WHERE fired = 1 AND fired_at < ?", [weekAgo]);

    return 0; // cleanup count not tracked for simplicity
}
