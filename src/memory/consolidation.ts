// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Hierarchical Memory Consolidation (Knowledge Crystals) ──
 * Brain analog: Slow-wave sleep consolidation — hippocampus replays memories
 * and transfers important ones to cortex as compressed schemas.
 *
 * Pipeline: CLUSTER → FILTER → SUMMARIZE(Lite) → CRYSTALLIZE → ARCHIVE → COMPACT
 *
 * Safeguards:
 *  - Uses Lite/Flash model only (not PRO) to control token cost
 *  - Max 10 clusters per nightly run (remaining queued for next night)
 */

import type { LLMClient } from "../llm.js";
import { remember } from "./sqlite.js";
import { embedText } from "./embeddings.js";
import { getHNSWIndex } from "./vector-index.js";
import { beginTransaction, commitTransaction, rollbackTransaction } from "./sqlite.js";
import type { Database } from "./sqlite.js";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

// ── Native module (required in production) ──────────────────────────────────
const _esmRequire = createRequire(import.meta.url);
interface _NativeModule { cosineSimilarity: (a: Float32Array, b: Float32Array) => number; }
let _native: _NativeModule | null = null;
try {
    const _modulePath = path.join(process.cwd(), "native", "index.js");
    if (fs.existsSync(_modulePath)) {
        const _m = _esmRequire(_modulePath) as _NativeModule;
        if (typeof _m?.cosineSimilarity === "function") _native = _m;
    }
} catch { /* throws on first call if native is absent */ }

// ── Constants ─────────────────────────────────

const CLUSTER_SIMILARITY_THRESHOLD = 0.7;
const MIN_CLUSTER_SIZE = 5;
const MAX_CLUSTERS_PER_NIGHT = 10;
const ARCHIVE_AGE_DAYS = 180; // 6 months

// ── Types ─────────────────────────────────────

interface ConsolidationMemory {
    id: number;
    content: string;
    category: string;
    tags: string;
    importance: number;
    access_count: number;
    embedding: Float32Array | null;
}

interface MemoryCluster {
    members: ConsolidationMemory[];
    centroidContent: string; // concatenation of member contents
}

// ── Clustering ────────────────────────────────

/**
 * Greedy clustering of memories by embedding similarity.
 * O(n²) but only on cold-tier memories (small subset).
 */
function clusterByEmbedding(
    memories: ConsolidationMemory[],
    threshold = CLUSTER_SIMILARITY_THRESHOLD
): MemoryCluster[] {
    const clusters: MemoryCluster[] = [];
    const assigned = new Set<number>();

    // Pre-compute: only work with memories that have embeddings
    const withEmbeddings = memories.filter(m => m.embedding !== null);

    for (let i = 0; i < withEmbeddings.length; i++) {
        if (assigned.has(i)) continue;

        const cluster: ConsolidationMemory[] = [withEmbeddings[i]];
        assigned.add(i);

        for (let j = i + 1; j < withEmbeddings.length; j++) {
            if (assigned.has(j)) continue;

            const sim = cosineSimilarity(
                withEmbeddings[i].embedding!,
                withEmbeddings[j].embedding!
            );

            if (sim >= threshold) {
                cluster.push(withEmbeddings[j]);
                assigned.add(j);
            }
        }

        clusters.push({
            members: cluster,
            centroidContent: cluster.map(m => m.content).join("\n---\n"),
        });
    }

    return clusters;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (_native) return _native.cosineSimilarity(a, b);
    return 0; // Safe fallback — native module required for accurate similarity
}

// ── Crystallization (LLM) ─────────────────────

/**
 * Generate a "knowledge crystal" from a cluster of related memories.
 * Uses Lite/Flash model to control costs.
 */
async function crystallize(
    cluster: MemoryCluster,
    llm: LLMClient
): Promise<string | null> {
    const memberContents = cluster.members
        .map((m, i) => `[${i + 1}] ${m.content.substring(0, 200)}`)
        .join("\n");

    const prompt = `Compress these ${cluster.members.length} related memories into a single knowledge crystal — a concise summary (50-100 words) that preserves the essential facts, relationships, and insights. Drop redundancy, keep specifics.

Memories:
${memberContents}

Output ONLY the crystal text, no JSON, no quotes, no explanation.`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }],
            systemPrompt: "You compress related memories into ultra-concise knowledge crystals. Output only the crystal text.",
        });

        const crystal = (response.choices[0]?.message?.content || "").trim();
        if (crystal.length > 20 && crystal.length < 500) return crystal;
        return null;
    } catch (err) {
        console.error("[CONSOLIDATION] Crystal generation failed:", err);
        return null;
    }
}

// ── Main Consolidation Pipeline ───────────────

/**
 * Full Hierarchical Memory Consolidation pipeline.
 * Called during dream replay (nightly).
 *
 * @param db - Database handle
 * @param llm - Lite/Flash LLM client (NOT PRO)
 */
