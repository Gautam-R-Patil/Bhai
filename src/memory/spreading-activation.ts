// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Spreading Activation Network (SAN) ──────────────────────
 * Brain analog: Associative cortex — recalling "coffee" activates "morning", "café".
 *
 * When seeds are found by HNSW + FTS5, energy spreads through:
 *  1. Knowledge graph entity relationships
 *  2. Trait co-occurrence edges
 *
 * Bounded: MAX_BRANCH_FACTOR=5 per node, MAX_ACTIVATED_NODES=150 total.
 */

import { getKnowledgeGraphDB, getRelationships } from "./knowledge-graph.js";
import type { Database } from "./sqlite.js";

// ── Constants ─────────────────────────────────

const MAX_BRANCH_FACTOR = 5;     // Top-K strongest edges per node
const MAX_ACTIVATED_NODES = 150; // Global budget — stop traversal when hit
const MAX_HOPS = 3;              // Maximum graph distance from seeds
const DECAY_PER_HOP = 0.7;      // Energy decays by 30% per hop
const ACTIVATION_THRESHOLD = 0.15; // Minimum activation to keep
const SAN_WEIGHT = 0.3;         // Blend weight: final = direct + SAN_WEIGHT × activation

// ── Types ─────────────────────────────────────

export interface ActivationResult {
    memoryId: number;
    activationScore: number;
    hops: number;
    via: string; // How this was activated (entity name or trait)
}

interface ActivatedNode {
    entityId: number;
    energy: number;
    hops: number;
    via: string;
}

// ── Spread Activation ─────────────────────────

/**
 * Spread activation from seed memory IDs through the knowledge graph.
 * Returns related entity/memory IDs + activation scores.
 *
 * @param seedScores - Map of seed memory IDs → their direct relevance scores
 * @param db - The database handle
 * @returns Activated results sorted by activation score descending
 */
