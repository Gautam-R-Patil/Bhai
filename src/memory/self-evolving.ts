// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { bufferToEmbedding } from "./embeddings.js";
import { assignTiers } from "./memory-tiers.js";
import type { Database } from "./sqlite.js";
import { beginTransaction, commitTransaction, rollbackTransaction } from "./sqlite.js";
import { getHNSWIndex } from "./vector-index.js";

/**
 * ── Self-Evolving Memory (Brain-Inspired) ─────────────────────
 *
 * Replaces simple decay with:
 *  1. Synaptic Homeostasis Pruning (SHP) — strength-based prune/weaken/strengthen
 *  2. HNSW-based duplicate detection — replaces Jaccard similarity
 *  3. Tier reassignment — nightly hot/warm/cold classification
 */

// ── Synaptic Homeostasis Pruning (SHP) ────────
// Brain analog: Synaptic homeostasis hypothesis — during sleep, weak synapses
// are pruned while strong ones are strengthened.

interface MemoryStrength {
    id: number;
    strength: number;
    importance: number;
    access_count: number;
    decay_score: number;
    days_since_access: number;
}

/**
 * Compute synaptic strength for a memory.
 * strength = importance × log₂(1 + access_count) × recency_factor
 */
function strengthScore(
    importance: number,
    accessCount: number,
    daysSinceAccess: number,
    emotionalWeight = 1.0,
): number {
    const accessFactor = Math.log2(1 + accessCount);
    const recency = Math.exp(-0.01 * daysSinceAccess); // λ=0.01, 69-day half-life
    return importance * accessFactor * recency * emotionalWeight;
}

/**
 * Synaptic Homeostasis Pruning — replaces simple applyDecay().
 *
 * For each memory:
 *   - If strength < median × 0.3 → PRUNE (delete)
 *   - If strength < median × 0.6 → WEAKEN (reduce decay_score by 20%)
 *   - Else → STRENGTHEN (boost decay_score by 5%, cap at 1.0)
 *
 * Global median recalculated each run → self-calibrates as memories grow.
 */
export function synapticPrune(db: Database): { pruned: number; weakened: number; strengthened: number } {
    const stats = { pruned: 0, weakened: 0, strengthened: 0 };

    const results = db.exec(
        `SELECT id, importance, access_count, decay_score,
                julianday('now') - julianday(COALESCE(accessed_at, created_at)) as days_since
         FROM memories
         WHERE consolidated_into IS NULL
           AND COALESCE(pinned, 0) = 0
           AND (category IS NULL OR (category != 'code' AND category NOT LIKE 'code\\_%' ESCAPE '\\'))`,
    );

    if (results.length === 0 || results[0].values.length === 0) return stats;

    // Calculate all strengths
    const memories: MemoryStrength[] = results[0].values.map((row) => ({
        id: row[0] as number,
        importance: row[1] as number,
        access_count: (row[2] as number) || 0,
        decay_score: row[3] as number,
        days_since_access: row[4] as number,
        strength: strengthScore(row[1] as number, (row[2] as number) || 0, row[4] as number),
    }));

    // Calculate global median strength
    const sortedStrengths = memories.map((m) => m.strength).sort((a, b) => a - b);
    const median = sortedStrengths[Math.floor(sortedStrengths.length / 2)] || 1;

    const pruneThreshold = median * 0.3;
    const weakenThreshold = median * 0.6;

    beginTransaction();
    try {
        for (const m of memories) {
            // Protect new memories: don't prune or weaken memories less than 48h old
            // or memories that have never been accessed and are less than 7 days old.
            // Give recently stored memories a chance to be recalled before penalizing them.
            const isNewMemory = m.days_since_access < 2; // Less than 48 hours
            const isUnaccessed = m.access_count === 0 && m.days_since_access < 7;

            if (m.strength < pruneThreshold && m.importance < 3 && !isNewMemory && !isUnaccessed) {
                // PRUNE — too weak, remove (but not new/unaccessed memories)
                db.run("DELETE FROM memories WHERE id = ?", [m.id]);
                // Also remove from HNSW
                try {
                    getHNSWIndex().removeVector(m.id);
                } catch {
                    /* */
                }
                stats.pruned++;
            } else if (m.strength < weakenThreshold && !isNewMemory && !isUnaccessed) {
                // WEAKEN — reduce decay score by 20% (but not new/unaccessed memories)
                const newDecay = Math.max(0.05, m.decay_score * 0.8);
                db.run("UPDATE memories SET decay_score = ? WHERE id = ?", [newDecay, m.id]);
                stats.weakened++;
            } else {
                // STRENGTHEN — boost decay score by 5%
                const newDecay = Math.min(1.0, m.decay_score * 1.05);
                db.run("UPDATE memories SET decay_score = ? WHERE id = ?", [newDecay, m.id]);
                stats.strengthened++;
            }
        }
        commitTransaction();
    } catch {
        rollbackTransaction();
    }

    console.log(
        `[PRUNING] Synaptic homeostasis: ${stats.pruned} pruned, ${stats.weakened} weakened, ${stats.strengthened} strengthened (median=${median.toFixed(2)})`,
    );
    return stats;
}

