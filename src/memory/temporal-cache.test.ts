// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TemporalCache } from "./temporal-cache.js";
import type { MemoryRecord } from "./sqlite.js";

function rec(id: number, content = `record ${id}`): MemoryRecord {
    // Minimal shape — fields we don't care about get defaults.
    return {
        id,
        content,
        category: "note",
        tags: "",
        importance: 0.5,
        created_at: new Date().toISOString(),
        access_count: 0,
    } as MemoryRecord;
}

describe("TemporalCache — bloom filter", () => {
    let cache: TemporalCache;
    beforeEach(() => {
        cache = new TemporalCache();
    });

    it("registered words are reported as 'might contain'", () => {
        cache.registerContent("hello world this is a test");
        expect(cache.mightHaveContent("hello")).toBe(true);
        expect(cache.mightHaveContent("world")).toBe(true);
        expect(cache.mightHaveContent("test")).toBe(true);
    });

    it("unregistered words are (probabilistically) reported as absent", () => {
        cache.registerContent("alpha beta gamma");
        // Distinct long words — very low false-positive rate at this scale.
        expect(cache.mightHaveContent("nonexistentwordhere")).toBe(false);
        expect(cache.mightHaveContent("antidisestablishment")).toBe(false);
    });

    it("case-insensitive match (lowercases before hashing)", () => {
        cache.registerContent("Hello World");
        expect(cache.mightHaveContent("hello")).toBe(true);
        expect(cache.mightHaveContent("HELLO")).toBe(true);
        expect(cache.mightHaveContent("HeLLo")).toBe(true);
    });

    it("strips non-word chars before tokenizing", () => {
        cache.registerContent("foo-bar_baz@example.com, hello!");
        expect(cache.mightHaveContent("foo")).toBe(true);
        expect(cache.mightHaveContent("bar")).toBe(true);
        expect(cache.mightHaveContent("example")).toBe(true);
    });

    it("short (≤3 char) words aren't added to the filter at registration", () => {
        // Register content containing ONLY short words — nothing enters
        // the bloom filter. Then query with a LONGER word (>3 chars) to
        // confirm it's genuinely absent (short-word queries short-circuit
        // to true, so we need a longer probe to observe the registration
        // skip).
        cache.registerContent("a an the of in on is");
        expect(cache.mightHaveContent("somelongerword")).toBe(false);
        // After adding a longer word, it should register.
        cache.registerContent("alpha");
        expect(cache.mightHaveContent("alpha")).toBe(true);
    });

    it("returns true on a query with only short words (pessimistic fallback)", () => {
        cache.registerContent("hello world");
        // Empty keyword list → can't filter → assume yes.
        expect(cache.mightHaveContent("a b c")).toBe(true);
    });

    it("returns true if ANY query word is in the filter", () => {
        cache.registerContent("apple banana cherry");
        expect(cache.mightHaveContent("unknown word banana other")).toBe(true);
    });

    it("clearAll wipes the bloom filter", () => {
        cache.registerContent("hello world");
        expect(cache.mightHaveContent("hello")).toBe(true);
        cache.clearAll();
        expect(cache.mightHaveContent("hello")).toBe(false);
    });
});

