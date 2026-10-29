// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { resolveQueryEmbedding } from "./resolve-embedding.js";

describe("resolveQueryEmbedding", () => {
    it("returns a Float32Array argument as-is without calling fallback", async () => {
        const emb = new Float32Array([1, 2, 3]);
        const fallback = vi.fn();
        const result = await resolveQueryEmbedding(emb, fallback as () => Promise<Float32Array>);
        expect(result).toBe(emb);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("awaits a Promise<Float32Array> and returns its resolved value", async () => {
        const emb = new Float32Array([4, 5, 6]);
        const fallback = vi.fn();
        const result = await resolveQueryEmbedding(
            Promise.resolve(emb),
            fallback as () => Promise<Float32Array>,
        );
        expect(Array.from(result)).toEqual([4, 5, 6]);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("falls back when the promise resolves to null", async () => {
        const fallbackEmb = new Float32Array([9, 9, 9]);
        const fallback = vi.fn(async () => fallbackEmb);
        const result = await resolveQueryEmbedding(Promise.resolve(null), fallback);
        expect(Array.from(result)).toEqual([9, 9, 9]);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it("falls back when the argument is null", async () => {
        const fallbackEmb = new Float32Array([1]);
        const fallback = vi.fn(async () => fallbackEmb);
        const result = await resolveQueryEmbedding(null, fallback);
        expect(result).toBe(fallbackEmb);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it("falls back when the argument is undefined", async () => {
        const fallbackEmb = new Float32Array([1]);
        const fallback = vi.fn(async () => fallbackEmb);
        const result = await resolveQueryEmbedding(undefined, fallback);
        expect(result).toBe(fallbackEmb);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it("prefers Float32Array over a race with a concurrent fallback — fallback is never started", async () => {
        const emb = new Float32Array([7]);
        let fallbackStarted = false;
        const fallback = async () => {
            fallbackStarted = true;
            return new Float32Array([0]);
        };
        const result = await resolveQueryEmbedding(emb, fallback);
        expect(result).toBe(emb);
        expect(fallbackStarted).toBe(false);
    });

    it("propagates a rejected promise without silently falling back", async () => {
        const fallback = vi.fn();
        await expect(
            resolveQueryEmbedding(
                Promise.reject(new Error("boom")),
                fallback as () => Promise<Float32Array>,
            ),
        ).rejects.toThrow("boom");
        // Rejection should NOT trigger fallback — the caller's try/catch owns this.
        expect(fallback).not.toHaveBeenCalled();
    });

    it("propagates a fallback error when the input signals 'no embedding'", async () => {
        const fallback = vi.fn(async () => {
            throw new Error("pipeline-down");
        });
        await expect(resolveQueryEmbedding(null, fallback)).rejects.toThrow("pipeline-down");
    });

    it("returns an empty Float32Array faithfully (does not treat length-0 as 'null')", async () => {
        const empty = new Float32Array(0);
        const fallback = vi.fn();
        const result = await resolveQueryEmbedding(empty, fallback as () => Promise<Float32Array>);
        expect(result).toBe(empty);
        expect(result.length).toEqual(0);
        expect(fallback).not.toHaveBeenCalled();
    });
});
