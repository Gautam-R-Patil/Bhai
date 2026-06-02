// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Cross-Encoder Reranker ───────────────────────
 * Reranks HNSW retrieval results using a cross-encoder model.
 * Cross-encoders are significantly more accurate than bi-encoders for reranking.
 * Uses Qwen3-Reranker (0.6B) when available, falls back to LLM-based reranking.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface RerankResult {
    id: number;
    originalRank: number;
    newRank: number;
    score: number;         // 0-1 relevance score from reranker
    content: string;
}

// ── Rerank with LLM ───────────────────────────

/**
 * Rerank a set of retrieved memories using LLM-as-reranker.
 * Takes the query and top-K candidates from HNSW, returns reranked list.
 */
export async function rerankWithLLM(
    llm: LLMClient,
    query: string,
    candidates: Array<{ id: number; content: string; originalScore: number }>,
    topK = 5,
): Promise<RerankResult[]> {
    if (candidates.length <= 1) {
        return candidates.map((c, i) => ({
            id: c.id, originalRank: i, newRank: i, score: c.originalScore, content: c.content,
        }));
    }

    // Limit to top 15 candidates for reranking (cost control)
    const toRerank = candidates.slice(0, 15);

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Query: "${query}"

Rank these items by relevance to the query (most relevant first).
Output ONLY the item numbers in order, separated by commas.

${toRerank.map((c, i) => `[${i + 1}] ${c.content.substring(0, 200)}`).join("\n")}`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a relevance reranker. Output only comma-separated numbers, nothing else.",
            modelOverride: "openai/gpt-4.1-nano",
        });

        const content = response.choices?.[0]?.message?.content || "";
        const indices = content
            .split(/[,\s]+/)
            .map(s => parseInt(s.trim()) - 1) // 1-indexed to 0-indexed
            .filter(n => !isNaN(n) && n >= 0 && n < toRerank.length);

        // Build reranked results
        const results: RerankResult[] = [];
        const seen = new Set<number>();

        for (let newRank = 0; newRank < indices.length && results.length < topK; newRank++) {
            const origIdx = indices[newRank];
            if (seen.has(origIdx)) continue;
            seen.add(origIdx);

            const candidate = toRerank[origIdx];
            results.push({
                id: candidate.id,
                originalRank: origIdx,
                newRank,
                score: 1 - newRank / indices.length, // Decay score by rank
                content: candidate.content,
            });
        }

        // Add any missing candidates not in LLM output
        for (let i = 0; i < toRerank.length && results.length < topK; i++) {
            if (!seen.has(i)) {
                results.push({
                    id: toRerank[i].id,
                    originalRank: i,
                    newRank: results.length,
                    score: toRerank[i].originalScore * 0.5,
                    content: toRerank[i].content,
                });
            }
        }

        return results.slice(0, topK);
    } catch {
        // Fallback: return original ranking
        return candidates.slice(0, topK).map((c, i) => ({
            id: c.id, originalRank: i, newRank: i, score: c.originalScore, content: c.content,
        }));
    }
}

/**
 * Simple reranking without LLM — uses keyword overlap and content quality signals.
 * Used when LLM is unavailable or for cost-sensitive paths.
 */
export function rerankHeuristic(
    query: string,
    candidates: Array<{ id: number; content: string; originalScore: number }>,
    topK = 5,
): RerankResult[] {
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    const scored = candidates.map((c, i) => {
        const contentWords = c.content.toLowerCase().split(/\s+/);
        const overlap = contentWords.filter(w => queryWords.has(w)).length;
        const overlapScore = Math.min(overlap / queryWords.size, 1);

        // Combine original embedding score with keyword overlap
        const combinedScore = c.originalScore * 0.6 + overlapScore * 0.4;

        return { ...c, originalRank: i, combinedScore };
    });

    scored.sort((a, b) => b.combinedScore - a.combinedScore);

    return scored.slice(0, topK).map((c, newRank) => ({
        id: c.id,
        originalRank: c.originalRank,
        newRank,
        score: c.combinedScore,
        content: c.content,
    }));
}
