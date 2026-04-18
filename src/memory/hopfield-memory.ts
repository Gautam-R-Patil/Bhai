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

// ── Operations ────────────────────────────────

/**
 * Add a memory pattern to the Hopfield store.
 */
export function addPattern(id: number, embedding: Float32Array, content: string): void {
    storedPatterns.set(id, embedding);
    storedContent.set(id, content);
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
    const native = loadNative();
    if (native && storedPatterns.size > 0) {
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
    for (const entry of entries) {
        storedPatterns.set(entry.id, entry.embedding);
        storedContent.set(entry.id, entry.content);
    }
    console.log(`[HOPFIELD] Loaded ${entries.length} patterns for associative memory`);
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
