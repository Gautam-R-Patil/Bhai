// Copyright (c) 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Spreading Activation Network — Full port of src/memory/spreading-activation.ts

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

// ── Constants ──────────────────────────────────────

const MAX_BRANCH_FACTOR: usize = 5;
const MAX_ACTIVATED_NODES: usize = 150;
const MAX_HOPS: usize = 3;
const DECAY_PER_HOP: f64 = 0.7;
const ACTIVATION_THRESHOLD: f64 = 0.15;
const SAN_WEIGHT: f64 = 0.3;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ActivationResult {
    pub memory_id: i64,
    pub activation_score: f64,
    pub hops: u32,
    pub via: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SeedScore {
    pub memory_id: i64,
    pub score: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EntityRelation {
    pub entity_id: i64,
    pub entity_name: String,
    pub weight: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SeedEntity {
    pub entity_id: i64,
    pub energy: f64,
    pub via: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FusedScore {
    pub id: i64,
    pub score: f64,
}

/// One adjacency-map entry: an entity ID plus its outgoing edges. Used by
/// `spread_activation_bfs_typed` to skip the JSON round-trip that the
/// `_json` variant uses. JS passes an array of these, the Rust side
/// collects them into a HashMap once.
#[napi(object)]
#[derive(Clone)]
pub struct SpreadAdjacencyEntry {
    pub entity_id: i64,
    pub relations: Vec<EntityRelation>,
}

// ── Internal Node ──────────────────────────────────

struct ActivatedNode {
    entity_id: i64,
    energy: f64,
    hops: usize,
    via: String,
}

// ── Core BFS Spreading Activation ──────────────────

/// Core BFS spreading-activation algorithm. Operates on a pre-built
/// adjacency `HashMap`; the two public napi entry points (`_json` and
/// `_typed`) differ only in how they obtain that map. Pulled out to keep
/// the algorithm in one place and let perf reviews focus on the marshalling
/// boundary, not the BFS itself.
fn run_bfs(
    seed_entities: &[SeedEntity],
    adjacency: HashMap<i64, Vec<EntityRelation>>,
) -> Vec<ActivationResult> {
    let mut activated: HashMap<i64, ActivatedNode> = HashMap::new();
    let mut queue: VecDeque<ActivatedNode> = VecDeque::new();
    let mut total_activated: usize = 0;

    // Initialize with seeds
    for se in seed_entities {
        let node = ActivatedNode {
            entity_id: se.entity_id,
            energy: se.energy,
            hops: 0,
            via: se.via.clone(),
        };
        queue.push_back(ActivatedNode {
            entity_id: se.entity_id,
            energy: se.energy,
            hops: 0,
            via: se.via.clone(),
        });
        activated.insert(se.entity_id, node);
        total_activated += 1;
    }

    // BFS with bounded branching
    while let Some(current) = queue.pop_front() {
        if total_activated >= MAX_ACTIVATED_NODES {
            break;
        }
        if current.hops >= MAX_HOPS {
            continue;
        }

        let rels = match adjacency.get(&current.entity_id) {
            Some(r) => r,
            None => continue,
        };

        // Sort by weight descending, take top MAX_BRANCH_FACTOR
        let mut sorted_rels = rels.clone();
        sorted_rels.sort_by(|a, b| {
            b.weight
                .partial_cmp(&a.weight)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let top_rels: Vec<_> = sorted_rels.into_iter().take(MAX_BRANCH_FACTOR).collect();

        for rel in top_rels {
            if total_activated >= MAX_ACTIVATED_NODES {
                break;
            }

            let neighbor_energy = current.energy * DECAY_PER_HOP * rel.weight;
            if neighbor_energy < ACTIVATION_THRESHOLD {
                continue;
            }

            if let Some(existing) = activated.get_mut(&rel.entity_id) {
                // Max energy from multiple paths (no explosion)
                if neighbor_energy > existing.energy {
                    existing.energy = neighbor_energy;
                }
                continue; // Don't re-queue
            }

            let new_node = ActivatedNode {
                entity_id: rel.entity_id,
                energy: neighbor_energy,
                hops: current.hops + 1,
                via: rel.entity_name.clone(),
            };
            queue.push_back(ActivatedNode {
                entity_id: rel.entity_id,
                energy: neighbor_energy,
                hops: current.hops + 1,
                via: rel.entity_name.clone(),
            });
            activated.insert(rel.entity_id, new_node);
            total_activated += 1;
        }
    }

    // Collect non-seed results
    let mut results: Vec<ActivationResult> = activated
        .into_values()
        .filter(|node| node.hops > 0)
        .map(|node| ActivationResult {
            memory_id: node.entity_id,
            activation_score: node.energy,
            hops: node.hops as u32,
            via: node.via,
        })
        .collect();

    results.sort_by(|a, b| {
        b.activation_score
            .partial_cmp(&a.activation_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    results
}

/// Run BFS spreading activation from seed entities through a graph.
/// The relationship lookups happen in JS; this function performs the BFS logic.
/// `seed_entities`: initial entities with energy and label
/// `adjacency_json`: JSON object `{ "entity_id": [ {entity_id, entity_name, weight}, ... ] }`
///
/// This is the default entry point used by the TS wrapper. The Phase 0-PERF
/// experiment hypothesized that JSON parsing was the bottleneck and tried
/// `spread_activation_bfs_typed` to skip it; bench showed the typed variant
/// was actually ~15% SLOWER (per-property napi marshalling > serde on small
/// adjacency maps). The real bottleneck is the FFI crossing itself.
#[napi]
pub fn spread_activation_bfs(
    seed_entities: Vec<SeedEntity>,
    adjacency_json: String,
) -> Vec<ActivationResult> {
    let adjacency: HashMap<i64, Vec<EntityRelation>> =
        serde_json::from_str(&adjacency_json).unwrap_or_default();
    run_bfs(&seed_entities, adjacency)
}

/// Same as `spread_activation_bfs` but takes the adjacency as a typed array
/// of `{ entity_id, relations }` records, skipping the JSON round-trip.
///
/// Bench (Phase 0-PERF) showed this was ~15% SLOWER than the `_json` variant
/// at 50 nodes — per-property napi marshalling (300+ JS-property reads on a
/// 50-node × 5-edge graph) costs more than `serde_json::from_str` on the
/// same data. Not used by the production TS wrapper; exercised by the
/// `__testOnlyBfsWithAdjacency` parity test under the `"native-typed"` mode
/// so it can't silently rot, and retained on the chance a future >1000-node
/// workload changes the crossover.
#[napi]
pub fn spread_activation_bfs_typed(
    seed_entities: Vec<SeedEntity>,
    adjacency: Vec<SpreadAdjacencyEntry>,
) -> Vec<ActivationResult> {
    let map: HashMap<i64, Vec<EntityRelation>> = adjacency
        .into_iter()
        .map(|e| (e.entity_id, e.relations))
        .collect();
    run_bfs(&seed_entities, map)
}

/// Deduplicate activation results, keeping highest score per memory_id
#[napi]
pub fn dedup_activation_results(results: Vec<ActivationResult>) -> Vec<ActivationResult> {
    let mut best: HashMap<i64, ActivationResult> = HashMap::new();

    for r in results {
        let entry = best.entry(r.memory_id).or_insert_with(|| r.clone());
        if r.activation_score > entry.activation_score {
            *entry = r;
        }
    }

    let mut deduped: Vec<ActivationResult> = best.into_values().collect();
    deduped.sort_by(|a, b| {
        b.activation_score
            .partial_cmp(&a.activation_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    deduped
}

/// Merge SAN results into fused scores
#[napi]
pub fn merge_san_results(
    fused_scores: Vec<FusedScore>,
    san_results: Vec<ActivationResult>,
) -> Vec<FusedScore> {
    let mut result_map: HashMap<i64, f64> = HashMap::new();

    for f in &fused_scores {
        result_map.insert(f.id, f.score);
    }

    for san in &san_results {
        let boost = SAN_WEIGHT * san.activation_score;
        let entry = result_map.entry(san.memory_id).or_insert(0.0);
        *entry += boost;
    }

    let mut results: Vec<FusedScore> = result_map
        .into_iter()
        .map(|(id, score)| FusedScore { id, score })
        .collect();

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results
}

/// Compute trait-based spreading activation
/// seed_scores: memory_id -> score
/// trait_edges: [{trait_a, trait_b, weight}]
/// Returns additional activation results from trait co-occurrences
#[napi]
pub fn spread_via_traits(
    seed_scores_json: String,
    trait_edges_json: String,
) -> Vec<ActivationResult> {
    let seed_scores: Vec<SeedScore> = serde_json::from_str(&seed_scores_json).unwrap_or_default();

    #[derive(Deserialize)]
    struct TraitEdge {
        trait_a: String,
        trait_b: String,
        weight: f64,
    }

    let trait_edges: Vec<TraitEdge> = serde_json::from_str(&trait_edges_json).unwrap_or_default();

    let mut results: Vec<ActivationResult> = Vec::new();
    let seed_ids: std::collections::HashSet<i64> =
        seed_scores.iter().map(|s| s.memory_id).collect();

    for edge in &trait_edges {
        if edge.weight <= 0.3 {
            continue;
        }
        for seed in &seed_scores {
            let activation = seed.score * edge.weight * DECAY_PER_HOP;
            if activation < ACTIVATION_THRESHOLD {
                continue;
            }
            // The actual memory lookup happens in JS; we just compute scores
            results.push(ActivationResult {
                memory_id: -1, // Placeholder; JS fills in actual memory IDs
                activation_score: activation,
                hops: 1,
                via: format!("trait:{}↔{}", edge.trait_a, edge.trait_b),
            });
        }
    }

    results
}
