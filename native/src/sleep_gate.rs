// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// SleepGate — Biologically inspired memory consolidation (March 2026).
// Three mechanisms: conflict-aware temporal tagger, forgetting gate, consolidation merger.
// Reduces proactive interference from O(n) to O(log n).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

const CONFLICT_SIMILARITY_THRESHOLD: f64 = 0.75;
const FORGET_GATE_THRESHOLD: f64 = 0.3;
const MERGE_SIMILARITY_THRESHOLD: f64 = 0.85;
const MAX_CONSOLIDATION_BATCH: usize = 200;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SleepMemoryEntry {
    pub id: u32,
    pub content: String,
    pub importance: f64,
    pub access_count: u32,
    pub days_old: f64,
    pub emotional_weight: f64,
    pub category: String,
    pub embedding_sim_to_recent: f64, // Similarity to recent session content
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ConflictTag {
    pub old_memory_id: u32,
    pub new_memory_id: u32,
    pub conflict_type: String,  // "superseded" | "contradicted" | "duplicated"
    pub similarity: f64,
    pub resolution: String,     // "keep_new" | "keep_old" | "merge" | "keep_both"
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ForgetDecision {
    pub memory_id: u32,
    pub retention_score: f64,   // 0-1, below threshold = forget
    pub should_forget: bool,
    pub reason: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MergeCandidate {
    pub memory_a_id: u32,
    pub memory_b_id: u32,
    pub similarity: f64,
    pub combined_importance: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SleepGateResult {
    pub conflicts_detected: Vec<ConflictTag>,
    pub memories_to_forget: Vec<u32>,
    pub merge_candidates: Vec<MergeCandidate>,
    pub memories_strengthened: Vec<u32>,
    pub total_processed: u32,
}

// ── Phase 1: Conflict-Aware Temporal Tagging ───────

/// Detect when new memories supersede or contradict old ones.
/// Compares recent memories against existing store using similarity scores.
#[napi]
pub fn detect_conflicts(
    recent_memories: Vec<SleepMemoryEntry>,
    existing_memories: Vec<SleepMemoryEntry>,
    similarity_matrix: Vec<Vec<f64>>,  // [recent_idx][existing_idx] = sim score
) -> Vec<ConflictTag> {
    let mut conflicts = Vec::new();

    for (ri, recent) in recent_memories.iter().enumerate() {
        if ri >= similarity_matrix.len() { break; }

        for (ei, existing) in existing_memories.iter().enumerate() {
            if ei >= similarity_matrix[ri].len() { break; }

            let sim = similarity_matrix[ri][ei];
            if sim < CONFLICT_SIMILARITY_THRESHOLD { continue; }

            // Determine conflict type
            let conflict_type = if sim > MERGE_SIMILARITY_THRESHOLD {
                "duplicated"
            } else if recent.category == existing.category {
                "superseded"
            } else {
                "contradicted"
            };

            // Resolution strategy
            let resolution = match conflict_type {
                "duplicated" => {
                    if recent.importance >= existing.importance { "keep_new" } else { "merge" }
                }
                "superseded" => "keep_new",     // Newer info replaces older
                "contradicted" => {
                    if recent.emotional_weight > existing.emotional_weight {
                        "keep_new"
                    } else {
                        "keep_both"  // Keep both if uncertain
                    }
                }
                _ => "keep_both",
            };

            conflicts.push(ConflictTag {
                old_memory_id: existing.id,
                new_memory_id: recent.id,
                conflict_type: conflict_type.to_string(),
                similarity: sim,
                resolution: resolution.to_string(),
            });
        }
    }

    conflicts
}

// ── Phase 2: Forgetting Gate ───────────────────────

/// Selective eviction of low-value memories.
/// Retention score considers: importance, access frequency, recency, emotional weight,
/// and whether the memory conflicts with newer information.
#[napi]
pub fn compute_forget_decisions(
    memories: Vec<SleepMemoryEntry>,
    superseded_ids: Vec<u32>,  // IDs of memories marked as superseded by conflicts
) -> Vec<ForgetDecision> {
    let superseded_set: std::collections::HashSet<u32> = superseded_ids.iter().copied().collect();

    memories.iter().map(|m| {
        // Base retention from importance and access
        let access_factor = (m.access_count as f64).log2().max(0.1) / 5.0;
        let recency_factor = (-0.02 * m.days_old).exp();
        let emotional_factor = m.emotional_weight.max(0.1);

        let mut retention = m.importance * 0.3
            + access_factor * 0.2
            + recency_factor * 0.25
            + emotional_factor * 0.15
            + m.embedding_sim_to_recent * 0.1;

        // Penalty for superseded memories
        if superseded_set.contains(&m.id) {
            retention *= 0.3; // Severe penalty
        }

        retention = retention.clamp(0.0, 1.0);
        let should_forget = retention < FORGET_GATE_THRESHOLD;

        let reason = if should_forget {
            if superseded_set.contains(&m.id) {
                format!("Superseded by newer info (retention: {:.2})", retention)
            } else if m.days_old > 30.0 && m.access_count <= 1 {
                format!("Old and rarely accessed (retention: {:.2})", retention)
            } else {
                format!("Low composite retention score: {:.2}", retention)
            }
        } else {
            format!("Retained (score: {:.2})", retention)
        };

        ForgetDecision {
            memory_id: m.id,
            retention_score: retention,
            should_forget,
            reason,
        }
    }).collect()
}

// ── Phase 3: Consolidation Merger ──────────────────

/// Find memories that are similar enough to merge into consolidated summaries.
/// Returns pairs of memories that should be merged.
#[napi]
pub fn find_merge_candidates(
    memories: Vec<SleepMemoryEntry>,
    pairwise_similarities: Vec<Vec<f64>>,  // [i][j] = similarity
) -> Vec<MergeCandidate> {
    let mut candidates = Vec::new();
    let n = memories.len().min(pairwise_similarities.len());

    for i in 0..n {
        for j in (i + 1)..n {
            if j >= pairwise_similarities[i].len() { continue; }

            let sim = pairwise_similarities[i][j];
            if sim >= MERGE_SIMILARITY_THRESHOLD {
                candidates.push(MergeCandidate {
                    memory_a_id: memories[i].id,
                    memory_b_id: memories[j].id,
                    similarity: sim,
                    combined_importance: (memories[i].importance + memories[j].importance) / 2.0
                        * 1.1, // Slight boost for merged memories
                });
            }
        }
    }

    // Sort by similarity descending
    candidates.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(50); // Cap merges per cycle
    candidates
}

// ── Full SleepGate Pipeline ────────────────────────

/// Run the complete SleepGate pipeline: detect conflicts → forget → find merges → strengthen.
#[napi]
pub fn run_sleep_gate(
    recent_memories: Vec<SleepMemoryEntry>,
    existing_memories: Vec<SleepMemoryEntry>,
    recent_to_existing_sims: Vec<Vec<f64>>,
    existing_pairwise_sims: Vec<Vec<f64>>,
) -> SleepGateResult {
    // Phase 1: Conflict detection
    let conflicts = detect_conflicts(
        recent_memories.clone(),
        existing_memories.clone(),
        recent_to_existing_sims,
    );

    // Collect superseded IDs
    let superseded_ids: Vec<u32> = conflicts.iter()
        .filter(|c| c.resolution == "keep_new")
        .map(|c| c.old_memory_id)
        .collect();

    // Phase 2: Forgetting gate
    let forget_decisions = compute_forget_decisions(existing_memories.clone(), superseded_ids);
    let memories_to_forget: Vec<u32> = forget_decisions.iter()
        .filter(|d| d.should_forget)
        .map(|d| d.memory_id)
        .collect();

    // Phase 3: Find merge candidates (among surviving memories)
    let surviving: Vec<SleepMemoryEntry> = existing_memories.iter()
        .filter(|m| !memories_to_forget.contains(&m.id))
        .cloned()
        .collect();

    let merge_candidates = if !existing_pairwise_sims.is_empty() {
        find_merge_candidates(surviving, existing_pairwise_sims)
    } else {
        vec![]
    };

    // Strengthen memories with high recent relevance
    let strengthened: Vec<u32> = existing_memories.iter()
        .filter(|m| m.embedding_sim_to_recent > 0.6 && !memories_to_forget.contains(&m.id))
        .map(|m| m.id)
        .collect();

    SleepGateResult {
        conflicts_detected: conflicts,
        memories_to_forget,
        merge_candidates,
        memories_strengthened: strengthened,
        total_processed: existing_memories.len() as u32,
    }
}
