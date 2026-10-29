// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, insertTool, searchByEmbedding } from "../library.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("library embedding cosine search", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "forge-emb-")); openLibrary(join(tmpDir, "lib.db")); });
    afterEach(() => { closeLibrary(); rmSync(tmpDir, { recursive: true, force: true }); });

    it("returns slugs sorted by descending cosine similarity", () => {
        // Three tools, with embeddings at varying distances from the query
        insertTool({ slug: "a", description: "a", schemaJson: "{}", handlerHash: "a", embedding: vector(0), source: "synchronous", createdAt: Date.now() });
        insertTool({ slug: "b", description: "b", schemaJson: "{}", handlerHash: "b", embedding: vector(1), source: "synchronous", createdAt: Date.now() });
        insertTool({ slug: "c", description: "c", schemaJson: "{}", handlerHash: "c", embedding: vector(2), source: "synchronous", createdAt: Date.now() });

        const queryEmb = vector(0); // identical to tool a
        const results = searchByEmbedding(queryEmb, ["a", "b", "c"], 0);
        expect(results[0].slug).toBe("a");
        expect(results[0].similarity).toBeGreaterThan(0.99);
    });

    it("filters by threshold", () => {
        insertTool({ slug: "a", description: "a", schemaJson: "{}", handlerHash: "a", embedding: vector(0), source: "synchronous", createdAt: Date.now() });
        insertTool({ slug: "b", description: "b", schemaJson: "{}", handlerHash: "b", embedding: vector(10), source: "synchronous", createdAt: Date.now() });

        const queryEmb = vector(0);
        const results = searchByEmbedding(queryEmb, ["a", "b"], 0.95);
        expect(results.map(r => r.slug)).toEqual(["a"]);
    });

    it("skips slugs not in the candidate list", () => {
        insertTool({ slug: "a", description: "a", schemaJson: "{}", handlerHash: "a", embedding: vector(0), source: "synchronous", createdAt: Date.now() });
        insertTool({ slug: "b", description: "b", schemaJson: "{}", handlerHash: "b", embedding: vector(0), source: "synchronous", createdAt: Date.now() });

        const queryEmb = vector(0);
        const results = searchByEmbedding(queryEmb, ["a"], 0);
        expect(results.map(r => r.slug)).toEqual(["a"]);
    });

    it("returns empty array for empty candidate list", () => {
        const results = searchByEmbedding(vector(0), [], 0);
        expect(results).toEqual([]);
    });
});