export function spreadActivation(
    seedScores: Map<number, number>,
    db: Database | null
): ActivationResult[] {
    if (!db || seedScores.size === 0) return [];

    const kgDb = getKnowledgeGraphDB();
    if (!kgDb) return [];

    // ── Phase 1: Map seed memories to entities ──
    // Look up which entities are referenced by the seed memories
    const seedEntities = new Map<number, { energy: number; via: string }>();

    for (const [memoryId, score] of seedScores) {
        // Try to find entities related to this memory
        // Using fuzzy matching via entity name lookup
        try {
            const memoryContent = db.exec(
                "SELECT content FROM memories WHERE id = ?",
                [memoryId]
            );
            if (memoryContent.length === 0 || memoryContent[0].values.length === 0) continue;

            const content = (memoryContent[0].values[0][0] as string).substring(0, 200);
            // Extract key nouns (words > 4 chars)
            const keywords = content.toLowerCase()
                .replace(/[^\w\s]/g, " ")
                .split(/\s+/)
                .filter(w => w.length > 4);

            // Find matching entities for top keywords
            const topKeywords = keywords.slice(0, 3);
            for (const kw of topKeywords) {
                const entities = db.exec(
                    "SELECT id, name FROM entities WHERE name LIKE ? LIMIT 3",
                    [`%${kw}%`]
                );
                if (entities.length > 0) {
                    for (const row of entities[0].values) {
                        const entityId = row[0] as number;
                        const entityName = row[1] as string;
                        const existing = seedEntities.get(entityId);
                        if (!existing || score > existing.energy) {
                            seedEntities.set(entityId, { energy: score, via: entityName });
                        }
                    }
                }
            }
        } catch { /* non-fatal */ }
    }

    if (seedEntities.size === 0) return [];

    // ── Phase 2: BFS with bounded branching ──
    const activated = new Map<number, ActivatedNode>();
    const queue: ActivatedNode[] = [];
    let totalActivated = 0;

    // Initialize queue with seed entities
    for (const [entityId, info] of seedEntities) {
        const node: ActivatedNode = {
            entityId,
            energy: info.energy,
            hops: 0,
            via: info.via,
        };
        activated.set(entityId, node);
        queue.push(node);
        totalActivated++;
    }

    // BFS with bounded branching
    while (queue.length > 0 && totalActivated < MAX_ACTIVATED_NODES) {
        const current = queue.shift()!;
        if (current.hops >= MAX_HOPS) continue;

        // Get relationships, sorted by weight (strongest first)
        try {
            const rels = getRelationships(kgDb, current.entityId);
            if (rels.length === 0) continue;

            // ★ BRANCHING CAP: Only top-5 strongest edges
            const sortedRels = rels
                .map(r => ({
                    entityId: r.entity.id,
                    entityName: r.entity.name,
                    weight: (r.relationship.properties as Record<string, number>)?.weight || 0.5,
                }))
                .sort((a, b) => b.weight - a.weight)
                .slice(0, MAX_BRANCH_FACTOR);

            for (const rel of sortedRels) {
                if (totalActivated >= MAX_ACTIVATED_NODES) break;

                const neighborEnergy = current.energy * DECAY_PER_HOP * rel.weight;

                if (neighborEnergy < ACTIVATION_THRESHOLD) continue;

                const existing = activated.get(rel.entityId);
                if (existing) {
                    // Accumulate energy from multiple paths (max, not sum, to prevent explosion)
                    if (neighborEnergy > existing.energy) {
                        existing.energy = neighborEnergy;
                    }
                    continue; // Don't re-queue
                }

                const newNode: ActivatedNode = {
                    entityId: rel.entityId,
                    energy: neighborEnergy,
                    hops: current.hops + 1,
                    via: rel.entityName,
                };
                activated.set(rel.entityId, newNode);
                queue.push(newNode);
                totalActivated++;
            }
        } catch { /* non-fatal */ }
    }

    // ── Phase 3: Map activated entities back to memories ──
    const results: ActivationResult[] = [];

    for (const [entityId, node] of activated) {
        if (node.hops === 0) continue; // Skip seeds — they're already in direct results

        // Find memories that reference this entity
        try {
            const entity = db.exec("SELECT name FROM entities WHERE id = ?", [entityId]);
            if (entity.length === 0 || entity[0].values.length === 0) continue;

            const entityName = entity[0].values[0][0] as string;
            // Find memories mentioning this entity
            const memories = db.exec(
                `SELECT id FROM memories
                 WHERE content LIKE ? AND decay_score > 0.2
                 LIMIT 3`,
                [`%${entityName}%`]
            );

            if (memories.length > 0) {
                for (const row of memories[0].values) {
                    results.push({
                        memoryId: row[0] as number,
                        activationScore: node.energy,
                        hops: node.hops,
                        via: node.via,
                    });
                }
            }
        } catch { /* non-fatal */ }
    }

    // ── Phase 4: Also spread through trait co-occurrences ──
    try {
        const traitEdges = db.exec(
            "SELECT trait_a, trait_b, weight FROM trait_edges WHERE weight > 0.3 ORDER BY weight DESC LIMIT 20"
        );
        if (traitEdges.length > 0) {
            // Find memories tagged with correlated traits
            for (const row of traitEdges[0].values) {
                const traitA = row[0] as string;
                const traitB = row[1] as string;
                const weight = row[2] as number;

                // Check if any seed memory's content relates to traitA
                for (const [, seedScore] of seedScores) {
                    const activation = seedScore * weight * DECAY_PER_HOP;
                    if (activation < ACTIVATION_THRESHOLD) continue;

                    // Find memories related to the correlated trait
                    const related = db.exec(
                        `SELECT id FROM memories
                         WHERE (content LIKE ? OR content LIKE ? OR tags LIKE ? OR tags LIKE ?)
                         AND decay_score > 0.2
                         LIMIT 2`,
                        [`%${traitA}%`, `%${traitB}%`, `%${traitA}%`, `%${traitB}%`]
                    );
                    if (related.length > 0) {
                        for (const r of related[0].values) {
                            const memId = r[0] as number;
                            if (!seedScores.has(memId)) { // Don't duplicate seeds
                                results.push({
                                    memoryId: memId,
                                    activationScore: activation,
                                    hops: 1,
                                    via: `trait:${traitA}↔${traitB}`,
                                });
                            }
                        }
                    }
                }
            }
        }
    } catch { /* non-fatal */ }

    // Deduplicate and keep highest activation per memory
    const deduped = new Map<number, ActivationResult>();
    for (const r of results) {
        const existing = deduped.get(r.memoryId);
        if (!existing || r.activationScore > existing.activationScore) {
            deduped.set(r.memoryId, r);
        }
    }

    // Sort by activation score descending
    return Array.from(deduped.values())
        .sort((a, b) => b.activationScore - a.activationScore);
}

/** Merge SAN results into fused scores */
export function mergeSANResults(
    fusedScores: Array<{ id: number; score: number }>,
    sanResults: ActivationResult[],
): void {
    const existingIds = new Set(fusedScores.map(f => f.id));

    for (const san of sanResults) {
        if (existingIds.has(san.memoryId)) {
            // Boost existing result
            const existing = fusedScores.find(f => f.id === san.memoryId);
            if (existing) {
                existing.score += SAN_WEIGHT * san.activationScore;
            }
        } else {
            // Add new associatively-linked memory
            fusedScores.push({
                id: san.memoryId,
                score: SAN_WEIGHT * san.activationScore,
            });
        }
    }
}