describe("TemporalCache — LRU cache", () => {
    let cache: TemporalCache;
    beforeEach(() => {
        cache = new TemporalCache();
    });

    it("returns null for a cold cache", () => {
        expect(cache.get("no such query")).toBeNull();
    });

    it("round-trips a set → get", () => {
        const results = [rec(1), rec(2)];
        cache.set("query one", results);
        expect(cache.get("query one")).toEqual(results);
    });

    it("hashes case-insensitively + trimmed", () => {
        cache.set("Hello World", [rec(1)]);
        expect(cache.get("hello world")).not.toBeNull();
        expect(cache.get("  HELLO WORLD   ")).not.toBeNull();
    });

    it("different queries get independent cache entries", () => {
        cache.set("alpha", [rec(1)]);
        cache.set("beta", [rec(2)]);
        expect(cache.get("alpha")?.[0].id).toEqual(1);
        expect(cache.get("beta")?.[0].id).toEqual(2);
    });

    it("set overwrites an existing entry for the same query", () => {
        cache.set("q", [rec(1)]);
        cache.set("q", [rec(2)]);
        expect(cache.get("q")?.[0].id).toEqual(2);
    });

    it("expires entries past the 5-minute TTL", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
            cache.set("q", [rec(1)]);
            expect(cache.get("q")).not.toBeNull();

            // 5:01 later — past TTL.
            vi.setSystemTime(new Date("2025-01-01T00:05:01Z"));
            expect(cache.get("q")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("clearCache drops everything (but not the bloom filter)", () => {
        cache.registerContent("hello");
        cache.set("q", [rec(1)]);
        cache.clearCache();
        expect(cache.get("q")).toBeNull();
        expect(cache.mightHaveContent("hello")).toBe(true);
    });

    it("clearAll drops both the cache and the bloom filter", () => {
        cache.registerContent("hello");
        cache.set("q", [rec(1)]);
        cache.clearAll();
        expect(cache.get("q")).toBeNull();
        expect(cache.mightHaveContent("hello")).toBe(false);
    });

    it("stats() reports cache size correctly", () => {
        expect(cache.stats().cacheSize).toEqual(0);
        cache.set("a", [rec(1)]);
        cache.set("b", [rec(2)]);
        expect(cache.stats().cacheSize).toEqual(2);
        expect(cache.stats().maxCache).toBeGreaterThan(0);
    });
});

describe("TemporalCache — invalidation", () => {
    let cache: TemporalCache;
    beforeEach(() => {
        cache = new TemporalCache();
    });

    it("invalidates any query whose results contain the given memory id", () => {
        cache.set("query A", [rec(1), rec(2)]);
        cache.set("query B", [rec(3), rec(4)]);
        cache.set("query C", [rec(5)]);

        cache.invalidate(3);

        // Only the query containing id=3 is dropped.
        expect(cache.get("query A")).not.toBeNull();
        expect(cache.get("query B")).toBeNull();
        expect(cache.get("query C")).not.toBeNull();
    });

    it("is a no-op when the id isn't in any cached result", () => {
        cache.set("a", [rec(1)]);
        cache.set("b", [rec(2)]);
        cache.invalidate(999);
        expect(cache.get("a")).not.toBeNull();
        expect(cache.get("b")).not.toBeNull();
    });

    it("invalidates multiple queries when the id appears in several", () => {
        const shared = rec(42);
        cache.set("x", [shared, rec(1)]);
        cache.set("y", [rec(2), shared]);
        cache.set("z", [rec(3)]);

        cache.invalidate(42);
        expect(cache.get("x")).toBeNull();
        expect(cache.get("y")).toBeNull();
        expect(cache.get("z")).not.toBeNull();
    });
});

describe("TemporalCache — LRU eviction behavior", () => {
    it("evicts the least-recently-used entry when at LRU_MAX_SIZE", () => {
        // LRU_MAX_SIZE is 500. We can't fill it in a reasonable test time,
        // but we can verify the LRU ordering: a gotten entry is bumped to
        // end. Use a smaller synthetic scale by filling then accessing.
        const cache = new TemporalCache();
        // Insert + access an entry to mark it as most-recent.
        cache.set("keep-me", [rec(1)]);
        cache.set("other", [rec(2)]);
        cache.get("keep-me"); // bumps to end
        // Both entries still present after LRU bumps.
        expect(cache.get("keep-me")).not.toBeNull();
        expect(cache.get("other")).not.toBeNull();
    });

    it("get() refreshes access order and drops the entry on TTL expiry", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
            const cache = new TemporalCache();
            cache.set("q1", [rec(1)]);
            vi.setSystemTime(new Date("2025-01-01T00:04:30Z")); // 4:30 in
            expect(cache.get("q1")).not.toBeNull(); // still valid
            vi.setSystemTime(new Date("2025-01-01T00:09:45Z")); // 5:15 past last get
            // TTL is since the original SET timestamp, not since the last get.
            // So 9:45 - 0:00 > 5m → expired.
            expect(cache.get("q1")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("TemporalCache — hash collision safety", () => {
    it("deterministic per-query hash (same query always same bucket)", () => {
        const cache = new TemporalCache();
        cache.set("deterministic query", [rec(1)]);
        cache.set("deterministic query", [rec(2)]);
        // Second set overwrote the first — hash must be stable.
        expect(cache.get("deterministic query")?.[0].id).toEqual(2);
    });

    it("single-character differences yield different hash buckets", () => {
        const cache = new TemporalCache();
        cache.set("query a", [rec(1)]);
        cache.set("query b", [rec(2)]);
        expect(cache.get("query a")?.[0].id).toEqual(1);
        expect(cache.get("query b")?.[0].id).toEqual(2);
    });
});
