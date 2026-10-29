// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Tiered Memory Architecture ──────────────────────────────
 * Brain analog: Atkinson-Shiffrin model — working → short-term → long-term.
 *
 * Adaptive Tier Scoring (ATS):
 *   tier_score = w₁·time_decay + w₂·access_freq + w₃·importance + w₄·emotional_weight
 *
 * HOT  (>0.6):  Always searched, in-memory cache
 * WARM (>0.25): Searched for most queries
 * COLD (≤0.25): Only explicit "retrieve" mode
 */

import type { Database } from "./sqlite.js";
import { beginTransaction, commitTransaction, rollbackTransaction } from "./sqlite.js";

// ── Constants ─────────────────────────────────

export const TIER_HOT = "hot";
export const TIER_WARM = "warm";
export const TIER_COLD = "cold";

const W_TIME = 0.30;       // Time decay weight
const W_ACCESS = 0.25;     // Access frequency weight
const W_IMPORTANCE = 0.25; // Importance weight
const W_EMOTION = 0.20;    // Emotional weight

const LAMBDA = 0.01;       // Decay rate (69-day half-life → good for multi-year)

const HOT_THRESHOLD = 0.6;
const WARM_THRESHOLD = 0.25;

// ── Tier Scoring ──────────────────────────────

export interface TierableMemory {
    id: number;
    importance: number;
    decay_score: number;
    access_count: number;
    created_at: string;
    last_accessed?: string;
    emotional_intensity?: number;
}

/**
 * Compute Adaptive Tier Score for a memory.
 */
export function computeTierScore(
    memory: TierableMemory,
    maxAccessCount: number,
    avgEmotionalIntensity = 0
): number {
    const now = Date.now();

    // Time decay (exponential, based on last access or creation)
    const lastAccessTime = memory.last_accessed
        ? new Date(memory.last_accessed).getTime()
        : new Date(memory.created_at).getTime();
    const daysSinceAccess = (now - lastAccessTime) / (1000 * 60 * 60 * 24);
    const timeDecay = Math.exp(-LAMBDA * daysSinceAccess);

    // Access frequency (log-normalized)
    const accessFreq = maxAccessCount > 0
        ? Math.log2(1 + memory.access_count) / Math.log2(1 + maxAccessCount)
        : 0;

    // Importance (0-10 scale, normalize to 0-1)
    const importance = Math.min(1.0, memory.importance / 10);

    // Emotional weight (amplifies retention for emotional memories)
    const emotionalWeight = 1 + 0.3 * (memory.emotional_intensity ?? avgEmotionalIntensity);

    return (W_TIME * timeDecay + W_ACCESS * accessFreq + W_IMPORTANCE * importance + W_EMOTION * emotionalWeight);
}

/**
 * Determine tier from score.
 */
export function scoreToTier(score: number): string {
    if (score > HOT_THRESHOLD) return TIER_HOT;
    if (score > WARM_THRESHOLD) return TIER_WARM;
    return TIER_COLD;
}

/**
 * Batch-assign tiers to all memories. Called nightly.
 */
export function assignTiers(db: Database): { hot: number; warm: number; cold: number } {
    const counts = { hot: 0, warm: 0, cold: 0 };

    const results = db.exec(
        `SELECT id, importance, decay_score, access_count, created_at
         FROM memories WHERE decay_score > 0`
    );

    if (results.length === 0 || results[0].values.length === 0) return counts;

    // Find max access count for normalization
    const maxAccessCount = results[0].values.reduce(
        (max, row) => Math.max(max, (row[3] as number) || 0), 0
    );

    beginTransaction();
    try {
        const updateStmt = (db as any).prepare
            ? (db as any).prepare("UPDATE memories SET tier = ? WHERE id = ?")
            : null;

        for (const row of results[0].values) {
            const memory: TierableMemory = {
                id: row[0] as number,
                importance: row[1] as number,
                decay_score: row[2] as number,
                access_count: (row[3] as number) || 0,
                created_at: row[4] as string,
            };

            const score = computeTierScore(memory, maxAccessCount);
            const tier = scoreToTier(score);

            if (updateStmt) {
                updateStmt.run(tier, memory.id);
            } else {
                db.run("UPDATE memories SET tier = ? WHERE id = ?", [tier, memory.id]);
            }

            counts[tier as keyof typeof counts]++;
        }

        commitTransaction();
    } catch {
        rollbackTransaction();
    }

    console.log(`[TIERS] Assigned: ${counts.hot} hot, ${counts.warm} warm, ${counts.cold} cold`);
    return counts;
}

/**
 * Get which tiers to search based on query classification.
 */
export function getSearchTiers(queryMode: string): string[] {
    switch (queryMode) {
        case "retrieve":
            return [TIER_HOT, TIER_WARM, TIER_COLD]; // Search everything
        case "llm_with_traits":
            return [TIER_HOT, TIER_WARM];             // Skip cold
        case "llm_only":
            return [TIER_HOT];                        // Only hot
        default:
            return [TIER_HOT, TIER_WARM];
    }
}
