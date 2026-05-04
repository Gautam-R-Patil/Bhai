// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    makeCacheKey,
    getCached,
    putCached,
    getOrFetchCached,
    EMBED_CACHE_MAX,
    _clearCacheForTests,
    _cacheSizeForTests,
    _inflightSizeForTests,
} from "./embedding-cache.js";

describe("embedding-cache", () => {
    beforeEach(() => _clearCacheForTests());

    describe("makeCacheKey", () => {
        it("returns a 64-character hex sha256 string", () => {
            const key = makeCacheKey("hello", "query");
            expect(key).toHaveLength(64);
            expect(key).toMatch(/^[0-9a-f]{64}$/);
        });

        it("produces different keys for different types", () => {
            const a = makeCacheKey("hello", "query");
            const b = makeCacheKey("hello", "document");
            expect(a).not.toEqual(b);
        });

        it("produces different keys for different text", () => {
            const a = makeCacheKey("hello", "query");
            const b = makeCacheKey("world", "query");
            expect(a).not.toEqual(b);
        });

        it("is deterministic for the same (text, type) pair", () => {
            const a = makeCacheKey("the quick brown fox", "query");
            const b = makeCacheKey("the quick brown fox", "query");
            expect(a).toEqual(b);
        });

        it("uses a non-separator byte so colon-boundary inputs don't collide", () => {
            // Would collide under naive sha256(type + ':' + text) for
            //   (type='query', text=':foo')  vs  (type='query:', text='foo')
            // The null-byte separator prevents that.
            const a = makeCacheKey(":foo", "query");
            const b = makeCacheKey("foo", "query:");
            expect(a).not.toEqual(b);
        });

        it("handles empty text", () => {
            const k = makeCacheKey("", "query");
            expect(k).toHaveLength(64);
        });

        it("handles unicode text", () => {
            const a = makeCacheKey("hello 🧠", "query");
            const b = makeCacheKey("hello 🧠", "query");
            expect(a).toEqual(b);
        });
    });

    describe("get/put roundtrip", () => {
        it("returns undefined for missing key", () => {
            expect(getCached("nope")).toBeUndefined();
        });

        it("returns the stored value", () => {
            const v = new Float32Array([1, 2, 3]);
            putCached("k", v);
            const got = getCached("k");
            expect(got).not.toBeUndefined();
            expect(Array.from(got!)).toEqual([1, 2, 3]);
        });

        it("returns a defensive copy — caller mutation cannot corrupt the cache", () => {
            const original = new Float32Array([1, 2, 3]);
            putCached("k", original);

            const first = getCached("k")!;
            first[0] = 999;

            const second = getCached("k")!;
            expect(second[0]).toEqual(1);
            expect(second[1]).toEqual(2);
        });

        it("the stored buffer is not observably affected by returned-copy mutation", () => {
            const v = new Float32Array([10, 20]);
            putCached("k", v);
            const a = getCached("k")!;
            a[0] = 0;
            const b = getCached("k")!;
            expect(Array.from(b)).toEqual([10, 20]);
        });

        it("overwrite: putting the same key twice keeps the latest value", () => {
            putCached("k", new Float32Array([1]));
            putCached("k", new Float32Array([2]));
            expect(Array.from(getCached("k")!)).toEqual([2]);
        });
    });

    describe("LRU eviction", () => {
        it("evicts the oldest entry when inserting past the cap", () => {
            for (let i = 0; i < EMBED_CACHE_MAX; i++) {
                putCached(`k${i}`, new Float32Array([i]));
            }
            expect(_cacheSizeForTests()).toEqual(EMBED_CACHE_MAX);

            putCached("new", new Float32Array([999]));

            expect(_cacheSizeForTests()).toEqual(EMBED_CACHE_MAX);
            expect(getCached("k0")).toBeUndefined();
            expect(getCached("new")).not.toBeUndefined();
        });

        it("touching an entry via getCached moves it to the end (LRU bump)", () => {
            for (let i = 0; i < EMBED_CACHE_MAX; i++) {
                putCached(`k${i}`, new Float32Array([i]));
            }

            // Bump k0 — it should now survive the next eviction
            getCached("k0");

            // Insert a new key; k1 should be evicted instead of k0
            putCached("new", new Float32Array([999]));

            expect(getCached("k0")).not.toBeUndefined();
            expect(getCached("k1")).toBeUndefined();
            expect(getCached("new")).not.toBeUndefined();
        });

        it("re-putting a key counts as a recent insert (moves to end)", () => {
            for (let i = 0; i < EMBED_CACHE_MAX; i++) {
                putCached(`k${i}`, new Float32Array([i]));
            }
            // Re-put k0 with a new value — Map.set updates the value
            // but does NOT move an existing key to end. Verify that.
            putCached("k0", new Float32Array([0]));
            putCached("new", new Float32Array([999]));
            // k0 was never bumped via getCached, so it should be evicted.
            expect(getCached("k0")).toBeUndefined();
        });

        it("many inserts past the cap keep the cache bounded", () => {
            for (let i = 0; i < EMBED_CACHE_MAX * 3; i++) {
                putCached(`k${i}`, new Float32Array([i]));
            }
            expect(_cacheSizeForTests()).toEqual(EMBED_CACHE_MAX);
            // Only the most recent EMBED_CACHE_MAX entries should survive
            expect(getCached(`k${EMBED_CACHE_MAX * 3 - 1}`)).not.toBeUndefined();
            expect(getCached("k0")).toBeUndefined();
        });

        it("_clearCacheForTests empties the cache", () => {
            putCached("k", new Float32Array([1]));
            expect(_cacheSizeForTests()).toEqual(1);
            _clearCacheForTests();
            expect(_cacheSizeForTests()).toEqual(0);
            expect(getCached("k")).toBeUndefined();
        });
    });

    describe("integration: key collision safety end-to-end", () => {
        it("different (type, text) pairs with ambiguous concatenation do not share a cached value", () => {
            const a = new Float32Array([1, 1, 1]);
            const b = new Float32Array([2, 2, 2]);

            putCached(makeCacheKey(":foo", "query"), a);
            putCached(makeCacheKey("foo", "query:"), b);

            const got1 = getCached(makeCacheKey(":foo", "query"))!;
            const got2 = getCached(makeCacheKey("foo", "query:"))!;

            expect(Array.from(got1)).toEqual([1, 1, 1]);
            expect(Array.from(got2)).toEqual([2, 2, 2]);
        });
    });

    describe("getOrFetchCached — inflight dedup", () => {
        it("runs fetch once and caches the result on cold cache", async () => {
            const fetch = vi.fn(async () => new Float32Array([42]));
            const a = await getOrFetchCached("k", fetch);
            expect(Array.from(a)).toEqual([42]);
            expect(fetch).toHaveBeenCalledOnce();
            // Second call should be a pure cache hit — fetch not called again.
            const b = await getOrFetchCached("k", fetch);
            expect(Array.from(b)).toEqual([42]);
            expect(fetch).toHaveBeenCalledOnce();
        });

        it("concurrent callers for the same key share one fetch", async () => {
            // Gate the fetch so we can interleave callers deterministically.
            let resolveFetch!: (v: Float32Array) => void;
            const fetchPromise = new Promise<Float32Array>((r) => {
                resolveFetch = r;
            });
            const fetch = vi.fn(() => fetchPromise);

            // Three callers start concurrently while the fetch is pending.
            const p1 = getOrFetchCached("k", fetch);
            const p2 = getOrFetchCached("k", fetch);
            const p3 = getOrFetchCached("k", fetch);

            expect(_inflightSizeForTests()).toEqual(1);
            // Only the first call started a fetch — the second and third
            // found the inflight promise and are awaiting it.
            expect(fetch).toHaveBeenCalledOnce();

            resolveFetch(new Float32Array([7]));
            const [a, b, c] = await Promise.all([p1, p2, p3]);

            expect(Array.from(a)).toEqual([7]);
            expect(Array.from(b)).toEqual([7]);
            expect(Array.from(c)).toEqual([7]);
            expect(fetch).toHaveBeenCalledOnce();
            expect(_inflightSizeForTests()).toEqual(0);
        });

        it("each concurrent caller receives an independent copy (mutation-safe)", async () => {
            let resolveFetch!: (v: Float32Array) => void;
            const fetchPromise = new Promise<Float32Array>((r) => {
                resolveFetch = r;
            });
            const fetch = () => fetchPromise;

            const p1 = getOrFetchCached("k", fetch);
            const p2 = getOrFetchCached("k", fetch);

            resolveFetch(new Float32Array([1, 2, 3]));
            const [a, b] = await Promise.all([p1, p2]);

            // Mutating caller A must not affect caller B or the cache.
            a[0] = 999;
            expect(b[0]).toEqual(1);
            const fromCache = getCached("k")!;
            expect(fromCache[0]).toEqual(1);
        });

        it("inflight map is cleared after fetch resolves (even on success)", async () => {
            const fetch = async () => new Float32Array([1]);
            await getOrFetchCached("k", fetch);
            expect(_inflightSizeForTests()).toEqual(0);
        });

        it("inflight map is cleared after fetch rejects", async () => {
            const fetch = async () => {
                throw new Error("boom");
            };
            await expect(getOrFetchCached("k", fetch)).rejects.toThrow("boom");
            expect(_inflightSizeForTests()).toEqual(0);
            // And the cache entry was NOT populated on failure.
            expect(getCached("k")).toBeUndefined();
        });

        it("inflight rejection rejects all concurrent waiters with the same error", async () => {
            let rejectFetch!: (err: Error) => void;
            const fetchPromise = new Promise<Float32Array>((_, rej) => {
                rejectFetch = rej;
            });
            const fetch = () => fetchPromise;

            const p1 = getOrFetchCached("k", fetch);
            const p2 = getOrFetchCached("k", fetch);
            const p3 = getOrFetchCached("k", fetch);

            rejectFetch(new Error("pipeline-down"));

            await expect(p1).rejects.toThrow("pipeline-down");
            await expect(p2).rejects.toThrow("pipeline-down");
            await expect(p3).rejects.toThrow("pipeline-down");
            expect(_inflightSizeForTests()).toEqual(0);
        });

        it("a later call after failure can retry with a fresh fetch", async () => {
            let attempt = 0;
            const fetch = async () => {
                attempt++;
                if (attempt === 1) throw new Error("once");
                return new Float32Array([99]);
            };

            await expect(getOrFetchCached("k", fetch)).rejects.toThrow("once");
            // Second call — inflight map was cleared in finally, so we
            // get a fresh attempt rather than sharing the rejected promise.
            const result = await getOrFetchCached("k", fetch);
            expect(Array.from(result)).toEqual([99]);
            expect(attempt).toEqual(2);
        });

        it("different keys run independent concurrent fetches", async () => {
            let resolveA!: (v: Float32Array) => void;
            let resolveB!: (v: Float32Array) => void;
            const fetchA = () =>
                new Promise<Float32Array>((r) => {
                    resolveA = r;
                });
            const fetchB = () =>
                new Promise<Float32Array>((r) => {
                    resolveB = r;
                });

            const pa = getOrFetchCached("a", fetchA);
            const pb = getOrFetchCached("b", fetchB);
            expect(_inflightSizeForTests()).toEqual(2);

            resolveB(new Float32Array([2]));
            resolveA(new Float32Array([1]));

            const [a, b] = await Promise.all([pa, pb]);
            expect(Array.from(a)).toEqual([1]);
            expect(Array.from(b)).toEqual([2]);
            expect(_inflightSizeForTests()).toEqual(0);
        });

        it("returns a cached entry without checking inflight when cache is warm", async () => {
            putCached("k", new Float32Array([50]));
            const fetch = vi.fn();
            const result = await getOrFetchCached("k", fetch as () => Promise<Float32Array>);
            expect(Array.from(result)).toEqual([50]);
            expect(fetch).not.toHaveBeenCalled();
        });

        it("successor to a cache-populating call hits the cache, not inflight", async () => {
            const fetch1 = vi.fn(async () => new Float32Array([1]));
            await getOrFetchCached("k", fetch1);
            // Cache populated. Next call should use cache, not inflight.
            const fetch2 = vi.fn();
            await getOrFetchCached("k", fetch2 as () => Promise<Float32Array>);
            expect(fetch2).not.toHaveBeenCalled();
        });
    });
});
