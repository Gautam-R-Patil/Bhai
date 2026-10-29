// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── SleepGate Memory Consolidation ───────────────
 * Biologically inspired consolidation with conflict detection,
 * selective forgetting, and memory merging. Runs during dream cycles.
 * Reduces proactive interference from O(n) to O(log n).
 */

import type { Database } from "./sqlite.js";
import { cosineSimilarity, isReady } from "./embeddings.js";

// ── Types ─────────────────────────────────────

export interface ConsolidationResult {
    conflictsDetected: number;
    memoriesForgotten: number;
    memoriesMerged: number;
    memoriesStrengthened: number;
    totalProcessed: number;
}

// ── Main Pipeline ─────────────────────────────

/**
 * Run full SleepGate consolidation pipeline.
 * Called during dreaming cycle in dreaming.ts.
 */
export async function runSleepGateConsolidation(db: Database): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
        conflictsDetected: 0,
        memoriesForgotten: 0,
        memoriesMerged: 0,
        memoriesStrengthened: 0,
        totalProcessed: 0,
    };

    try {
        // Get recent memories (last 24h) and existing memories
        const recent = getRecentMemories(db, 1); // last 1 day
        const existing = getExistingMemories(db, 200); // top 200 by importance

        if (existing.length === 0) return result;
        result.totalProcessed = existing.length;

        // Load embeddings aligned to the entry arrays, then drop entries whose
        // embedding is missing in LOCKSTEP — otherwise the similarity matrices
        // (sized by embeddings) and the native entry arrays (sized by rows) fall
        // out of index alignment and forget/merge decisions hit the wrong memory.
        const recentA = alignEmbeddings(recent, await getMemoryEmbeddings(db, recent.map(m => m.id)));
        const existingA = alignEmbeddings(existing, await getMemoryEmbeddings(db, existing.map(m => m.id)));

        // Try native pipeline
        const native = loadNative();
        if (native && recentA.embeddings.length > 0 && existingA.embeddings.length > 0) {
            // Compute similarity matrices
            const recentToExisting = computeSimilarityMatrix(recentA.embeddings, existingA.embeddings);
            const existingPairwise = computeSimilarityMatrix(existingA.embeddings, existingA.embeddings);

            const nativeRecent = recentA.rows.map(m => toNativeEntry(m));
            const nativeExisting = existingA.rows.map(m => toNativeEntry(m));

            const sgResult = native.runSleepGate(
                nativeRecent, nativeExisting,
                recentToExisting, existingPairwise
            );

            result.conflictsDetected = sgResult.conflicts_detected?.length || 0;
            result.memoriesForgotten = sgResult.memories_to_forget?.length || 0;
            result.memoriesMerged = sgResult.merge_candidates?.length || 0;
            result.memoriesStrengthened = sgResult.memories_strengthened?.length || 0;

            // Apply decisions
            applyForgetDecisions(db, sgResult.memories_to_forget || []);
            applyStrengthening(db, sgResult.memories_strengthened || []);

            console.log(`[SLEEP-GATE] Conflicts: ${result.conflictsDetected}, Forgotten: ${result.memoriesForgotten}, Merged: ${result.memoriesMerged}, Strengthened: ${result.memoriesStrengthened}`);
        } else {
            // JS fallback: simple age-based cleanup
            const oldMemories = existing.filter(m => m.daysOld > 30 && m.accessCount <= 1);
            for (const m of oldMemories.slice(0, 20)) {
                db.run("UPDATE memories SET decay_score = decay_score * 0.5 WHERE id = ?", [m.id]);
                result.memoriesForgotten++;
            }
        }
    } catch (err) {
        console.warn("[SLEEP-GATE] Consolidation error:", (err as Error).message);
    }

    return result;
}

// ── Helpers ───────────────────────────────────

interface MemoryRow {
    id: number;
    content: string;
    importance: number;
    accessCount: number;
    daysOld: number;
    emotionalWeight: number;
    category: string;
}

