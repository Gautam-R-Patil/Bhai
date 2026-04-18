// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── LLM Semantic Response Cache ──────────────
// Caches LLM responses for semantically similar queries.
// Uses existing embedding infrastructure (bge-small-en-v1.5, 384-dim)
// for similarity matching via cosine distance.
//
// Only caches simple queries — responses with tool calls, streaming,
// or extended thinking are NOT cached (too contextual).

import type { ChatCompletion } from "openai/resources/chat/completions.js";

// ── Configuration ────────────────────────────

const MAX_CACHE_SIZE = 200;        // Maximum cached entries (LRU eviction)
const CACHE_TTL_MS = 3 * 60_000;   // 3 minutes TTL (shorter to avoid stale intent classifications)
const SIMILARITY_THRESHOLD = 0.88; // Cosine similarity threshold for cache hit (lowered from 0.95 to reduce false positives on follow-up messages)
const MIN_QUERY_LENGTH = 10;       // Don't cache very short queries
const MAX_QUERY_LENGTH = 500;      // Don't cache very long queries (too contextual)

// ── Cache Entry ──────────────────────────────

interface CacheEntry {
    queryText: string;
    queryEmbedding: Float32Array;
    response: ChatCompletion;
    model: string;
    createdAt: number;
    hitCount: number;
}

// ── Cache State ──────────────────────────────

const cache: CacheEntry[] = [];
let embedModule: {
    embedText: (text: string) => Promise<Float32Array>;
    cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
} | null = null;

let totalHits = 0;
let totalMisses = 0;

// ── Lazy Load Embeddings ─────────────────────

async function getEmbedModule() {
    if (!embedModule) {
        try {
            const mod = await import("./memory/embeddings.js");
            embedModule = {
                embedText: mod.embedText,
                cosineSimilarity: mod.cosineSimilarity,
            };
        } catch {
            return null;
        }
    }
    return embedModule;
}

// ── Public API ───────────────────────────────

/**
 * Check cache for a similar query. Returns cached response or null.
 */
export async function getCachedResponse(
    queryText: string,
    model: string,
): Promise<ChatCompletion | null> {
    // Skip caching for very short or very long queries
    if (queryText.length < MIN_QUERY_LENGTH || queryText.length > MAX_QUERY_LENGTH) {
        return null;
    }

    const embed = await getEmbedModule();
    if (!embed) return null;

    const now = Date.now();

    // Evict expired entries
    for (let i = cache.length - 1; i >= 0; i--) {
        if (now - cache[i].createdAt > CACHE_TTL_MS) {
            cache.splice(i, 1);
        }
    }

    // Embed the query
    let queryEmbedding: Float32Array;
    try {
        queryEmbedding = await embed.embedText(queryText);
    } catch {
        return null;
    }

    // Search for similar cached queries
    let bestMatch: CacheEntry | null = null;
    let bestSimilarity = 0;

    for (const entry of cache) {
        // Must be same model
        if (entry.model !== model) continue;

        const similarity = embed.cosineSimilarity(queryEmbedding, entry.queryEmbedding);
        if (similarity > bestSimilarity && similarity >= SIMILARITY_THRESHOLD) {
            bestSimilarity = similarity;
            bestMatch = entry;
        }
    }

    if (bestMatch) {
        bestMatch.hitCount++;
        totalHits++;
        console.log(`[LLM-CACHE] ✅ Cache hit (similarity: ${bestSimilarity.toFixed(3)}, hits: ${bestMatch.hitCount}): "${queryText.substring(0, 60)}..."`);
        return bestMatch.response;
    }

    totalMisses++;
    return null;
}

/**
 * Store a response in the cache.
 * Only caches responses that are simple text (no tool calls).
 */
export function cacheResponse(
    queryText: string,
    queryEmbedding: Float32Array | null,
    model: string,
    response: ChatCompletion,
): void {
    // Don't cache responses with tool calls
    const choice = response.choices?.[0];
    if (!choice) return;
    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) return;
    if (choice.finish_reason === "tool_calls") return;

    // Don't cache empty responses
    if (!choice.message?.content || choice.message.content.length < 10) return;

    // Don't cache if query is too short/long
    if (queryText.length < MIN_QUERY_LENGTH || queryText.length > MAX_QUERY_LENGTH) return;

    // Need an embedding
    if (!queryEmbedding) return;

    // Evict least valuable entry if at capacity (LRU-like: oldest + fewest hits)
    if (cache.length >= MAX_CACHE_SIZE) {
        let evictIdx = 0;
        let lowestValue = Infinity;
        const now = Date.now();
        for (let i = 0; i < cache.length; i++) {
            // Higher value = more worth keeping (recent + frequently hit)
            // Lower value = better eviction candidate
            const ageMs = now - cache[i].createdAt;
            const value = cache[i].hitCount * 60000 - ageMs; // hits boost value, age reduces it
            if (value < lowestValue) {
                lowestValue = value;
                evictIdx = i;
            }
        }
        cache.splice(evictIdx, 1);
    }

    cache.push({
        queryText,
        queryEmbedding,
        response,
        model,
        createdAt: Date.now(),
        hitCount: 0,
    });
}

/**
 * Embed a query for later caching. Call before the LLM request.
 */
export async function embedQuery(queryText: string): Promise<Float32Array | null> {
    if (queryText.length < MIN_QUERY_LENGTH || queryText.length > MAX_QUERY_LENGTH) return null;
    const embed = await getEmbedModule();
    if (!embed) return null;
    try {
        return await embed.embedText(queryText);
    } catch {
        return null;
    }
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: string } {
    const total = totalHits + totalMisses;
    return {
        size: cache.length,
        maxSize: MAX_CACHE_SIZE,
        hits: totalHits,
        misses: totalMisses,
        hitRate: total > 0 ? `${((totalHits / total) * 100).toFixed(1)}%` : "N/A",
    };
}

/**
 * Clear all cached responses.
 */
export function clearCache(): void {
    cache.length = 0;
    totalHits = 0;
    totalMisses = 0;
}
