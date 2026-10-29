// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Active Inference — Free energy minimization for principled information-seeking.
// Based on "Active Inference for Self-Organizing Multi-LLM Systems" (2025)
// and DR-FREE (Nature Communications, Dec 2025).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

const EXPLORATION_WEIGHT: f64 = 0.3;
const EXPLOITATION_WEIGHT: f64 = 0.7;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct BeliefState {
    pub hypotheses: Vec<String>,
    pub probabilities: Vec<f64>,   // P(hypothesis) for each
    pub evidence_counts: Vec<u32>, // How much evidence for each
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FreeEnergyResult {
    pub free_energy: f64,
    pub entropy: f64,           // Uncertainty in beliefs
    pub expected_accuracy: f64, // How well beliefs predict observations
    pub should_explore: bool,   // High entropy → should seek more info
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct InfoGainResult {
    pub query_index: u32,
    pub expected_info_gain: f64,
    pub current_entropy: f64,
    pub expected_posterior_entropy: f64,
}

// ── Free Energy Computation ────────────────────────

/// Compute variational free energy of current belief state.
/// F = -<log P(o|h)> + KL[Q(h) || P(h)]
/// High free energy → beliefs are uncertain or inaccurate → need more info.
#[napi]
pub fn compute_free_energy(beliefs: BeliefState) -> FreeEnergyResult {
    if beliefs.probabilities.is_empty() {
        return FreeEnergyResult {
            free_energy: 0.0,
            entropy: 0.0,
            expected_accuracy: 0.0,
            should_explore: false,
        };
    }

    // Normalize probabilities
    let sum: f64 = beliefs.probabilities.iter().sum();
    let probs: Vec<f64> = if sum > 0.0 {
        beliefs.probabilities.iter().map(|p| p / sum).collect()
    } else {
        let n = beliefs.probabilities.len() as f64;
        vec![1.0 / n; beliefs.probabilities.len()]
    };

    // Entropy: H = -sum(p * log(p))
    let entropy: f64 = probs
        .iter()
        .filter(|&&p| p > 1e-10)
        .map(|&p| -p * p.ln())
        .sum();

    // Expected accuracy: higher with more evidence and confident beliefs
    let max_prob = probs.iter().cloned().fold(0.0f64, f64::max);
    let total_evidence: f64 = beliefs.evidence_counts.iter().sum::<u32>() as f64;
    let evidence_factor = (total_evidence / 10.0).min(1.0);
    let expected_accuracy = max_prob * evidence_factor;

    // Free energy ≈ -accuracy + entropy
    let free_energy = -expected_accuracy + entropy;

    // Should explore if entropy is high (uncertain) or evidence is low
    let should_explore = entropy > 1.0 || total_evidence < 5.0;

    FreeEnergyResult {
        free_energy,
        entropy,
        expected_accuracy,
        should_explore,
    }
}

// ── Belief Updating ────────────────────────────────

/// Bayesian belief update given new evidence.
/// Returns updated probability distribution.
#[napi]
pub fn update_beliefs(
    beliefs: BeliefState,
    evidence_for_hypothesis: u32, // Which hypothesis the evidence supports
    evidence_strength: f64,       // 0-1 how strongly it supports
) -> BeliefState {
    let mut new_probs = beliefs.probabilities.clone();
    let mut new_counts = beliefs.evidence_counts.clone();

    if (evidence_for_hypothesis as usize) < new_probs.len() {
        // Bayesian update: multiply by likelihood, renormalize
        let idx = evidence_for_hypothesis as usize;
        new_probs[idx] *= 1.0 + evidence_strength;
        new_counts[idx] += 1;

        // Renormalize
        let sum: f64 = new_probs.iter().sum();
        if sum > 0.0 {
            for p in &mut new_probs {
                *p /= sum;
            }
        }
    }

    BeliefState {
        hypotheses: beliefs.hypotheses,
        probabilities: new_probs,
        evidence_counts: new_counts,
    }
}

// ── Expected Information Gain ──────────────────────

/// Compute expected information gain for each possible query/action.
/// The query that reduces entropy the most should be executed first.
#[napi]
pub fn rank_queries_by_info_gain(
    beliefs: BeliefState,
    query_relevance_to_hypotheses: Vec<Vec<f64>>, // [query_idx][hypothesis_idx] = relevance
) -> Vec<InfoGainResult> {
    let sum: f64 = beliefs.probabilities.iter().sum();
    let probs: Vec<f64> = if sum > 0.0 {
        beliefs.probabilities.iter().map(|p| p / sum).collect()
    } else {
        return vec![];
    };

    let current_entropy: f64 = probs
        .iter()
        .filter(|&&p| p > 1e-10)
        .map(|&p| -p * p.ln())
        .sum();

    let mut results: Vec<InfoGainResult> = Vec::new();

    for (qi, relevances) in query_relevance_to_hypotheses.iter().enumerate() {
        // Simulate what happens if this query returns evidence for each hypothesis
        let mut expected_posterior_entropy = 0.0f64;

        for (hi, &prior) in probs.iter().enumerate() {
            if hi >= relevances.len() {
                continue;
            }
            let relevance = relevances[hi].clamp(0.0, 1.0);

            // P(evidence supports h_i) ≈ prior * relevance
            let p_evidence = prior * relevance + (1.0 - prior) * (1.0 - relevance);

            if p_evidence < 1e-10 {
                continue;
            }

            // Posterior after evidence
            let mut posterior = probs.clone();
            posterior[hi] *= 1.0 + relevance;
            let post_sum: f64 = posterior.iter().sum();
            if post_sum > 0.0 {
                for p in &mut posterior {
                    *p /= post_sum;
                }
            }

            // Entropy of posterior
            let post_entropy: f64 = posterior
                .iter()
                .filter(|&&p| p > 1e-10)
                .map(|&p| -p * p.ln())
                .sum();

            expected_posterior_entropy += p_evidence * post_entropy;
        }

        let info_gain = (current_entropy - expected_posterior_entropy).max(0.0);

        results.push(InfoGainResult {
            query_index: qi as u32,
            expected_info_gain: info_gain,
            current_entropy,
            expected_posterior_entropy,
        });
    }

    // Sort by info gain descending
    results.sort_by(|a, b| {
        b.expected_info_gain
            .partial_cmp(&a.expected_info_gain)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    results
}

/// Decide whether to explore (gather info) or exploit (act on current beliefs).
#[napi]
pub fn exploration_exploitation_decision(
    entropy: f64,
    max_entropy: f64,
    evidence_count: u32,
    min_evidence: u32,
) -> f64 {
    // Returns exploration score: 0 = exploit, 1 = explore
    let entropy_ratio = if max_entropy > 0.0 {
        entropy / max_entropy
    } else {
        0.0
    };
    let evidence_ratio = if min_evidence > 0 {
        1.0 - (evidence_count as f64 / min_evidence as f64).min(1.0)
    } else {
        0.0
    };

    (EXPLORATION_WEIGHT * entropy_ratio + EXPLOITATION_WEIGHT * evidence_ratio).clamp(0.0, 1.0)
}
