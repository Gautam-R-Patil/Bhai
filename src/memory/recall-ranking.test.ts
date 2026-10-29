// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Hermetic: point the memory DB at a throwaway temp dir BEFORE importing sqlite
// (its DATA_DIR const reads process.env.ATLAS_DATA_DIR at load).
process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-recall-ranking-"));

type SqliteModule = typeof import("./sqlite.js");
let sqlite: SqliteModule;

beforeAll(async () => {
    sqlite = await import("./sqlite.js");
    await sqlite.initMemoryDB();
    const raw = sqlite.getRawDb();
    if (!raw) throw new Error("raw DB unavailable");
    const ins = raw.prepare(
        "INSERT INTO memories (content, category, importance, decay_score, scope, consolidated_into) VALUES (?, ?, ?, ?, ?, ?)",
    );
    ins.run("zebracorn: user prefers dark roast coffee", "preference", 9, 1.0, "global", null);
    ins.run("zebracorn stale fact", "preference", 10, 0, "global", null); // smart-write "deleted"
    ins.run("zebracorn archived original", "preference", 10, 1.0, "global", 1); // consolidated
    ins.run("zebracorn session scratch", "general", 10, 1.0, "session:abc", null);
    ins.run('{"action":"zebracorn","sig":"deadbeef"}', "audit_log", 10, 1.0, "global", null);
    ins.run('{"id":"b1","name":"zebracorn brand"}', "brand", 10, 1.0, "global", null);
});

describe("normalizedFusionScore", () => {
    it("is 1 for rank 1 in every active retriever", () => {
        expect(sqlite.normalizedFusionScore([1, 1, 1], 3)).toBeCloseTo(1);
        expect(sqlite.normalizedFusionScore([1, undefined, undefined], 1)).toBeCloseTo(1);
    });

    it("rewards cross-retriever agreement and decays with rank", () => {
        const single = sqlite.normalizedFusionScore([1, undefined, undefined], 3);
        const pair = sqlite.normalizedFusionScore([1, 1, undefined], 3);
        expect(pair).toBeGreaterThan(single);
        expect(sqlite.normalizedFusionScore([40, undefined, undefined], 3)).toBeLessThan(single);
        expect(sqlite.normalizedFusionScore([undefined, undefined, undefined], 3)).toBe(0);
    });

    it("puts relevance on the same 0-1 scale as recency/importance", () => {
        // A strong match with low importance must beat a weak match with max importance
        // under the default 0.5/0.25/0.25 blend (equal recency).
        const blend = (rel: number, imp: number) => 0.5 * rel + 0.25 * 1 + 0.25 * imp;
        const strong = blend(sqlite.normalizedFusionScore([1, 1, 1], 3), 0.2);
        const weak = blend(sqlite.normalizedFusionScore([30, undefined, undefined], 3), 1.0);
        expect(strong).toBeGreaterThan(weak);
    });
});

describe("visibility filters", () => {
    it("getCoreMemory skips decayed, consolidated, scoped, audit and JSON rows", () => {
        const core = sqlite.getCoreMemory(10).map((m) => m.content);
        expect(core).toEqual(["zebracorn: user prefers dark roast coffee"]);
    });

    it("recall applies the same filters on the FTS path", async () => {
        const hits = (await sqlite.recall("zebracorn", 10)).map((m) => m.content);
        expect(hits).toEqual(["zebracorn: user prefers dark roast coffee"]);
    });
});

describe("ageLabel", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    it("reads SQLite datetime('now') strings as UTC", () => {
        expect(sqlite.dbTimeMs("2026-10-29 11:00:00")).toBe(Date.parse("2026-10-29T11:00:00Z"));
        expect(sqlite.dbTimeMs("2026-10-29T11:00:00.000Z")).toBe(Date.parse("2026-10-29T11:00:00Z"));
        expect(sqlite.dbTimeMs("2026-10-29T16:30:00+05:30")).toBe(Date.parse("2026-10-29T11:00:00Z"));
    });

    it("buckets by day, week, month and year", () => {
        expect(sqlite.ageLabel("2026-10-29 11:00:00", now)).toBe("today");
        expect(sqlite.ageLabel("2026-10-26 12:00:00", now)).toBe("3d ago");
        expect(sqlite.ageLabel("2026-10-08 12:00:00", now)).toBe("3w ago");
        expect(sqlite.ageLabel("2026-07-29 12:00:00", now)).toBe("3mo ago");
        expect(sqlite.ageLabel("2024-10-01 12:00:00", now)).toBe("2y ago");
        expect(sqlite.ageLabel("", now)).toBe("undated");
    });
});

