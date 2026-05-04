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

// ── Test-only helpers ──────────────────────────────────────────
// Exported so the vitest suite can reset state between tests and
// assert on internal size without reaching into module state.

/** @internal — for tests only */
export function _clearCacheForTests(): void {
    _cache.clear();
}

/** @internal — for tests only */
export function _cacheSizeForTests(): number {
    return _cache.size;
}
