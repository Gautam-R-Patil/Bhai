// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Query-embedding resolver ────────────────────────────────────
// Small helper that unifies the three ways recall() can receive a
// query embedding:
//   1. A Float32Array already computed by the caller                 — use as-is
//   2. A Promise<Float32Array | null> kicked off in parallel         — await it
//   3. null / undefined (caller didn't provide one)                  — fall back
// plus the degenerate case of a Promise that resolves to null        — fall back
//
// Rejected promises propagate. The single caller at recall() in
// sqlite.ts wraps the whole HNSW block in a try/catch already, so
// propagation is correct — if we swallowed here the caller couldn't
// tell "embedding unavailable" from "embedding threw with a real
// error worth logging".

/**
 * Resolve a query-embedding input of any shape into a concrete
 * Float32Array, falling back to `fallback()` only when the input
 * itself signals "no embedding available" (null, undefined, or a
 * Promise that resolves to null).
 */
export async function resolveQueryEmbedding(
    provided: Float32Array | Promise<Float32Array | null> | null | undefined,
    fallback: () => Promise<Float32Array>,
): Promise<Float32Array> {
    if (provided instanceof Float32Array) return provided;
    if (provided) {
        const resolved = await provided;
        if (resolved) return resolved;
    }
    return await fallback();
}
