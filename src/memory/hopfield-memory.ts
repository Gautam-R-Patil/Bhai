// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Hopfield Associative Memory ──────────────────
 * Modern continuous Hopfield network for pattern-completion retrieval.
 * Given a partial cue, completes to the nearest stored memory pattern.
 * Enables "reminds me of" retrieval — find memories by association.
 */

import { embedText, cosineSimilarity, isReady } from "./embeddings.js";

// ── Types ─────────────────────────────────────

export interface AssociativeResult {
    memoryId: number;
    content: string;
    similarity: number;
    isAssociative: boolean;  // True if found by association (not exact match)
}

// ── Store ─────────────────────────────────────

const storedPatterns: Map<number, Float32Array> = new Map();
const storedContent: Map<number, string> = new Map();

// Each pattern is a 384-dim Float32Array ≈ 1.5 KB plus the string content.
// Without a cap, the store grows monotonically over the process lifetime
// (nightly reflection + user writes never trigger eviction). Cap at 5000 —
// associative recall with more than that starts to drown signal anyway.
// Override with ATLAS_HOPFIELD_MAX_PATTERNS for harness/bench experiments.
const MAX_HOPFIELD_PATTERNS = (() => {
    const raw = process.env.ATLAS_HOPFIELD_MAX_PATTERNS;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

// Evict the oldest entry when the cap is hit. Map preserves insertion order
// so `keys().next()` returns the oldest pattern first.
function evictOldestIfFull(): void {
    while (storedPatterns.size >= MAX_HOPFIELD_PATTERNS) {
        const oldest = storedPatterns.keys().next().value;
        if (oldest === undefined) break;
        storedPatterns.delete(oldest);
        storedContent.delete(oldest);
    }
}

// ── Operations ────────────────────────────────

/**
 * Add a memory pattern to the Hopfield store.
 */
export function addPattern(id: number, embedding: Float32Array, content: string): void {
    if (!storedPatterns.has(id)) evictOldestIfFull();
    storedPatterns.set(id, embedding);
    storedContent.set(id, content);
}

// Remove a pattern when its backing memory row is deleted — keeps the store
// coherent with sqlite after user "forget this" operations. Silent no-op when
// the id was never stored.
export function removePattern(id: number): void {
    storedPatterns.delete(id);
    storedContent.delete(id);
}

/**
 * Associative retrieval: given a partial/noisy cue, find the closest stored memory.
 * Uses native Hopfield network when available, falls back to cosine search.
 */
export async function associativeRecall(
    cue: string,
    topK = 5,
): Promise<AssociativeResult[]> {
    if (!isReady() || storedPatterns.size === 0) return [];

    const cueEmbedding = await embedText(cue, "query");

    // Try native Hopfield
    // Guard the exact export, not just truthiness: a stale/partial native build
    // can load (native is truthy) yet lack hopfieldRetrieve, and there is no
    // try/catch here — an unguarded call would throw instead of falling back.
    const native = loadNative();
    if (native?.hopfieldRetrieve && storedPatterns.size > 0) {
        const patterns = [...storedPatterns.values()];
        const ids = [...storedPatterns.keys()];

        const result = native.hopfieldRetrieve(patterns, cueEmbedding, 10.0);

        if (result.pattern_index >= 0 && result.similarity > 0.3) {
            const matchedId = ids[result.pattern_index];
            const content = storedContent.get(matchedId) || "";

            // Also get top-K by running batch comparison
            const results: AssociativeResult[] = [];
            const scored = ids.map((id, i) => ({
                id,
                content: storedContent.get(id) || "",
                similarity: cosineSimilarity(cueEmbedding, patterns[i]),
            }));
            scored.sort((a, b) => b.similarity - a.similarity);

            for (const s of scored.slice(0, topK)) {
                results.push({
                    memoryId: s.id,
                    content: s.content,
                    similarity: s.similarity,
                    isAssociative: s.id === matchedId,
                });
            }

            return results;
        }
    }

    // JS fallback: standard cosine similarity search
    const ids = [...storedPatterns.keys()];
    const results: AssociativeResult[] = [];

    for (const id of ids) {
        const pattern = storedPatterns.get(id)!;
        const sim = cosineSimilarity(cueEmbedding, pattern);
        results.push({
            memoryId: id,
            content: storedContent.get(id) || "",
            similarity: sim,
            isAssociative: false,
        });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
}

/**
 * Load patterns from the HNSW index (at boot).
 */
export function loadFromHNSW(entries: Array<{ id: number; embedding: Float32Array; content: string }>): void {
    // Cap-aware load: if the boot set exceeds the retention cap, keep only
    // the most recent MAX_HOPFIELD_PATTERNS entries (assumes entries arrive
    // roughly ordered by memory id / recency).
    const retained =
        entries.length > MAX_HOPFIELD_PATTERNS
            ? entries.slice(-MAX_HOPFIELD_PATTERNS)
            : entries;
    for (const entry of retained) {
        storedPatterns.set(entry.id, entry.embedding);
        storedContent.set(entry.id, entry.content);
    }
    console.log(`[HOPFIELD] Loaded ${retained.length} patterns for associative memory (cap ${MAX_HOPFIELD_PATTERNS})`);
}

export function getPatternCount(): number {
    return storedPatterns.size;
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;
function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const r = createRequire(import.meta.url);
        const path = require("node:path");
        _native = r(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
