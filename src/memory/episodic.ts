// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Episodic Memory Layer ─────────────────────
// Stores meaningful milestones and events.
// Used for natural callbacks, confidence reinforcement, and narrative building.

import type { Database } from "./sqlite.js";
import { generateUUID } from "../utils/uuid.js";
import { embedText, cosineSimilarity, embeddingToBuffer, bufferToEmbedding, isReady as isEmbeddingReady } from "./embeddings.js";
import { getRawDb } from "./sqlite.js";

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
): EpisodicMemory {
    if (!_db) throw new Error("Episodic memory not initialized");

    const id = generateUUID();
    _db.run(
        `INSERT INTO episodic_memory (id, user_id, type, description, importance_score)
         VALUES (?, ?, ?, ?, ?)`,
        [id, userId, type, description, Math.max(0, Math.min(1, importanceScore))]
    );

    console.log(`[MEMORY][EPISODIC] Recorded: [${type}] ${description.substring(0, 60)} (importance=${importanceScore.toFixed(2)})`);

    // Async: generate and store embedding (non-blocking)
    embedEpisode(id, description).catch(() => { /* non-fatal */ });

    return { id, user_id: userId, type, description, importance_score: importanceScore, timestamp: new Date().toISOString() };
}

/** Generate embedding for an episode and store in episodic_embeddings */
async function embedEpisode(episodeId: string, text: string): Promise<void> {
    const rawDb = getRawDb();
    if (!rawDb || !isEmbeddingReady()) return;
    try {
        const embedding = await embedText(text);
        const buffer = embeddingToBuffer(embedding);
        rawDb.prepare(
            "INSERT OR REPLACE INTO episodic_embeddings (episode_id, embedding) VALUES (?, ?)"
        ).run(episodeId, buffer);
    } catch (err) {
        console.warn(`[EPISODIC][EMBED] Failed for ${episodeId}:`, (err as Error).message);
    }
}

// ── Get Recent Episodes ───────────────────────

export function getRecentEpisodes(userId = "default", limit = 10): EpisodicMemory[] {
    if (!_db) return [];

    const results = _db.exec(
        `SELECT id, user_id, type, description, importance_score, timestamp
         FROM episodic_memory WHERE user_id = ?
         ORDER BY importance_score DESC, timestamp DESC LIMIT ?`,
        [userId, limit]
    );

    if (results.length === 0) return [];
    return results[0].values.map(rowToEpisode);
}

// ── Get Relevant Episodes ─────────────────────

/**
 * Returns episodes matching the query via keyword + vector search (RRF fusion).
 */
export async function getRelevantEpisodes(query: string, userId = "default", limit = 5): Promise<EpisodicMemory[]> {
    if (!_db) return [];

    const keywords = query.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 3);

    if (keywords.length === 0) return getRecentEpisodes(userId, limit);

    // ── 1. Keyword LIKE search ──
    const keywordResults = new Map<string, { record: EpisodicMemory; rank: number }>();
    const conditions = keywords.map(() => "(description LIKE ? OR type LIKE ?)");
    const params: (string | number)[] = [userId];
    for (const kw of keywords) {
        params.push(`%${kw}%`, `%${kw}%`);
    }
    params.push(limit * 2);

    const likeResults = _db.exec(
        `SELECT id, user_id, type, description, importance_score, timestamp
         FROM episodic_memory
         WHERE user_id = ? AND (${conditions.join(" OR ")})
         ORDER BY importance_score DESC, timestamp DESC
         LIMIT ?`,
        params
    );

    if (likeResults.length > 0) {
        likeResults[0].values.forEach((row, idx) => {
            const record = rowToEpisode(row);
            keywordResults.set(record.id, { record, rank: idx + 1 });
        });
    }

    // ── 2. Vector semantic search ──
    const vectorResults = new Map<string, { record: EpisodicMemory; rank: number }>();
    const rawDb = getRawDb();

    if (isEmbeddingReady() && rawDb) {
        try {
            const queryEmbedding = await embedText(query);

            const rows = rawDb.prepare(
                `SELECT ep.id, ep.user_id, ep.type, ep.description, ep.importance_score, ep.timestamp, ee.embedding
                 FROM episodic_embeddings ee
                 JOIN episodic_memory ep ON ee.episode_id = ep.id
                 WHERE ep.user_id = ?`
            ).all(userId) as Array<{
                id: string; user_id: string; type: string; description: string;
                importance_score: number; timestamp: string; embedding: Buffer;
            }>;

            const scored = rows.map(row => {
                const embedding = bufferToEmbedding(row.embedding);
                return {
                    record: { id: row.id, user_id: row.user_id, type: row.type, description: row.description, importance_score: row.importance_score, timestamp: row.timestamp },
                    similarity: cosineSimilarity(queryEmbedding, embedding),
                };
            }).filter(r => r.similarity > 0.25)
                .sort((a, b) => b.similarity - a.similarity);

            scored.slice(0, limit * 2).forEach((item, idx) => {
                vectorResults.set(item.record.id, { record: item.record, rank: idx + 1 });
            });
        } catch { /* vector search non-fatal */ }
    }

    // ── 3. RRF Fusion ──
    const k = 60;
    const allIds = new Set([...keywordResults.keys(), ...vectorResults.keys()]);
    const fused: Array<{ record: EpisodicMemory; score: number }> = [];

    for (const id of allIds) {
        const kw = keywordResults.get(id);
        const vec = vectorResults.get(id);
        const record = kw?.record || vec?.record;
        if (!record) continue;

        let score = 0;
        if (kw) score += 1 / (k + kw.rank);
        if (vec) score += 1 / (k + vec.rank);
        if (kw && vec) score *= 1.5;

        fused.push({ record, score });
    }

    fused.sort((a, b) => b.score - a.score);
    const results = fused.slice(0, limit).map(f => f.record);

    // Fallback to keyword-only if fusion returned nothing
    return results.length > 0 ? results : getRecentEpisodes(userId, limit);
}

// ── Boost Importance ──────────────────────────

/**
 * Boost an episode's importance when reinforced (referenced again, emotional callback).
 */
export function boostEpisode(id: string, amount = 0.1): void {
    if (!_db) return;

    _db.run(
        `UPDATE episodic_memory
         SET importance_score = min(1.0, importance_score + ?)
         WHERE id = ?`,
        [amount, id]
    );
}

// ── Prompt Snippet ────────────────────────────

export function getEpisodicSnippet(userId = "default"): string {
    const episodes = getRecentEpisodes(userId, MAX_INJECTION_ITEMS)
        .filter(e => e.importance_score > 0.4);

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
    return (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24);
}

// generateId moved to ../utils/uuid.ts as generateUUID
