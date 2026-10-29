// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Boot rebuild used to compare only row counts, so forget + store (same
// count) left the new memory out of vector search.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-hnsw-"));
const { buildIndexFromDB, getHNSWIndex, resetIndex } = await import("./vector-index.js");

const vec = (seed: number) => Buffer.from(new Float32Array([seed, 1, 0.5, 0.25]).buffer);
const fakeDb = (ids: number[]) =>
    ({ prepare: () => ({ all: () => ids.map((id) => ({ memory_id: id, embedding: vec(id) })) }) }) as never;

it("rebuilds when ids change but the count ties", async () => {
    resetIndex(4);
    await buildIndexFromDB(fakeDb([1, 2]));
    await buildIndexFromDB(fakeDb([1, 3])); // #2 forgotten, #3 stored
    const index = getHNSWIndex();
    expect(index.has(3)).toBe(true);
    expect(index.has(2)).toBe(false);
    expect(index.size).toBe(2);
});
