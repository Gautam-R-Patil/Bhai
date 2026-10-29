// Copyright (c) 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Memory Consolidation — Full port of src/memory/consolidation.ts (algorithmic parts)

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ── Constants ──────────────────────────────────────

const CLUSTER_SIMILARITY_THRESHOLD: f64 = 0.7;
const MIN_CLUSTER_SIZE: usize = 5;
const MAX_CLUSTERS_PER_NIGHT: usize = 10;
const ARCHIVE_AGE_DAYS: u64 = 180;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ConsolidationMemory {
    pub id: i64,
    pub content: String,
    pub category: String,
    pub tags: String,
    pub importance: f64,
    pub access_count: i64,
    /// Flat f64 array representing the embedding vector (empty if no embedding)
    pub embedding: Vec<f64>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MemoryCluster {
    pub member_ids: Vec<i64>,
    pub centroid_content: String,
    pub max_importance: f64,
    pub total_access: i64,
    pub all_tags: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ConsolidationStats {
    pub clustered_count: i64,
    pub crystals_created: i64,
    pub archived: i64,
}

// ── Cosine Similarity ──────────────────────────────

fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    let mut dot: f64 = 0.0;
    let mut norm_a: f64 = 0.0;
    let mut norm_b: f64 = 0.0;
    let len = a.len().min(b.len());

    for i in 0..len {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    dot / denom
}

/// Compute cosine similarity between two vectors
#[napi]
pub fn consolidation_cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
    cosine_similarity(&a, &b)
}

// ── Greedy Clustering ──────────────────────────────

/// Greedy clustering of memories by embedding similarity.
/// O(n^2) but only on cold-tier memories (small subset).
/// Returns clusters as JSON array of MemoryCluster.
#[napi]
pub fn cluster_by_embedding(
    memories: Vec<ConsolidationMemory>,
    threshold: Option<f64>,
) -> Vec<MemoryCluster> {
    let threshold = threshold.unwrap_or(CLUSTER_SIMILARITY_THRESHOLD);
    let mut clusters: Vec<MemoryCluster> = Vec::new();
    let mut assigned: HashSet<usize> = HashSet::new();

    // Filter to only memories with embeddings
    let with_embeddings: Vec<(usize, &ConsolidationMemory)> = memories
        .iter()
        .enumerate()
        .filter(|(_, m)| !m.embedding.is_empty())
        .collect();

    for i in 0..with_embeddings.len() {
        let (idx_i, _) = with_embeddings[i];
        if assigned.contains(&idx_i) {
            continue;
        }

        let mut cluster_indices: Vec<usize> = vec![idx_i];
        assigned.insert(idx_i);

        for &(idx_j, _) in &with_embeddings[i + 1..] {
            if assigned.contains(&idx_j) {
                continue;
            }

            let sim = cosine_similarity(&memories[idx_i].embedding, &memories[idx_j].embedding);

            if sim >= threshold {
                cluster_indices.push(idx_j);
                assigned.insert(idx_j);
            }
        }

        // Build cluster
        let member_ids: Vec<i64> = cluster_indices
            .iter()
            .map(|&idx| memories[idx].id)
            .collect();
        let centroid_content: String = cluster_indices
            .iter()
            .map(|&idx| memories[idx].content.as_str())
            .collect::<Vec<_>>()
            .join("\n---\n");

        let max_importance = cluster_indices
            .iter()
            .map(|&idx| memories[idx].importance)
            .fold(0.0f64, f64::max);

        let total_access: i64 = cluster_indices
            .iter()
            .map(|&idx| memories[idx].access_count)
            .sum();

        let mut all_tags: HashSet<String> = HashSet::new();
        for &idx in &cluster_indices {
            for tag in memories[idx]
                .tags
                .split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
            {
                all_tags.insert(tag);
            }
        }
        all_tags.insert("crystal".to_string());
        all_tags.insert("consolidated".to_string());

        clusters.push(MemoryCluster {
            member_ids,
            centroid_content,
            max_importance: (max_importance + 1.0).min(10.0),
            total_access,
            all_tags: all_tags.into_iter().collect(),
        });
    }

    clusters
}

/// Filter clusters to those meeting minimum size, capped at max per night
#[napi]
pub fn filter_valid_clusters(
    clusters: Vec<MemoryCluster>,
    min_size: Option<u32>,
    max_per_night: Option<u32>,
) -> Vec<MemoryCluster> {
    let min_size = min_size.unwrap_or(MIN_CLUSTER_SIZE as u32) as usize;
    let max_per_night = max_per_night.unwrap_or(MAX_CLUSTERS_PER_NIGHT as u32) as usize;

    clusters
        .into_iter()
        .filter(|c| c.member_ids.len() >= min_size)
        .take(max_per_night)
        .collect()
}

/// Compute the archive cutoff timestamp (ISO string) for cleaning old archived memories
#[napi]
pub fn compute_archive_cutoff_ms(archive_age_days: Option<u32>) -> f64 {
    let days = archive_age_days.unwrap_or(ARCHIVE_AGE_DAYS as u32) as u64;
    let cutoff_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        - days * 24 * 60 * 60 * 1000;
    cutoff_ms as f64
}
