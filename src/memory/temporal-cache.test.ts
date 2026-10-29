// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "./sqlite.js";
import { TemporalCache } from "./temporal-cache.js";

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

    it("keys are exact: a different limit or scope is a different entry", () => {
        const key = (limit: number, scopes: string[]) => JSON.stringify(["q", limit, scopes, "", false]);
        cache.set(key(5, ["global", "group:a"]), [rec(1)]);
        expect(cache.get(key(5, ["global", "group:a"]))?.[0].id).toEqual(1);
        expect(cache.get(key(20, ["global", "group:a"]))).toBeNull();
        expect(cache.get(key(5, ["global", "group:b"]))).toBeNull();
    });

    it("set overwrites an existing entry for the same key", () => {
        cache.set("q", [rec(1)]);
        cache.set("q", [rec(2)]);
        expect(cache.get("q")?.[0].id).toEqual(2);
    });

    it("expires entries past the 5-minute TTL, counted from set", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
            cache.set("q", [rec(1)]);
            vi.setSystemTime(new Date("2025-01-01T00:04:30Z"));
            expect(cache.get("q")).not.toBeNull();
            vi.setSystemTime(new Date("2025-01-01T00:05:01Z"));
            expect(cache.get("q")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("evicts the least-recently-used entry at capacity", () => {
        cache.set("keep-me", [rec(0)]);
        for (let i = 1; i < 500; i++) cache.set(`q${i}`, [rec(i)]);
        cache.get("keep-me"); // bumps it past q1
        cache.set("one-more", [rec(500)]);
        expect(cache.get("keep-me")).not.toBeNull();
        expect(cache.get("q1")).toBeNull();
        expect(cache.get("q2")).not.toBeNull();
    });

    it("clearCache drops everything", () => {
        cache.set("q", [rec(1)]);
        cache.clearCache();
        expect(cache.get("q")).toBeNull();
    });
});
