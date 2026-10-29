// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Temporal Locality Cache ──────────────────────────────────
 * Brain analog: Prefrontal cortex working memory — recently activated items stay "hot".
 *
 * Two-layer caching:
 *  1. Bloom filter: O(1) "does ANY matching content exist?" pre-check (no-dep, pure TS)
 *  2. LRU cache: stores full result sets keyed by query hash, TTL-based eviction
 */

import type { MemoryRecord } from "./sqlite.js";

// ── Constants ─────────────────────────────────

const BLOOM_SIZE = 1 << 17;        // 131072 bits = 16KB (good for up to ~10K items, ~0.1% FP)
const BLOOM_HASH_COUNT = 7;        // Number of hash functions
const LRU_MAX_SIZE = 500;          // Max cached result sets
const LRU_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Bloom Filter ──────────────────────────────

class BloomFilter {
    private bits: Uint32Array;

    constructor() {
        this.bits = new Uint32Array(BLOOM_SIZE >> 5); // 32 bits per element
    }

    private hashes(key: string): number[] {
        const h: number[] = [];
        let h1 = 0;
        let h2 = 0;

        // FNV-1a for h1
        for (let i = 0; i < key.length; i++) {
            h1 ^= key.charCodeAt(i);
            h1 = Math.imul(h1, 0x01000193);
        }
        // DJB2 for h2
        for (let i = 0; i < key.length; i++) {
            h2 = Math.imul(h2, 33) + key.charCodeAt(i);
        }

        for (let i = 0; i < BLOOM_HASH_COUNT; i++) {
            h.push(Math.abs(h1 + i * h2) % BLOOM_SIZE);
        }
        return h;
    }

    add(key: string): void {
        for (const hash of this.hashes(key)) {
            this.bits[hash >> 5] |= (1 << (hash & 31));
        }
    }

    mightContain(key: string): boolean {
        for (const hash of this.hashes(key)) {
            if ((this.bits[hash >> 5] & (1 << (hash & 31))) === 0) return false;
        }
        return true;
    }

    clear(): void {
        this.bits.fill(0);
    }
}

// ── LRU Cache Entry ───────────────────────────

interface CacheEntry {
    results: MemoryRecord[];
    timestamp: number;
    queryHash: string;
}

// ── Temporal Cache Class ──────────────────────

export class TemporalCache {
    private bloom = new BloomFilter();
    private cache = new Map<string, CacheEntry>();
    private accessOrder: string[] = [];  // Most recent last

    // ── Query Hash ────────────────────────────

    private hashQuery(query: string): string {
        // Simple hash for cache keying
        let hash = 0;
        const normalized = query.toLowerCase().trim();
        for (let i = 0; i < normalized.length; i++) {
            hash = Math.imul(hash, 31) + normalized.charCodeAt(i);
            hash |= 0; // Convert to 32-bit integer
        }
        return hash.toString(36);
    }

    // ── Bloom Filter API ──────────────────────

    /** Register a memory's content keywords in the bloom filter */
    registerContent(content: string): void {
        // Add content keywords to bloom filter
        const words = content.toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3);
        for (const word of words) {
            this.bloom.add(word);
        }
    }

    /** Quick check: might ANY content match these keywords? */
    mightHaveContent(query: string): boolean {
        const words = query.toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 3);
        if (words.length === 0) return true; // Can't filter, assume yes
        // If ANY word might exist, proceed with search
        return words.some(w => this.bloom.mightContain(w));
    }

    // ── LRU Cache API ─────────────────────────

    /** Try to get cached results for a query */
    get(query: string): MemoryRecord[] | null {
        const hash = this.hashQuery(query);
        const entry = this.cache.get(hash);

        if (!entry) return null;

        // Check TTL
        if (Date.now() - entry.timestamp > LRU_TTL_MS) {
            this.cache.delete(hash);
            this.accessOrder = this.accessOrder.filter(h => h !== hash);
            return null;
        }

        // Move to end (most recent)
        this.accessOrder = this.accessOrder.filter(h => h !== hash);
        this.accessOrder.push(hash);

        return entry.results;
    }

    /** Store results for a query */
    set(query: string, results: MemoryRecord[]): void {
        const hash = this.hashQuery(query);

        // Evict LRU if at capacity
        while (this.cache.size >= LRU_MAX_SIZE && this.accessOrder.length > 0) {
            const evictHash = this.accessOrder.shift()!;
            this.cache.delete(evictHash);
        }

        this.cache.set(hash, {
            results,
            timestamp: Date.now(),
            queryHash: hash,
        });

        this.accessOrder = this.accessOrder.filter(h => h !== hash);
        this.accessOrder.push(hash);
    }

    /** Invalidate all cache entries containing a specific memory ID */
    invalidate(memoryId: number): void {
        for (const [hash, entry] of this.cache) {
            if (entry.results.some(r => r.id === memoryId)) {
                this.cache.delete(hash);
                this.accessOrder = this.accessOrder.filter(h => h !== hash);
            }
        }
    }

    /** Clear the entire cache (e.g., after consolidation) */
    clearCache(): void {
        this.cache.clear();
        this.accessOrder = [];
    }

    /** Clear everything including bloom filter */
    clearAll(): void {
        this.clearCache();
        this.bloom.clear();
    }

    /** Stats for logging */
    stats(): { cacheSize: number; maxCache: number } {
        return {
            cacheSize: this.cache.size,
            maxCache: LRU_MAX_SIZE,
        };
    }
}

// ── Singleton ─────────────────────────────────

let _cache: TemporalCache | null = null;

export function getTemporalCache(): TemporalCache {
    if (!_cache) _cache = new TemporalCache();
    return _cache;
}
