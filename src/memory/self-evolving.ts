// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
 * strength = importance × log₂(2 + access_count) × recency_factor
 * (2, not 1: a memory nobody has recalled yet must not score 0 and be pruned
 * as the weakest no matter how important it is.)
 */
function strengthScore(
    importance: number,
    accessCount: number,
    daysSinceAccess: number,
    emotionalWeight = 1.0,
): number {
    const accessFactor = Math.log2(2 + accessCount);
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
// Decay runs every 6h but weakening is meant to be nightly: compounding ×0.8
// four times a day pushed weak memories under the 0.2 recall floor in ~2 days.
const lastWeakenDay = new WeakMap<object, string>();
/** Weakening never pushes a memory below this; recall hides rows at <= 0.2. */
export const WEAKEN_FLOOR = 0.25;

export function synapticPrune(db: Database): { pruned: number; weakened: number; strengthened: number } {
    const stats = { pruned: 0, weakened: 0, strengthened: 0 };
    const today = new Date().toISOString().slice(0, 10);
    const canWeaken = lastWeakenDay.get(db) !== today;
    if (canWeaken) lastWeakenDay.set(db, today);

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

    // Deletes really happen now (the FTS triggers used to make every DELETE
    // fail), so never let one pass remove more than a tenth of memory.
    const maxPrune = Math.floor(memories.length * 0.1);

    beginTransaction();
    try {
        for (const m of memories) {
            // Protect new memories: don't prune or weaken memories less than 48h old
            // or memories that have never been accessed and are less than 7 days old.
            // Give recently stored memories a chance to be recalled before penalizing them.
            const isNewMemory = m.days_since_access < 2; // Less than 48 hours
            const isUnaccessed = m.access_count === 0 && m.days_since_access < 7;

            if (
                m.strength < pruneThreshold &&
                m.importance < 3 &&
                !isNewMemory &&
                !isUnaccessed &&
                stats.pruned < maxPrune
            ) {
                // PRUNE — too weak, remove (but not new/unaccessed memories)
                db.run("DELETE FROM memories WHERE id = ?", [m.id]);
                db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [m.id]);
                // Also remove from HNSW
                try {
                    getHNSWIndex().removeVector(m.id);
                } catch {
                    /* */
                }
                stats.pruned++;
            } else if (m.strength < weakenThreshold && m.importance < 8 && !isNewMemory && !isUnaccessed) {
                // WEAKEN — reduce decay score by 20%, once a day, never below the
                // floor (and never raise a row already below it, e.g. superseded = 0).
                if (canWeaken && m.decay_score > WEAKEN_FLOOR) {
                    const newDecay = Math.max(WEAKEN_FLOOR, m.decay_score * 0.8);
                    db.run("UPDATE memories SET decay_score = ? WHERE id = ?", [newDecay, m.id]);
                    stats.weakened++;
                }
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
    // 0.97, not 0.9: at 0.9 "prefers dark mode" and "prefers light mode" can
    // match, and merging would delete the correction.
    const dupes = findDuplicates(db, 0.97);
    let merged = 0;

    if (dupes.length === 0) return 0;

    beginTransaction();
    try {
        for (const dupe of dupes) {
            const q = "SELECT importance, access_count, COALESCE(pinned, 0), created_at FROM memories WHERE id = ?";
            const m1 = db.exec(q, [dupe.id1]);
            const m2 = db.exec(q, [dupe.id2]);

            if (m1.length === 0 || m2.length === 0) continue;
            const [i1, a1, p1, c1] = m1[0].values[0] as [number, number, number, string];
            const [i2, a2, p2, c2] = m2[0].values[0] as [number, number, number, string];

            const score1 = i1 + a1;
            const score2 = i2 + a2;
            // Keep the stronger one; on a tie the newer one (it may be a correction).
            const deleteId =
                score1 !== score2 ? (score1 > score2 ? dupe.id2 : dupe.id1) : c1 >= c2 ? dupe.id2 : dupe.id1;
            if ((deleteId === dupe.id1 ? p1 : p2) === 1) continue; // never delete a pinned memory
            db.run("DELETE FROM memories WHERE id = ?", [deleteId]);
            db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [deleteId]);
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
