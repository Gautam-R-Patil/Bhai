// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Hopfield Network — Modern continuous Hopfield network for associative memory.
// Pattern-completion: partial cues complete to nearest stored memory.
// Exponential storage capacity with O(d) retrieval.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

const MAX_ITERATIONS: usize = 50;
const CONVERGENCE_THRESHOLD: f64 = 1e-6;
const TEMPERATURE: f64 = 0.1; // Lower = sharper retrieval

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct HopfieldResult {
    pub pattern_index: i32, // Index of the closest stored pattern (-1 if no match)
    pub similarity: f64,    // Cosine similarity to the matched pattern
    pub iterations: u32,    // Convergence iterations
    pub converged: bool,
    pub energy: f64, // Final energy (lower = better match)
}

// ── Modern Continuous Hopfield Network ─────────────

/// Store patterns and retrieve the closest match given a partial/noisy cue.
/// Uses the modern continuous Hopfield update rule with exponential capacity.
///
/// patterns: Matrix of stored patterns (each is a float vector)
/// cue: Partial or noisy input pattern
/// beta: Inverse temperature (higher = sharper, default from TEMPERATURE)
#[napi]
pub fn hopfield_retrieve(
    patterns: Vec<Float32Array>,
    cue: Float32Array,
    beta: Option<f64>,
) -> HopfieldResult {
    let b = beta.unwrap_or(1.0 / TEMPERATURE);
    let query = cue.as_ref();

    if patterns.is_empty() || query.is_empty() {
        return HopfieldResult {
            pattern_index: -1,
            similarity: 0.0,
            iterations: 0,
            converged: false,
            energy: 0.0,
        };
    }

    let dim = query.len();
    let mut state: Vec<f64> = query.iter().map(|&x| x as f64).collect();

    // Iterative update until convergence
    let mut prev_energy = f64::INFINITY;
    let mut iterations = 0u32;
    let mut converged = false;

    for iter in 0..MAX_ITERATIONS {
        iterations = iter as u32 + 1;

        // Compute attention weights: softmax(beta * patterns^T * state)
        let mut logits: Vec<f64> = Vec::with_capacity(patterns.len());
        for pattern in &patterns {
            let p = pattern.as_ref();
            if p.len() != dim {
                continue;
            }
            let dot: f64 = state
                .iter()
                .zip(p.iter())
                .map(|(&s, &p)| s * p as f64)
                .sum();
            logits.push(b * dot);
        }

        // Softmax
        let max_logit = logits.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let exp_logits: Vec<f64> = logits.iter().map(|&l| (l - max_logit).exp()).collect();
        let sum_exp: f64 = exp_logits.iter().sum();
        let weights: Vec<f64> = exp_logits.iter().map(|&e| e / sum_exp).collect();

        // Update state: weighted sum of patterns
        let mut new_state = vec![0.0f64; dim];
        for (i, pattern) in patterns.iter().enumerate() {
            let p = pattern.as_ref();
            if i >= weights.len() || p.len() != dim {
                continue;
            }
            let w = weights[i];
            for j in 0..dim {
                new_state[j] += w * p[j] as f64;
            }
        }

        // Normalize
        let norm: f64 = new_state.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm > 1e-10 {
            for x in &mut new_state {
                *x /= norm;
            }
        }

        // Compute energy
        let energy = -logits
            .iter()
            .zip(weights.iter())
            .map(|(&l, &w)| w * l)
            .sum::<f64>();

        // Check convergence
        let state_diff: f64 = state
            .iter()
            .zip(new_state.iter())
            .map(|(&a, &b)| (a - b).powi(2))
            .sum::<f64>();

        state = new_state;

        if state_diff < CONVERGENCE_THRESHOLD
            || (prev_energy - energy).abs() < CONVERGENCE_THRESHOLD
        {
            converged = true;
            prev_energy = energy;
            break;
        }
        prev_energy = energy;
    }

    // Find closest pattern
    let mut best_idx: i32 = -1;
    let mut best_sim = -1.0f64;

    for (i, pattern) in patterns.iter().enumerate() {
        let p = pattern.as_ref();
        if p.len() != dim {
            continue;
        }
        let sim: f64 = state
            .iter()
            .zip(p.iter())
            .map(|(&s, &p)| s * p as f64)
            .sum();
        if sim > best_sim {
            best_sim = sim;
            best_idx = i as i32;
        }
    }

    HopfieldResult {
        pattern_index: best_idx,
        similarity: best_sim,
        iterations,
        converged,
        energy: prev_energy,
    }
}

/// Batch retrieval: find closest patterns for multiple cues at once.
#[napi]
pub fn hopfield_batch_retrieve(
    patterns: Vec<Float32Array>,
    cues: Vec<Float32Array>,
    beta: Option<f64>,
) -> Vec<HopfieldResult> {
    cues.iter()
        .map(|cue| hopfield_retrieve(patterns.clone(), cue.clone(), beta))
        .collect()
}

/// Compute the energy of a state given stored patterns.
/// Lower energy = state is closer to a stored pattern.
#[napi]
pub fn hopfield_energy(patterns: Vec<Float32Array>, state: Float32Array, beta: Option<f64>) -> f64 {
    let b = beta.unwrap_or(1.0 / TEMPERATURE);
    let s = state.as_ref();

    if patterns.is_empty() || s.is_empty() {
        return 0.0;
    }

    let dim = s.len();
    let mut log_sum_exp = 0.0f64;
    let mut max_dot = f64::NEG_INFINITY;

    // First pass: find max for numerical stability
    for pattern in &patterns {
        let p = pattern.as_ref();
        if p.len() != dim {
            continue;
        }
        let dot: f64 = s
            .iter()
            .zip(p.iter())
            .map(|(&si, &pi)| si as f64 * pi as f64)
            .sum();
        if b * dot > max_dot {
            max_dot = b * dot;
        }
    }

    // Second pass: log-sum-exp
    for pattern in &patterns {
        let p = pattern.as_ref();
        if p.len() != dim {
            continue;
        }
        let dot: f64 = s
            .iter()
            .zip(p.iter())
            .map(|(&si, &pi)| si as f64 * pi as f64)
            .sum();
        log_sum_exp += (b * dot - max_dot).exp();
    }

    -(max_dot + log_sum_exp.ln()) / b
}
