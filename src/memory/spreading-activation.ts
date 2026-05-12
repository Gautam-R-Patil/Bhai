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

import {
    type NativeActivationResult,
    type NativeSeedEntity,
    nativeSpreadActivationBfs,
} from "../native/index.js";
import { getKnowledgeGraphDB, getRelationships } from "./knowledge-graph.js";
import type { Database } from "./sqlite.js";

// ── Constants ─────────────────────────────────

const MAX_BRANCH_FACTOR = 5;     // Top-K strongest edges per node
const MAX_ACTIVATED_NODES = 150; // Global budget — stop traversal when hit
const MAX_HOPS = 3;              // Maximum graph distance from seeds
const DECAY_PER_HOP = 0.7;      // Energy decays by 30% per hop
const ACTIVATION_THRESHOLD = 0.15; // Minimum activation to keep
const SAN_WEIGHT = 0.3;         // Blend weight: final = direct + SAN_WEIGHT × activation

// Native spreading-BFS is OPT-IN, not default. The Rust BFS itself is faster,
// but FFI overhead + JSON serialization of the adjacency map dominate runtime
// on the typical seed counts and graph sizes we see in production (<10 seeds,
// <50-node induced graphs). Bench (scripts/bench-native.ts) shows native is
// ~17x slower per call at 50 nodes. Set `ATLAS_NATIVE_SPREADING=true` to
// enable on workloads with large recall fan-out where Rust would amortize.
const NATIVE_ENABLED = process.env.ATLAS_NATIVE_SPREADING === "true";

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
    // Native path runs the BFS in Rust for ~3-8x speedup on 50-150 node graphs.
    // Falls back to TS when native is unavailable or ATLAS_NO_NATIVE_SPREADING=true.
    const activated = new Map<number, ActivatedNode>();
    runBfs(seedEntities, kgDb, activated);

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

// ── BFS dispatch (native-first) ─────────────────

interface SortedRel {
    entityId: number;
    entityName: string;
    weight: number;
}

function loadSortedRels(kgDb: ReturnType<typeof getKnowledgeGraphDB>, entityId: number): SortedRel[] {
    if (!kgDb) return [];
    try {
        const rels = getRelationships(kgDb, entityId);
        if (rels.length === 0) return [];
        return rels
            .map(r => ({
                entityId: r.entity.id,
                entityName: r.entity.name,
                weight: (r.relationship.properties as Record<string, number>)?.weight || 0.5,
            }))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, MAX_BRANCH_FACTOR);
    } catch {
        return [];
    }
}

