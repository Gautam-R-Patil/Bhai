// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import type { FunctionGemmaResult } from "../models/function-gemma.js";
import { getToolBySlug, listTools, searchByEmbedding, searchByFTS } from "./library.js";
import { emitForgeEvent } from "./telemetry.js";

// FunctionGemma is 85% accurate at 0.8 confidence; below that, fall through to embedding rerank.
const FG_CONFIDENCE_THRESHOLD = 0.8;
// 0.85 cosine: tight enough to avoid false reuse, loose enough to compound. See forge-deep-dives/04-routing-orchestrator.md.
const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;
// FTS gives BM25-ranked candidates; rerank top-20 with cosine. Larger N hurts latency without improving precision past this.
const FTS_TOP_N = 20;

export interface LookupHit {
    slug: string;
    matchSimilarity: number;
    source: "function_gemma" | "library_embedding";
}

export interface LookupOpts {
    description: string;
    embedFn: (text: string) => Promise<Float32Array>;
    functionGemmaFn?: (
        query: string,
        toolSchemas: Array<{ name: string; description: string; parameters: string[] }>,
    ) => Promise<FunctionGemmaResult | null>;
}

export async function lookupTool(opts: LookupOpts): Promise<LookupHit | null> {
    if (process.env.ATLAS_NO_FORGE_LOOKUP === "true") {
        emitForgeEvent({
            event: "lookup_attempted",
            ts: Date.now(),
            description: opts.description,
            matchSimilarity: null,
            source: "miss",
        });
        return null;
    }

    // Stage 1: FunctionGemma classifier (zero-cost, gracefully null when Ollama absent)
    if (opts.functionGemmaFn) {
        try {
            const allTools = listTools();
            if (allTools.length > 0) {
                const schemas = allTools.map((t) => ({
                    name: t.slug,
                    description: t.description,
                    parameters: Object.keys(t.schema?.properties ?? {}),
                }));
                const fgResult = await opts.functionGemmaFn(opts.description, schemas);
                if (fgResult && fgResult.confidence >= FG_CONFIDENCE_THRESHOLD) {
                    const tool = getToolBySlug(fgResult.toolName);
                    // Skip archived / awaiting_approval / graduated / published —
                    // only `active` tools are callable from the registry.
                    if (tool && tool.lifecycleState === "active") {
                        emitForgeEvent({
                            event: "lookup_attempted",
                            ts: Date.now(),
                            description: opts.description,
                            matchSimilarity: fgResult.confidence,
                            source: "function_gemma",
                        });
                        return { slug: tool.slug, matchSimilarity: fgResult.confidence, source: "function_gemma" };
                    }
                    // FG hallucinated a slug — log it for offline FG-drift analysis
                    emitForgeEvent({
                        event: "lookup_attempted",
                        ts: Date.now(),
                        description: opts.description,
                        matchSimilarity: fgResult.confidence,
                        source: "miss",
                    });
                }
            }
        } catch {
            // FunctionGemma errored — fall through
        }
    }

    // Stage 2: BM25 FTS → top-20 candidates. AND-token-mismatch falls back to per-token OR
    // for recall-biased retrieval — cosine rerank is the precision gate.
    const ftsResults = ftsCandidates(opts.description);
    if (ftsResults.length === 0) {
        emitForgeEvent({
            event: "lookup_attempted",
            ts: Date.now(),
            description: opts.description,
            matchSimilarity: null,
            source: "miss",
        });
        return null;
    }

    // Stage 3: cosine rerank (fail-open — embedding crash returns null with miss telemetry)
    try {
        const queryEmbedding = await opts.embedFn(opts.description);
        const candidateSlugs = ftsResults.map((r) => r.slug);
        const cosineResults = searchByEmbedding(queryEmbedding, candidateSlugs, EMBEDDING_SIMILARITY_THRESHOLD);

        if (cosineResults.length === 0) {
            emitForgeEvent({
                event: "lookup_attempted",
                ts: Date.now(),
                description: opts.description,
                matchSimilarity: ftsResults[0]?.bm25Score ?? null,
                source: "miss",
            });
            return null;
        }

        const top = cosineResults[0];
        emitForgeEvent({
            event: "lookup_attempted",
            ts: Date.now(),
            description: opts.description,
            matchSimilarity: top.similarity,
            source: "library_embedding",
        });
        return { slug: top.slug, matchSimilarity: top.similarity, source: "library_embedding" };
    } catch (err) {
        console.warn(`[forge] lookup embedding stage failed: ${(err as Error).message.slice(0, 100)}`);
        emitForgeEvent({
            event: "lookup_attempted",
            ts: Date.now(),
            description: opts.description,
            matchSimilarity: ftsResults[0]?.bm25Score ?? null,
            source: "miss",
        });
        return null;
    }
}

// FTS5's default tokenizer joins terms with AND. A query with novel words that aren't
// in any tool's description fails AND-wise, even when most tokens match. This helper
// tries AND-FTS first (cheap path); if 0 hits, per-token OR-fans by calling searchByFTS
// once per token and merging the slug sets. Same pattern as dedup.ts::ftsCandidates.
function ftsCandidates(description: string): { slug: string; bm25Score: number }[] {
    const direct = searchByFTS(description, FTS_TOP_N);
    if (direct.length > 0) return direct;

    // Same sanitization shape as searchByFTS: positive Unicode allowlist, strip reserved keywords.
    const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);
    const tokens = description
        .replace(/[^\p{L}\p{N}_\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter((t) => t.length > 0 && !FTS5_RESERVED.has(t.toUpperCase()));

    if (tokens.length === 0) return [];

    // Fan out: query each token alone, merge slug sets, dedupe by slug, cap at FTS_TOP_N.
    const seen = new Map<string, number>();
    for (const token of tokens) {
        if (seen.size >= FTS_TOP_N) break;
        const hits = searchByFTS(token, FTS_TOP_N);
        for (const h of hits) {
            if (!seen.has(h.slug) || h.bm25Score < seen.get(h.slug)!) {
                seen.set(h.slug, h.bm25Score);
            }
            if (seen.size >= FTS_TOP_N) break;
        }
    }

    return Array.from(seen.entries())
        .map(([slug, bm25Score]) => ({ slug, bm25Score }))
        .sort((a, b) => a.bm25Score - b.bm25Score);
}
