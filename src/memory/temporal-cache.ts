// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Temporal Locality Cache ──────────────────────────────────
 * Brain analog: Prefrontal cortex working memory — recently activated items stay "hot".
 *
 * LRU of recall() result sets with TTL eviction. The caller builds the key, and
 * it must cover everything that changes the result (limit, scopes, mode).
 */

import type { MemoryRecord } from "./sqlite.js";

const LRU_MAX_SIZE = 500; // Max cached result sets
const LRU_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
    results: MemoryRecord[];
    timestamp: number;
}

export class TemporalCache {
    // Map keeps insertion order, so re-inserting on every hit leaves the LRU key first.
    private cache = new Map<string, CacheEntry>();

    /** Try to get cached results for a key */
    get(key: string): MemoryRecord[] | null {
        const entry = this.cache.get(key);
        if (!entry) return null;
        this.cache.delete(key);
        if (Date.now() - entry.timestamp > LRU_TTL_MS) return null;
        this.cache.set(key, entry);
        return entry.results;
    }

    /** Store results for a key */
    set(key: string, results: MemoryRecord[]): void {
        this.cache.delete(key);
        while (this.cache.size >= LRU_MAX_SIZE) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
        this.cache.set(key, { results, timestamp: Date.now() });
    }

    /** Clear the entire cache (e.g., after a memory write) */
    clearCache(): void {
        this.cache.clear();
    }
}

// ── Singleton ─────────────────────────────────

let _cache: TemporalCache | null = null;

export function getTemporalCache(): TemporalCache {
    if (!_cache) _cache = new TemporalCache();
    return _cache;
}
