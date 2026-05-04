// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach } from "vitest";
import {
    makeCacheKey,
    getCached,
    putCached,
    EMBED_CACHE_MAX,
    _clearCacheForTests,
    _cacheSizeForTests,
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
});
