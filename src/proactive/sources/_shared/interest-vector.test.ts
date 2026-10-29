// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../memory/sqlite.js", () => ({
    recall: vi.fn(async () => [
        { content: "interested in machine learning and neural networks" },
        { content: "learning typescript programming patterns" },
        { content: "exploring typescript async patterns and typescript generics" },
    ]),
}));

vi.mock("../../../memory/embeddings.js", () => ({
    embedText: vi.fn(async (text: string) => {
        // Return a deterministic 4-dim float32 array based on text length
        const arr = new Float32Array(4);
        arr[0] = text.length / 100;
        arr[1] = 0.5;
        arr[2] = 0.25;
        arr[3] = 0.1;
        return arr;
    }),
}));

vi.mock("node:fs/promises", () => ({
    stat: vi.fn(async () => { throw new Error("ENOENT"); }),
    readFile: vi.fn(async () => { throw new Error("ENOENT"); }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));

import { getInterestVector, _resetInterestVectorCache } from "./interest-vector.js";
import { recall } from "../../../memory/sqlite.js";
import { embedText } from "../../../memory/embeddings.js";
import * as fsMod from "node:fs/promises";

describe("interest-vector", () => {
    beforeEach(() => {
        _resetInterestVectorCache();
        vi.mocked(recall).mockClear();
        vi.mocked(embedText).mockClear();
        vi.mocked(fsMod.stat).mockRejectedValue(new Error("ENOENT"));
        vi.mocked(fsMod.readFile).mockRejectedValue(new Error("ENOENT"));
        vi.mocked(fsMod.mkdir).mockResolvedValue(undefined);
        vi.mocked(fsMod.writeFile).mockResolvedValue(undefined);
    });

    it("builds vector from memory recall results", async () => {
        const result = await getInterestVector();
        expect(result.vector).toHaveLength(4);
        expect(result.keywords.length).toBeGreaterThanOrEqual(1);
        expect(result.builtAt).toBeGreaterThan(0);
    });

    it("extracts top keywords by frequency (stopwords excluded)", async () => {
        const result = await getInterestVector();
        // "typescript" appears 3 times across the texts — should be top keyword
        expect(result.keywords).toContain("typescript");
        // stopwords like "and", "in" should be excluded
        for (const kw of result.keywords) {
            expect(["and", "in", "the", "for"]).not.toContain(kw);
        }
    });

    it("returns at most KEYWORD_COUNT (3) keywords", async () => {
        const result = await getInterestVector();
        expect(result.keywords.length).toBeLessThanOrEqual(3);
    });

    it("caches result within week — only one recall call", async () => {
        await getInterestVector();
        await getInterestVector();
        expect(recall).toHaveBeenCalledTimes(1);
    });

    it("reads from disk when file is fresh (mtime within week)", async () => {
        const fresh: ReturnType<typeof JSON.parse> = {
            vector: [0.1, 0.2],
            keywords: ["rust", "ml"],
            builtAt: Date.now() - 1000,
        };
        vi.mocked(fsMod.stat).mockResolvedValueOnce({ mtimeMs: Date.now() - 1000 } as any);
        vi.mocked(fsMod.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(fresh)) as any);
        const result = await getInterestVector();
        expect(result.keywords).toEqual(["rust", "ml"]);
        expect(recall).not.toHaveBeenCalled();
    });

    it("rebuilds when disk file is older than a week", async () => {
        const stale = {
            vector: [0.1],
            keywords: ["old"],
            builtAt: Date.now() - 8 * 86_400_000,
        };
        const weekAgo = Date.now() - 8 * 86_400_000;
        vi.mocked(fsMod.stat).mockResolvedValueOnce({ mtimeMs: weekAgo } as any);
        vi.mocked(fsMod.readFile).mockResolvedValueOnce(Buffer.from(JSON.stringify(stale)) as any);
        const result = await getInterestVector();
        // Should have called recall to rebuild
        expect(recall).toHaveBeenCalled();
        // Keywords rebuilt from fresh data
        expect(result.keywords).toContain("typescript");
    });

    it("returns empty vector gracefully when recall returns no results", async () => {
        vi.mocked(recall).mockResolvedValueOnce([]);
        const result = await getInterestVector();
        expect(result.vector).toHaveLength(384);
        expect(result.vector.every(v => v === 0)).toBe(true);
        expect(result.keywords).toHaveLength(0);
    });
});
