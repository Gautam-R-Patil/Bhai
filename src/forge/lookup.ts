// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { searchByFTS, searchByEmbedding, getToolBySlug, listTools } from "./library.js";
import { emitForgeEvent } from "./telemetry.js";
import type { FunctionGemmaResult } from "../models/function-gemma.js";

const FG_CONFIDENCE_THRESHOLD = 0.8;
const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;
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
        emitForgeEvent({ event: "lookup_attempted", ts: Date.now(), description: opts.description, matchSimilarity: null, source: "miss" });
        return null;
    }

    // Stage 1: FunctionGemma classifier (zero-cost, gracefully null when Ollama absent)
    if (opts.functionGemmaFn) {
        try {
            const allTools = listTools();
            if (allTools.length > 0) {
                const schemas = allTools.map(t => ({
                    name: t.slug,
                    description: t.description,
                    parameters: Object.keys(t.schema?.properties ?? {}),
                }));
                const fgResult = await opts.functionGemmaFn(opts.description, schemas);
                if (fgResult && fgResult.confidence >= FG_CONFIDENCE_THRESHOLD) {
                    const tool = getToolBySlug(fgResult.toolName);
                    if (tool) {
                        emitForgeEvent({
                            event: "lookup_attempted", ts: Date.now(),
                            description: opts.description,
                            matchSimilarity: fgResult.confidence,
                            source: "function_gemma",
                        });
                        return { slug: tool.slug, matchSimilarity: fgResult.confidence, source: "function_gemma" };
                    }
                    // FG claimed a ghost slug — fall through
                }
            }
        } catch {
            // FunctionGemma errored — fall through
        }
    }

    // Stage 2: BM25 FTS → top-20 candidates
    const ftsResults = searchByFTS(opts.description, FTS_TOP_N);
    if (ftsResults.length === 0) {
        emitForgeEvent({ event: "lookup_attempted", ts: Date.now(), description: opts.description, matchSimilarity: null, source: "miss" });
        return null;
    }

    // Stage 3: cosine rerank
    const queryEmbedding = await opts.embedFn(opts.description);
    const candidateSlugs = ftsResults.map(r => r.slug);
    const cosineResults = searchByEmbedding(queryEmbedding, candidateSlugs, EMBEDDING_SIMILARITY_THRESHOLD);

    if (cosineResults.length === 0) {
        emitForgeEvent({ event: "lookup_attempted", ts: Date.now(), description: opts.description, matchSimilarity: ftsResults[0]?.bm25Score ?? null, source: "miss" });
        return null;
    }

    const top = cosineResults[0];
    emitForgeEvent({
        event: "lookup_attempted", ts: Date.now(),
        description: opts.description,
        matchSimilarity: top.similarity,
        source: "library_embedding",
    });
    return { slug: top.slug, matchSimilarity: top.similarity, source: "library_embedding" };
}