// ── HNSW-Based Duplicate Detection ────────────
// Replaces O(n²) Jaccard similarity with HNSW neighbor search

export function findDuplicates(db: Database, threshold = 0.9): Array<{ id1: number; id2: number; similarity: number }> {
    const index = getHNSWIndex();
    if (index.size < 2) return [];

    const duplicates: Array<{ id1: number; id2: number; similarity: number }> = [];
    const seen = new Set<string>();

    // Only check recent memories (last 200)
    const memories = db.exec(
        `SELECT m.id, e.embedding FROM memories m
         JOIN memory_embeddings e ON m.id = e.memory_id
         WHERE m.consolidated_into IS NULL
           AND (m.category IS NULL OR (m.category != 'code' AND m.category NOT LIKE 'code\\_%' ESCAPE '\\'))
         ORDER BY m.id DESC LIMIT 200`,
    );

    if (memories.length === 0) return [];

    for (const row of memories[0].values) {
        const id = row[0] as number;
        const embBuf = row[1] as Buffer;

        const embedding = bufferToEmbedding(embBuf);

        // Use HNSW to find 3 nearest neighbors
        const neighbors = index.search(embedding, 4); // 4 because first is self

        for (const neighbor of neighbors) {
            if (neighbor.id === id) continue;
            const similarity = 1 - neighbor.distance; // Convert distance to similarity
            if (similarity < threshold) continue;

            const key = [Math.min(id, neighbor.id), Math.max(id, neighbor.id)].join("-");
            if (seen.has(key)) continue;
            seen.add(key);

            duplicates.push({ id1: id, id2: neighbor.id, similarity });
        }
    }

    return duplicates;
}

export function mergeDuplicates(db: Database): number {
    const dupes = findDuplicates(db);
    let merged = 0;

    if (dupes.length === 0) return 0;

    beginTransaction();
    try {
        for (const dupe of dupes) {
            const m1 = db.exec("SELECT importance, access_count FROM memories WHERE id = ?", [dupe.id1]);
            const m2 = db.exec("SELECT importance, access_count FROM memories WHERE id = ?", [dupe.id2]);

            if (m1.length === 0 || m2.length === 0) continue;

            const score1 = (m1[0].values[0][0] as number) + (m1[0].values[0][1] as number);
            const score2 = (m2[0].values[0][0] as number) + (m2[0].values[0][1] as number);

            const deleteId = score1 >= score2 ? dupe.id2 : dupe.id1;
            db.run("DELETE FROM memories WHERE id = ?", [deleteId]);
            try {
                getHNSWIndex().removeVector(deleteId);
            } catch {
                /* */
            }
            merged++;
        }
        commitTransaction();
    } catch {
        rollbackTransaction();
    }

    return merged;
}

// ── Legacy Compatibility ──────────────────────

/** @deprecated Use synapticPrune() instead */
export function applyDecay(db: Database, _decayRate = 0.95): number {
    const result = synapticPrune(db);
    return result.pruned;
}

// ── Boost ─────────────────────────────────────

export function boostMemory(db: Database, id: number): void {
    db.run(
        `UPDATE memories SET
      decay_score = MIN(decay_score * 1.2, 1.0),
      access_count = access_count + 1,
      accessed_at = datetime('now')
     WHERE id = ?`,
        [id],
    );
}

// ── Reorganize ────────────────────────────────

export function reorganizeMemories(db: Database): {
    pruned: number;
    weakened: number;
    strengthened: number;
    merged: number;
    tiers: { hot: number; warm: number; cold: number };
} {
    const pruneResult = synapticPrune(db);
    const merged = mergeDuplicates(db);
    const tiers = assignTiers(db);

    // Persist HNSW index after reorganization
    try {
        getHNSWIndex().persist();
    } catch {
        /* */
    }

    return { ...pruneResult, merged, tiers };
}

// ── Access Pattern Stats ──────────────────────

export function getAccessPatterns(db: Database): Array<{
    category: string;
    avg_access: number;
    total: number;
}> {
    const results = db.exec(
        `SELECT category, AVG(access_count) as avg_access, COUNT(*) as total
     FROM memories
     GROUP BY category
     ORDER BY avg_access DESC`,
    );

    if (results.length === 0) return [];
    return results[0].values.map((row) => ({
        category: row[0] as string,
        avg_access: row[1] as number,
        total: row[2] as number,
    }));
}
