// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { alignEmbeddings } from "./sleep-gate.js";

// Pure-logic guard for the sleep-gate misalignment fix. The full consolidation
// path needs better-sqlite3 + the native module (CI only), but the alignment
// that prevents forget/merge decisions hitting the wrong memory is pure.
describe("alignEmbeddings — rows stay in lockstep with embeddings", () => {
    const e = (v: number) => Float32Array.from([v]);

    it("drops the entry whose embedding is missing, keeping index alignment", () => {
        const rows = [{ id: 10 }, { id: 11 }, { id: 12 }];
        const embs = [e(10), null, e(12)]; // id 11 has no embedding row
        const out = alignEmbeddings(rows, embs);

        expect(out.rows.map(r => r.id)).toEqual([10, 12]);
        expect(out.embeddings.length).toBe(out.rows.length);
        // rows[i] must correspond to embeddings[i]
        expect(out.embeddings[0][0]).toBe(10);
        expect(out.embeddings[1][0]).toBe(12);
    });

    it("keeps everything when all embeddings are present", () => {
        const rows = [{ id: 1 }, { id: 2 }];
        const out = alignEmbeddings(rows, [e(1), e(2)]);
        expect(out.rows.length).toBe(2);
        expect(out.embeddings.length).toBe(2);
    });

    it("yields empty arrays when no embeddings loaded", () => {
        const out = alignEmbeddings([{ id: 1 }], [null]);
        expect(out.rows).toEqual([]);
        expect(out.embeddings).toEqual([]);
    });
});
