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
const CACHE_TTL_MS = 10 * 60_000;  // 10 minutes TTL — long enough for coherent multi-turn sessions; short enough to avoid stale facts.
// Cosine similarity threshold for cache hit. 0.92 produced false positives on
// repeated short utterances ("??", "is it done?", follow-ups) where the literal
// embedding is identical or near-identical but the *conversational context* is
// completely different. 0.97 is conservative — only near-exact duplicates hit.
const SIMILARITY_THRESHOLD = Number(process.env.BHAI_LLM_CACHE_THRESHOLD) || 0.97;
const MIN_QUERY_LENGTH = 20;       // Skip short queries — "ok", "??", "hi", "is it done?" are context-dependent
const MAX_QUERY_LENGTH = 500;      // Don't cache very long queries (too contextual)

// Generic short utterances that must never hit the cache regardless of length —
// they're conversation-context-dependent ("yes" to one question vs. another).
const NEVER_CACHE_PATTERNS: RegExp[] = [
    /^\s*(yes|no|y|n|ok|okay|sure|nope|yep|yeah|nah)\s*[?!.]*\s*$/i,
    /^\s*(thanks|thank\s+you|ty|thx|cool|nice|great|awesome)\s*[?!.]*\s*$/i,
    /^\s*(hi|hello|hey|sup|yo|hola|hii|heya)\s*[?!.]*\s*$/i,
    /^\s*\?+\s*$/,                                    // "??", "???"
    /^\s*(what|huh|wat|wut)\s*[?!.]*\s*$/i,
    /^\s*(is\s+it\s+done|are\s+you\s+done|done\?)\s*[?!.]*\s*$/i,
    /^\s*(any\s+update|update\?|status\?|progress\?)\s*[?!.]*\s*$/i,
    /^\s*(continue|go\s+on|proceed|next)\s*[?!.]*\s*$/i,
];

function isContextDependentQuery(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return true;
    for (const pat of NEVER_CACHE_PATTERNS) {
        if (pat.test(trimmed)) return true;
    }
    return false;
}

// ── Cache Entry ──────────────────────────────

interface CacheEntry {
    queryText: string;
    queryEmbedding: Float32Array;
    response: ChatCompletion;
    model: string;
    // Sorted+joined names of the tools available for the request. Two
    // requests with different tool lists MUST NOT share a cache hit — a
    // response shaped for {memory, web_search} can leak into a prompt
    // that only has {memory} and vice versa.
    toolSignature: string;
    // Hash of the recent conversation state (last few assistant/tool turns).
    // Two identical user messages in different contexts ("??", "is it done?")
    // must NOT share a cache hit. Empty string means no context partitioning.
    contextHash: string;
    createdAt: number;
    hitCount: number;
}

/** Build a stable signature for a tool set (sorted, comma-joined names). */
export function buildToolSignature(tools?: Array<{ function?: { name?: string } } | { name?: string }>): string {
    if (!tools || tools.length === 0) return "";
    const names: string[] = [];
    for (const t of tools) {
        const n = (t as { function?: { name?: string } }).function?.name ?? (t as { name?: string }).name;
        if (n) names.push(n);
    }
    names.sort();
    return names.join(",");
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
 *
 * @param contextHash Optional hash of recent conversation state. Two identical
 *   user messages in different contexts must not share a cache hit.
 */
export async function getCachedResponse(
    queryText: string,
    model: string,
    toolSignature: string = "",
    contextHash: string = "",
): Promise<ChatCompletion | null> {
    // Reject context-dependent short utterances ("??", "ok", "is it done?")
    if (isContextDependentQuery(queryText)) return null;
    if (queryText.length > MAX_QUERY_LENGTH) return null;

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
        // Must share tool signature. Different tool sets produce different
        // response shapes — a tool-call-absent answer from 2 tools ago is
        // unsafe to return if this request has 50 tools available.
        if (entry.toolSignature !== toolSignature) continue;
        // Must share conversation context. "??" in one conversation is not
        // the same query as "??" in another, even with similarity 1.000.
        if (entry.contextHash !== contextHash) continue;

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
    toolSignature: string = "",
    contextHash: string = "",
): void {
    // Don't cache responses with tool calls
    const choice = response.choices?.[0];
    if (!choice) return;
    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) return;
    if (choice.finish_reason === "tool_calls") return;

    // Don't cache empty responses
    if (!choice.message?.content || choice.message.content.length < 10) return;

    // Skip context-dependent short utterances and over-length queries
    if (isContextDependentQuery(queryText)) return;
    if (queryText.length > MAX_QUERY_LENGTH) return;

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
        toolSignature,
        contextHash,
        createdAt: Date.now(),
        hitCount: 0,
    });
}

/**
 * Embed a query for later caching. Call before the LLM request.
 */
export async function embedQuery(queryText: string): Promise<Float32Array | null> {
    if (isContextDependentQuery(queryText) || queryText.length > MAX_QUERY_LENGTH) return null;
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