function getRecentMemories(db: Database, daysBack: number): MemoryRow[] {
    // Sanitize daysBack: must be a positive integer to prevent SQL injection
    const safeDays = Math.max(1, Math.min(Math.floor(Number(daysBack) || 1), 365));
    const results = db.exec(
        `SELECT id, content, importance, access_count,
                julianday('now') - julianday(created_at) as days_old,
                COALESCE(importance, 5) / 10.0 as emo_weight,
                category
         FROM memories
         WHERE created_at > datetime('now', '-${safeDays} days')
         ORDER BY created_at DESC LIMIT 50`,
        []
    );
    if (!results[0]?.values) return [];
    return results[0].values.map(r => ({
        id: r[0] as number, content: r[1] as string, importance: (r[2] as number) / 10,
        accessCount: (r[3] as number) || 1, daysOld: r[4] as number,
        emotionalWeight: r[5] as number, category: (r[6] as string) || "general",
    }));
}

function getExistingMemories(db: Database, limit: number): MemoryRow[] {
    const results = db.exec(
        `SELECT id, content, importance, access_count,
                julianday('now') - julianday(created_at) as days_old,
                COALESCE(importance, 5) / 10.0 as emo_weight,
                category
         FROM memories
         WHERE consolidated_into IS NULL
         ORDER BY importance DESC LIMIT ?`,
        [limit]
    );
    if (!results[0]?.values) return [];
    return results[0].values.map(r => ({
        id: r[0] as number, content: r[1] as string, importance: (r[2] as number) / 10,
        accessCount: (r[3] as number) || 1, daysOld: r[4] as number,
        emotionalWeight: r[5] as number, category: (r[6] as string) || "general",
    }));
}

// Returns one slot per input id (null when that memory has no embedding row), so
// the result stays index-aligned with `ids` for alignEmbeddings() to zip.
async function getMemoryEmbeddings(db: Database, ids: number[]): Promise<(Float32Array | null)[]> {
    if (!isReady() || ids.length === 0) return ids.map(() => null);

    try {
        const { bufferToEmbedding } = await import("./embeddings.js");
        const placeholders = ids.map(() => "?").join(",");
        const results = db.exec(
            `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${placeholders})`,
            ids
        );
        if (!results[0]?.values) return ids.map(() => null);

        // Build a map keyed by memory_id, then return in the original ids order
        const embMap = new Map<number, Float32Array>();
        for (const row of results[0].values) {
            const memId = row[0] as number;
            const blob = row[1] as Buffer;
            embMap.set(memId, bufferToEmbedding(blob));
        }

        return ids.map(id => embMap.get(id) ?? null);
    } catch (err) {
        console.warn("[SLEEP-GATE] Failed to load embeddings:", (err as Error).message);
        return ids.map(() => null);
    }
}

/**
 * Zip rows with their (nullable, index-aligned) embeddings and keep only the
 * pairs that have an embedding, in lockstep. This guarantees the returned
 * `rows[i]` always corresponds to `embeddings[i]` so similarity matrices built
 * from `embeddings` index-align with native entries built from `rows`.
 */
export function alignEmbeddings<T>(
    rows: T[],
    embeddings: (Float32Array | null)[],
): { rows: T[]; embeddings: Float32Array[] } {
    const outRows: T[] = [];
    const outEmb: Float32Array[] = [];
    for (let i = 0; i < rows.length; i++) {
        const e = embeddings[i];
        if (e) {
            outRows.push(rows[i]);
            outEmb.push(e);
        }
    }
    return { rows: outRows, embeddings: outEmb };
}

function computeSimilarityMatrix(a: Float32Array[], b: Float32Array[]): number[][] {
    return a.map(av => b.map(bv => cosineSimilarity(av, bv)));
}

function toNativeEntry(m: MemoryRow): any {
    return {
        id: m.id, content: m.content, importance: m.importance,
        access_count: m.accessCount, days_old: m.daysOld,
        emotional_weight: m.emotionalWeight, category: m.category,
        embedding_sim_to_recent: 0.5,
    };
}

function applyForgetDecisions(db: Database, ids: number[]): void {
    for (const id of ids) {
        db.run("UPDATE memories SET decay_score = 0, consolidated_into = -1 WHERE id = ?", [id]);
    }
}

function applyStrengthening(db: Database, ids: number[]): void {
    for (const id of ids) {
        db.run("UPDATE memories SET importance = MIN(importance + 1, 10), access_count = access_count + 1 WHERE id = ?", [id]);
    }
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
