// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { getLibrary, searchByEmbedding, searchByFTS } from "./library.js";

export type DedupResult =
    | { kind: "distinct" }
    | { kind: "warn"; relatedSlug: string; similarity: number }
    | { kind: "merge"; canonicalSlug: string; similarity: number };

export interface DedupOpts {
    candidateDescription: string;
    candidateEmbedding: Float32Array;
}

// Auto-merge — very high confidence the candidate is a rephrasing of the existing tool.
const MERGE_THRESHOLD = 0.92;
// Warn — parity with lookup retrieval threshold. Same vector, different lifecycle stage.
const WARN_THRESHOLD = 0.85;
// FTS narrows the candidate pool to top-20 by BM25 before cosine rerank.
const FTS_TOP_N = 20;

// Dedup differs from lookup in retrieval breadth: a rephrasing like
// "extract PDF (rephrased)" against indexed "extract PDF" has a novel token
// that AND-FTS rejects. Cosine — not FTS — is the precision gate; FTS is the
// candidate-narrowing pre-filter. So when AND-FTS returns 0, fall back to
// per-token OR retrieval before declaring distinct.
function ftsCandidates(description: string): string[] {
    const andHits = searchByFTS(description, FTS_TOP_N);
    if (andHits.length > 0) return andHits.map((r) => r.slug);

    const cleaned = description
        .replace(/[^\p{L}\p{N}_\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return [];
    const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);
    const tokens = cleaned.split(" ").filter((t) => t.length > 0 && !FTS5_RESERVED.has(t.toUpperCase()));
    if (tokens.length === 0) return [];

    const seen = new Set<string>();
    for (const tok of tokens) {
        const hits = searchByFTS(tok, FTS_TOP_N);
        for (const h of hits) seen.add(h.slug);
        if (seen.size >= FTS_TOP_N) break;
    }
    return Array.from(seen).slice(0, FTS_TOP_N);
}

export async function checkForDuplicate(opts: DedupOpts): Promise<DedupResult> {
    // Use FTS to narrow candidate set, then cosine for precision
    const candidateSlugs = ftsCandidates(opts.candidateDescription);
    if (candidateSlugs.length === 0) return { kind: "distinct" };

    const cosineResults = searchByEmbedding(opts.candidateEmbedding, candidateSlugs, WARN_THRESHOLD);
    if (cosineResults.length === 0) return { kind: "distinct" };

    const top = cosineResults[0];
    if (top.similarity >= MERGE_THRESHOLD) {
        return { kind: "merge", canonicalSlug: top.slug, similarity: top.similarity };
    }
    return { kind: "warn", relatedSlug: top.slug, similarity: top.similarity };
}

export interface DedupDecision {
    candidateDescription: string;
    matchedSlug: string | null;
    similarity: number | null;
    action: "merged" | "warned" | "distinct";
}

export function recordDedupDecision(d: DedupDecision): void {
    const db = getLibrary();
    db.prepare(
        `INSERT INTO dedup_log (ts, candidate_description, matched_slug, similarity, action) VALUES (?, ?, ?, ?, ?)`,
    ).run(Date.now(), d.candidateDescription, d.matchedSlug, d.similarity, d.action);
}

export function addAlias(aliasSlug: string, canonicalSlug: string, similarity: number): void {
    const db = getLibrary();
    db.prepare(
        `INSERT OR REPLACE INTO tool_aliases (alias_slug, canonical_slug, similarity, merged_at) VALUES (?, ?, ?, ?)`,
    ).run(aliasSlug, canonicalSlug, similarity, Date.now());
}

export function getCanonicalSlug(slug: string): string {
    const db = getLibrary();
    const row = db.prepare(`SELECT canonical_slug FROM tool_aliases WHERE alias_slug = ?`).get(slug) as
        | { canonical_slug: string }
        | undefined;
    return row?.canonical_slug ?? slug;
}