describe("parseDateWindow", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const daysBefore = (iso: string | undefined) => (now.getTime() - Date.parse(iso ?? "")) / 86_400_000;

    it("returns no window for messages without a time phrase", () => {
        expect(sqlite.parseDateWindow("what's my coffee order?", now)).toEqual({});
    });

    it("maps yesterday to the previous local day", () => {
        const w = sqlite.parseDateWindow("What did I say yesterday?", now);
        expect(Date.parse(w.until ?? "") - Date.parse(w.since ?? "")).toBe(86_400_000);
        expect(Date.parse(w.until ?? "")).toBeLessThanOrEqual(now.getTime());
    });

    it("maps last week / last month to open-ended windows", () => {
        expect(daysBefore(sqlite.parseDateWindow("the place from last week", now).since)).toBe(14);
        expect(sqlite.parseDateWindow("the place from last week", now).until).toBeUndefined();
        expect(daysBefore(sqlite.parseDateWindow("last month's trip", now).since)).toBe(62);
    });

    it("maps N days / weeks ago to a window around that point", () => {
        const d = sqlite.parseDateWindow("the link I sent 3 days ago", now);
        expect([daysBefore(d.since), daysBefore(d.until)]).toEqual([4, 2]);
        const w = sqlite.parseDateWindow("2 weeks ago we talked", now);
        expect([daysBefore(w.since), daysBefore(w.until)]).toEqual([21, 7]);
    });
});

describe("recallConversation", () => {
    it("ranks the summary matching the most terms first, newest only as tiebreak", async () => {
        const raw = sqlite.getRawDb();
        if (!raw) throw new Error("raw DB unavailable");
        const ins = raw.prepare("INSERT INTO conversations (session_id, messages_json, summary, created_at) VALUES (?, '[]', ?, ?)");
        ins.run("s1", "quokkatesla stock earnings call notes", "2026-01-01 00:00:00");
        ins.run("s2", "quokkatesla road trip", "2026-06-01 00:00:00");
        const hits = await sqlite.recallConversation("quokkatesla stock earnings", 5);
        expect(hits.map((h) => h.session_id)).toEqual(["s1", "s2"]);
    });
});

describe("recall cache", () => {
    it("is keyed on scopes and limit, not just the query text", async () => {
        // Global first, then the same text with the session scope: the cached global-only
        // answer must not stand in for it.
        expect((await sqlite.recall("zebracorn", 10)).map((m) => m.content)).not.toContain("zebracorn session scratch");
        const scoped = (await sqlite.recall("zebracorn", 10, undefined, undefined, ["session:abc"])).map((m) => m.content);
        expect(scoped).toContain("zebracorn session scratch");
        expect(await sqlite.recall("zebracorn", 1, undefined, undefined, ["session:abc"])).toHaveLength(1);
        expect(await sqlite.recall("zebracorn", 10, undefined, undefined, ["session:abc"])).toHaveLength(scoped.length);
    });
});

describe("recall with non-Latin queries", () => {
    it("matches Hindi words and returns nothing (not every memory) for an unrelated query", async () => {
        sqlite
            .getRawDb()
            ?.prepare("INSERT INTO memories (content, category, importance, decay_score, scope) VALUES (?, ?, ?, ?, ?)")
            .run("माँ का जन्मदिन बारह मार्च को है", "personal", 8, 1.0, "global");
        expect((await sqlite.recall("जन्मदिन कब है", 5)).map((m) => m.content)).toContain("माँ का जन्मदिन बारह मार्च को है");
        expect(await sqlite.recall("привет мир", 5)).toEqual([]);
        expect(await sqlite.recall("?!", 5)).toEqual([]);
    });
});
