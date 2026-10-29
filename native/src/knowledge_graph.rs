// Copyright (c) 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Knowledge Graph — Full port of src/memory/knowledge-graph.ts (algorithmic parts)
// SQLite I/O stays in JS; Rust handles graph traversal and relationship scoring.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct KGEntity {
    pub id: i64,
    pub name: String,
    pub r#type: String,
    pub properties_json: String, // JSON string
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct KGRelationship {
    pub id: i64,
    pub from_id: i64,
    pub to_id: i64,
    pub r#type: String,
    pub properties_json: String, // JSON string
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct KGRelationshipWithEntity {
    pub relationship: KGRelationship,
    pub entity: KGEntity,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct AdjacencyEntry {
    pub entity_id: i64,
    pub neighbors: Vec<KGNeighbor>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct KGNeighbor {
    pub entity_id: i64,
    pub entity_name: String,
    pub relationship_type: String,
    pub weight: f64,
}

// ── Graph Traversal (BFS) ──────────────────────────

/// BFS traversal from a start entity through pre-fetched adjacency.
/// adjacency_json: { entity_id: [{ entity_id, entity_name, relationship_type, weight }] }
/// Returns all visited entity IDs in BFS order.
#[napi]
pub fn traverse_graph_bfs(
    start_entity_id: i64,
    adjacency_json: String,
    max_depth: u32,
) -> Vec<i64> {
    let adjacency: std::collections::HashMap<i64, Vec<KGNeighbor>> =
        serde_json::from_str(&adjacency_json).unwrap_or_default();

    let mut visited: HashSet<i64> = HashSet::new();
    let mut result: Vec<i64> = Vec::new();
    let mut queue: VecDeque<(i64, u32)> = VecDeque::new();
    queue.push_back((start_entity_id, 0));

    while let Some((current_id, depth)) = queue.pop_front() {
        if visited.contains(&current_id) || depth > max_depth {
            continue;
        }
        visited.insert(current_id);
        result.push(current_id);

        if depth < max_depth {
            if let Some(neighbors) = adjacency.get(&current_id) {
                for neighbor in neighbors {
                    if !visited.contains(&neighbor.entity_id) {
                        queue.push_back((neighbor.entity_id, depth + 1));
                    }
                }
            }
        }
    }

    result
}

/// Extract key nouns/keywords from text (words > 4 chars).
/// Used for entity-memory mapping in spreading activation.
#[napi]
pub fn extract_keywords(content: String, max_keywords: u32) -> Vec<String> {
    let lower = content.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.len() > 4)
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<String> = Vec::new();

    for word in words {
        if seen.contains(word) {
            continue;
        }
        seen.insert(word.to_string());
        result.push(word.to_string());
        if result.len() >= max_keywords as usize {
            break;
        }
    }

    result
}

/// Score entity relationships by weight, returning top-k strongest edges.
/// Used in spreading activation for branch-factor limiting.
#[napi]
pub fn top_k_relationships(
    relationships: Vec<KGRelationshipWithEntity>,
    k: u32,
) -> Vec<KGRelationshipWithEntity> {
    let mut sorted = relationships;
    sorted.sort_by(|a, b| {
        let weight_a = extract_weight(&a.relationship.properties_json);
        let weight_b = extract_weight(&b.relationship.properties_json);
        weight_b
            .partial_cmp(&weight_a)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    sorted.into_iter().take(k as usize).collect()
}

fn extract_weight(properties_json: &str) -> f64 {
    if let Ok(props) = serde_json::from_str::<serde_json::Value>(properties_json) {
        if let Some(w) = props.get("weight").and_then(|v| v.as_f64()) {
            return w;
        }
    }
    0.5 // default weight
}