function bfsTs(
    seedEntities: Map<number, { energy: number; via: string }>,
    kgDb: ReturnType<typeof getKnowledgeGraphDB>,
    activated: Map<number, ActivatedNode>,
): void {
    const queue: ActivatedNode[] = [];
    let totalActivated = 0;

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

    while (totalActivated < MAX_ACTIVATED_NODES) {
        const current = queue.shift();
        if (!current) break;
        if (current.hops >= MAX_HOPS) continue;

        const sortedRels = loadSortedRels(kgDb, current.entityId);
        if (sortedRels.length === 0) continue;

        for (const rel of sortedRels) {
            if (totalActivated >= MAX_ACTIVATED_NODES) break;

            const neighborEnergy = current.energy * DECAY_PER_HOP * rel.weight;
            if (neighborEnergy < ACTIVATION_THRESHOLD) continue;

            const existing = activated.get(rel.entityId);
            if (existing) {
                if (neighborEnergy > existing.energy) existing.energy = neighborEnergy;
                continue;
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
    }
}

/**
 * Pre-fetch a bounded slice of the entity graph reachable from `seedEntities`
 * within MAX_HOPS, MAX_BRANCH_FACTOR per node, MAX_ACTIVATED_NODES total.
 * Returns a JSON object suitable for the Rust BFS adjacency input.
 *
 * The walk here intentionally does NOT apply the energy/threshold gating —
 * those are the Rust BFS's job. We only enumerate which entities the BFS
 * could possibly visit, so the adjacency map is complete enough.
 */
/**
 * Field names use snake_case to match the Rust serde-deserialized struct
 * (the napi ABI auto-renames to camelCase across FFI, but raw JSON sent via
 * an adjacency_json string is parsed by serde_json directly with Rust names).
 */
interface RustRel {
    entity_id: number;
    entity_name: string;
    weight: number;
}

function toRustRels(rels: SortedRel[]): RustRel[] {
    return rels.map(r => ({
        entity_id: r.entityId,
        entity_name: r.entityName,
        weight: r.weight,
    }));
}

function buildAdjacencyJson(
    seedEntities: Map<number, { energy: number; via: string }>,
    kgDb: ReturnType<typeof getKnowledgeGraphDB>,
): string {
    const adjacency: Record<string, RustRel[]> = {};
    const visited = new Set<number>();
    const queue: Array<{ entityId: number; hops: number }> = [];

    for (const entityId of seedEntities.keys()) {
        queue.push({ entityId, hops: 0 });
        visited.add(entityId);
    }

    while (visited.size < MAX_ACTIVATED_NODES) {
        const current = queue.shift();
        if (!current) break;
        if (current.hops >= MAX_HOPS) continue;

        const rels = loadSortedRels(kgDb, current.entityId);
        adjacency[String(current.entityId)] = toRustRels(rels);

        for (const rel of rels) {
            if (visited.size >= MAX_ACTIVATED_NODES) break;
            if (visited.has(rel.entityId)) continue;
            visited.add(rel.entityId);
            queue.push({ entityId: rel.entityId, hops: current.hops + 1 });
        }
    }

    return JSON.stringify(adjacency);
}

function bfsNative(
    seedEntities: Map<number, { energy: number; via: string }>,
    kgDb: ReturnType<typeof getKnowledgeGraphDB>,
    activated: Map<number, ActivatedNode>,
): boolean {
    const seedArr: NativeSeedEntity[] = [];
    for (const [entityId, info] of seedEntities) {
        seedArr.push({ entityId, energy: info.energy, via: info.via });
        activated.set(entityId, {
            entityId,
            energy: info.energy,
            hops: 0,
            via: info.via,
        });
    }

    const adjacencyJson = buildAdjacencyJson(seedEntities, kgDb);

    let results: NativeActivationResult[] | null;
    try {
        results = nativeSpreadActivationBfs(seedArr, adjacencyJson);
    } catch {
        return false;
    }
    if (!results) return false;

    for (const r of results) {
        const existing = activated.get(r.memoryId);
        if (existing) {
            if (r.activationScore > existing.energy) existing.energy = r.activationScore;
        } else {
            activated.set(r.memoryId, {
                entityId: r.memoryId,
                energy: r.activationScore,
                hops: r.hops,
                via: r.via,
            });
        }
    }
    return true;
}

function runBfs(
    seedEntities: Map<number, { energy: number; via: string }>,
    kgDb: ReturnType<typeof getKnowledgeGraphDB>,
    activated: Map<number, ActivatedNode>,
): void {
    if (NATIVE_ENABLED) {
        if (bfsNative(seedEntities, kgDb, activated)) return;
    }
    bfsTs(seedEntities, kgDb, activated);
}

// ── Test-only exports (parity testing) ──────────

/**
 * Run the BFS (native or TS) against an in-memory adjacency map.
 * Bypasses SQLite — used by parity tests to verify byte-identical output
 * between the Rust BFS and the TypeScript fallback on a controlled graph.
 */
export function __testOnlyBfsWithAdjacency(
    seeds: Array<{ entityId: number; energy: number; via: string }>,
    adjacency: Record<number, SortedRel[]>,
    mode: "native" | "ts",
): ActivationResult[] {
    const activated = new Map<number, ActivatedNode>();
    const seedMap = new Map<number, { energy: number; via: string }>();
    for (const s of seeds) seedMap.set(s.entityId, { energy: s.energy, via: s.via });

    if (mode === "native") {
        const seedArr: NativeSeedEntity[] = seeds.map(s => ({
            entityId: s.entityId,
            energy: s.energy,
            via: s.via,
        }));
        for (const s of seeds) {
            activated.set(s.entityId, { entityId: s.entityId, energy: s.energy, hops: 0, via: s.via });
        }
        const rustAdjacency: Record<string, RustRel[]> = {};
        for (const [k, v] of Object.entries(adjacency)) {
            rustAdjacency[k] = toRustRels(v);
        }
        const adjacencyJson = JSON.stringify(rustAdjacency);
        const results = nativeSpreadActivationBfs(seedArr, adjacencyJson);
        if (!results) {
            throw new Error("native BFS unavailable — cannot run parity test in 'native' mode");
        }
        for (const r of results) {
            activated.set(r.memoryId, {
                entityId: r.memoryId,
                energy: r.activationScore,
                hops: r.hops,
                via: r.via,
            });
        }
    } else {
        const queue: ActivatedNode[] = [];
        let totalActivated = 0;
        for (const s of seeds) {
            const node: ActivatedNode = { entityId: s.entityId, energy: s.energy, hops: 0, via: s.via };
            activated.set(s.entityId, node);
            queue.push(node);
            totalActivated++;
        }
        while (totalActivated < MAX_ACTIVATED_NODES) {
            const current = queue.shift();
            if (!current) break;
            if (current.hops >= MAX_HOPS) continue;

            const rels = adjacency[current.entityId] ?? [];
            const sortedRels = [...rels]
                .sort((a, b) => b.weight - a.weight)
                .slice(0, MAX_BRANCH_FACTOR);

            for (const rel of sortedRels) {
                if (totalActivated >= MAX_ACTIVATED_NODES) break;
                const neighborEnergy = current.energy * DECAY_PER_HOP * rel.weight;
                if (neighborEnergy < ACTIVATION_THRESHOLD) continue;
                const existing = activated.get(rel.entityId);
                if (existing) {
                    if (neighborEnergy > existing.energy) existing.energy = neighborEnergy;
                    continue;
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
        }
    }

    const results: ActivationResult[] = [];
    for (const [, node] of activated) {
        if (node.hops === 0) continue;
        results.push({
            memoryId: node.entityId,
            activationScore: node.energy,
            hops: node.hops,
            via: node.via,
        });
    }
    return results.sort((a, b) => b.activationScore - a.activationScore);
}