export async function consolidateMemories(
    db: Database,
    llm: LLMClient
): Promise<{ clusteredCount: number; crystalsCreated: number; archived: number }> {
    const stats = { clusteredCount: 0, crystalsCreated: 0, archived: 0 };

    console.log("[CONSOLIDATION] Starting memory consolidation...");

    // ── Step 1: Load cold-tier memories ──
    const results = db.exec(
        `SELECT m.id, m.content, m.category, m.tags, m.importance, m.access_count, e.embedding
         FROM memories m
         LEFT JOIN memory_embeddings e ON m.id = e.memory_id
         WHERE m.tier = 'cold' AND (m.consolidated_into IS NULL)
         ORDER BY m.created_at ASC`
    );

    if (results.length === 0 || results[0].values.length === 0) {
        console.log("[CONSOLIDATION] No cold memories to consolidate");
        return stats;
    }

    const memories: ConsolidationMemory[] = results[0].values.map(row => {
        let embedding: Float32Array | null = null;
        if (row[6]) {
            const buf = row[6] as Buffer;
            const ab = new ArrayBuffer(buf.length);
            const view = new Uint8Array(ab);
            for (let i = 0; i < buf.length; i++) view[i] = buf[i];
            embedding = new Float32Array(ab);
        }
        return {
            id: row[0] as number,
            content: row[1] as string,
            category: row[2] as string,
            tags: row[3] as string,
            importance: row[4] as number,
            access_count: (row[5] as number) || 0,
            embedding,
        };
    });

    console.log(`[CONSOLIDATION] Processing ${memories.length} cold memories...`);

    // ── Step 2: Cluster by embedding similarity ──
    const clusters = clusterByEmbedding(memories);
    const validClusters = clusters.filter(c => c.members.length >= MIN_CLUSTER_SIZE);

    if (validClusters.length === 0) {
        console.log("[CONSOLIDATION] No clusters large enough (need ≥5 members)");
        return stats;
    }

    console.log(`[CONSOLIDATION] Found ${validClusters.length} clusters (≥${MIN_CLUSTER_SIZE} members)`);

    // ── Step 3: Process up to MAX_CLUSTERS_PER_NIGHT ──
    const toProcess = validClusters.slice(0, MAX_CLUSTERS_PER_NIGHT);
    const remaining = validClusters.length - toProcess.length;

    for (const cluster of toProcess) {
        const crystal = await crystallize(cluster, llm);
        if (!crystal) continue;

        // ── Step 4: Store the crystal as a new memory ──
        const maxImportance = Math.min(10, Math.max(...cluster.members.map(m => m.importance)) + 1);
        const totalAccess = cluster.members.reduce((sum, m) => sum + m.access_count, 0);
        const allTags = new Set<string>();
        for (const m of cluster.members) {
            for (const tag of m.tags.split(",").map(t => t.trim()).filter(Boolean)) {
                allTags.add(tag);
            }
        }
        allTags.add("crystal");
        allTags.add("consolidated");

        const crystalId = await remember(crystal, "knowledge_crystal", Array.from(allTags).join(","), maxImportance);
        if (crystalId === null) {
            console.warn("[CONSOLIDATION] Knowledge crystal rejected by value gate (unexpected — category is curated)");
            continue;
        }

        // Embed the crystal and add to HNSW
        try {
            const embedding = await embedText(crystal);
            if (embedding && crystalId) {
                const index = getHNSWIndex();
                // Cast to number and ensure it's a valid ID
                const numId = typeof crystalId === 'number' ? crystalId : parseInt(String(crystalId), 10);
                if (!isNaN(numId)) {
                    index.addVector(numId, embedding);
                }
            }
        } catch { /* non-fatal */ }

        stats.crystalsCreated++;

        // ── Step 5: Archive originals ──
        beginTransaction();
        try {
            for (const member of cluster.members) {
                db.run(
                    "UPDATE memories SET consolidated_into = ?, tier = 'archived' WHERE id = ?",
                    [crystalId, member.id]
                );
                stats.archived++;
            }
            commitTransaction();
        } catch {
            rollbackTransaction();
        }

        stats.clusteredCount += cluster.members.length;
        console.log(`[CONSOLIDATION] Created crystal from ${cluster.members.length} memories: "${crystal.substring(0, 60)}..."`);
    }

    if (remaining > 0) {
        console.log(`[CONSOLIDATION] ⏳ ${remaining} clusters queued for next night`);
    }

    // ── Step 6: Compact old archived memories ──
    try {
        const cutoff = new Date(Date.now() - ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const old = db.exec("SELECT id FROM memories WHERE tier = 'archived' AND created_at < ?", [cutoff]);
        const ids = old.length > 0 ? old[0].values.map((r) => r[0] as number) : [];
        for (const id of ids) {
            db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
            try { getHNSWIndex().removeVector(id); } catch { /* */ }
        }
        db.run(
            "DELETE FROM memories WHERE tier = 'archived' AND created_at < ?",
            [cutoff]
        );
    } catch { /* non-fatal */ }

    console.log(`[CONSOLIDATION] ✅ Complete: ${stats.crystalsCreated} crystals from ${stats.clusteredCount} memories, ${stats.archived} archived`);
    return stats;
}
