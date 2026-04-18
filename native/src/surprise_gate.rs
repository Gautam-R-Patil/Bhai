// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Surprise Gate (D-MEM inspired) — Rust hot-path for Reward Prediction Error computation,
// surprise-weighted importance scoring, and batch analysis for memory consolidation.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

/// Maximum importance boost from surprise
const MAX_SURPRISE_BOOST: f64 = 3.0;

/// Minimum |RPE| to be considered "surprising"
const SURPRISE_THRESHOLD: f64 = 0.2;

/// Decay acceleration factor for unsurprising memories
const BORING_DECAY_MULTIPLIER: f64 = 1.5;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: u32,
    pub content: String,
    pub importance: f64,
    pub access_count: u32,
    pub days_old: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SurpriseResult {
    pub memory_id: u32,
    pub rpe: f64,
    pub new_importance: f64,
    pub is_surprising: bool,
    pub decay_multiplier: f64,
}

// ── Core RPE Computation ───────────────────────────

/// Compute Reward Prediction Error (RPE).
/// RPE = actual_outcome - predicted_confidence
///
/// Positive RPE: outcome better than expected → strengthen memory
/// Negative RPE: outcome worse than expected → also strengthen (learn from mistakes)
/// Near-zero RPE: expected outcome → normal or accelerated decay
#[napi]
pub fn compute_rpe(predicted_confidence: f64, actual_outcome: f64) -> f64 {
    let predicted = predicted_confidence.clamp(0.0, 1.0);
    let actual = actual_outcome.clamp(0.0, 1.0);
    actual - predicted
}

/// Compute surprise-weighted importance boost.
/// High |RPE| → stronger boost. Near-zero RPE → no boost (or slight penalty).
#[napi]
pub fn surprise_importance_boost(base_importance: f64, rpe: f64) -> f64 {
    let abs_rpe = rpe.abs();

    if abs_rpe < SURPRISE_THRESHOLD {
        // Not surprising — no boost
        return base_importance;
    }

    // Boost proportional to |RPE|, capped
    let boost = (abs_rpe * 2.0).min(MAX_SURPRISE_BOOST);
    let new_importance = base_importance * (1.0 + boost);

    new_importance.min(10.0) // Hard cap to prevent runaway importance
}

/// Determine the decay multiplier for a memory based on its surprise level.
/// Unsurprising memories decay faster; surprising ones are protected.
#[napi]
pub fn surprise_decay_multiplier(rpe: f64) -> f64 {
    let abs_rpe = rpe.abs();

    if abs_rpe < SURPRISE_THRESHOLD {
        BORING_DECAY_MULTIPLIER // Faster decay for predictable outcomes
    } else if abs_rpe > 0.5 {
        0.5 // Slower decay for very surprising outcomes
    } else {
        1.0 // Normal decay for moderately surprising
    }
}

// ── Batch Processing ───────────────────────────────

/// Process a batch of memories against their predicted outcomes.
/// Used during memory consolidation (dreaming) to update importance scores.
///
/// `predictions` is a parallel array to `memories`:
/// predictions[i] = how well the agent expected memory[i]'s context to turn out.
/// `outcomes` is a parallel array of actual outcomes (0-1 task success).
#[napi]
pub fn batch_surprise_scores(
    memories: Vec<MemoryEntry>,
    predictions: Vec<f64>,
    outcomes: Vec<f64>,
) -> Vec<SurpriseResult> {
    let n = memories.len().min(predictions.len()).min(outcomes.len());
    let mut results: Vec<SurpriseResult> = Vec::with_capacity(n);

    for i in 0..n {
        let predicted = predictions[i].clamp(0.0, 1.0);
        let actual = outcomes[i].clamp(0.0, 1.0);
        let rpe = actual - predicted;
        let abs_rpe = rpe.abs();
        let is_surprising = abs_rpe >= SURPRISE_THRESHOLD;

        let new_importance = surprise_importance_boost(memories[i].importance, rpe);
        let decay_mult = surprise_decay_multiplier(rpe);

        results.push(SurpriseResult {
            memory_id: memories[i].id,
            rpe,
            new_importance,
            is_surprising,
            decay_multiplier: decay_mult,
        });
    }

    results
}

/// Compute a composite "surprisingness" score for a set of memories.
/// Used to identify which memories to prioritize during dream consolidation.
/// Returns sorted (highest surprise first) list of (memory_id, surprise_score).
#[napi]
pub fn rank_by_surprise(
    memories: Vec<MemoryEntry>,
    predictions: Vec<f64>,
    outcomes: Vec<f64>,
) -> Vec<Vec<f64>> {
    let n = memories.len().min(predictions.len()).min(outcomes.len());
    let mut scored: Vec<(u32, f64)> = Vec::with_capacity(n);

    for i in 0..n {
        let rpe = (outcomes[i].clamp(0.0, 1.0)) - (predictions[i].clamp(0.0, 1.0));
        let abs_rpe = rpe.abs();

        // Surprise score considers RPE magnitude, recency, and access patterns
        let recency_factor = (1.0 / (1.0 + memories[i].days_old * 0.1)).min(1.0);
        let novelty_factor = if memories[i].access_count <= 1 { 1.2 } else { 1.0 };
        let surprise_score = abs_rpe * recency_factor * novelty_factor;

        scored.push((memories[i].id, surprise_score));
    }

    // Sort by surprise descending
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    scored
        .iter()
        .map(|(id, score)| vec![*id as f64, *score])
        .collect()
}

/// Self-evolving strength score with surprise integration.
/// Enhanced version of the existing strengthScore formula in self-evolving.ts:
///   strength = importance × log₂(access_count) × recency × (1 + surprise_bonus)
#[napi]
pub fn compute_strength_with_surprise(
    importance: f64,
    access_count: u32,
    days_old: f64,
    emotional_weight: f64,
    surprise_bonus: f64,
) -> f64 {
    let access_factor = ((access_count.max(1) as f64).log2()).max(0.1);
    let recency = (1.0 / (1.0 + days_old * 0.05)).max(0.01);
    let emotion = emotional_weight.max(1.0); // minimum 1.0 (no emotion = no multiplier)
    let surprise = 1.0 + surprise_bonus.clamp(-0.5, MAX_SURPRISE_BOOST);

    importance * access_factor * recency * emotion * surprise
}
