// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Content-hash LRU cache for single-string embeddings ─────────
// Repeated embedText() calls for identical strings (boot-time category
// embeddings, tool descriptions, repeated user turns) are common.
// Caching by sha256(type, text) avoids re-running the transformer
// pipeline for identical inputs. Bounded with LRU eviction so memory
// stays flat over long sessions.
//
// Kept in its own module (separate from embeddings.ts) so the cache
// logic can be unit-tested without spinning up the transformer runtime.

import { createHash } from "node:crypto";

export const EMBED_CACHE_MAX = 500;

const _cache = new Map<string, Float32Array>();

// In-flight fetches — indexed by cache key. When two callers race
// for the same key on a cold cache, the second caller finds the
// first one's pending promise here and awaits it instead of starting
// its own transformer pipeline run. Without this, concurrent
// cache-miss hits for identical text run the model twice (wasted
// CPU) and then both write to the cache (harmless, just redundant).
const _inflight = new Map<string, Promise<Float32Array>>();

/**
 * Build a collision-resistant cache key from (type, text).
 * Uses a null-byte separator so inputs like (type="query", text=":foo")
 * and (type="query:", text="foo") do not hash to the same key.
 */
export function makeCacheKey(text: string, type: string): string {
    return createHash("sha256").update(`${type}\x00${text}`).digest("hex");
}

/**
 * Retrieve a cached embedding. Returns a defensive copy so caller
 * mutation cannot corrupt the cached entry. Also bumps the entry to
 * the end of the insertion order (LRU "recent-use" marker).
 *
 * Returns undefined when the key is not present.
 */
export function getCached(key: string): Float32Array | undefined {
    const hit = _cache.get(key);
    if (!hit) return undefined;
    // Move-to-end so eviction targets the truly-oldest entry.
    _cache.delete(key);
    _cache.set(key, hit);
    return new Float32Array(hit);
}

/**
 * Store an embedding under the given key. When the cache is over the
 * size cap, evicts the oldest entry (Map iteration order == insertion
 * order, and getCached() re-inserts on hit to keep it LRU).
 */
export function putCached(key: string, value: Float32Array): void {
    _cache.set(key, value);
    if (_cache.size > EMBED_CACHE_MAX) {
        const firstKey = _cache.keys().next().value;
        if (firstKey !== undefined) _cache.delete(firstKey);
    }
}

/**
 * Cache-with-inflight-dedup wrapper. On a miss, check for an existing
 * pending fetch under the same key before starting a new one so
 * concurrent callers share one pipeline run.
 *
 * The returned Float32Array is always a fresh copy of what lives in
 * the cache — callers are free to mutate their result without
 * corrupting the cached entry or other callers' copies.
 */
export async function getOrFetchCached(
    key: string,
    fetch: () => Promise<Float32Array>,
): Promise<Float32Array> {
    const cached = getCached(key);
    if (cached) return cached;

    const existing = _inflight.get(key);
    if (existing) {
        // Another caller is already running the pipeline for this key.
        // Share their promise; return a defensive copy of their result.
        const shared = await existing;
        return new Float32Array(shared);
    }

    const promise = fetch();
    _inflight.set(key, promise);
    try {
        const result = await promise;
        putCached(key, result);
        return new Float32Array(result);
    } finally {
        _inflight.delete(key);
    }
}

// ── Test-only helpers ──────────────────────────────────────────
// Exported so the vitest suite can reset state between tests and
// assert on internal size without reaching into module state.

/** @internal — for tests only */
export function _clearCacheForTests(): void {
    _cache.clear();
    _inflight.clear();
}

/** @internal — for tests only */
export function _cacheSizeForTests(): number {
    return _cache.size;
}

/** @internal — for tests only */
export function _inflightSizeForTests(): number {
    return _inflight.size;
}
