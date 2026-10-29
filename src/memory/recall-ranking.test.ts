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
