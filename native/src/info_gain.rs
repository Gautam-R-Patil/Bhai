// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Information Gain — Entropy computation for Bayesian query ranking.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

/// Compute Shannon entropy of a probability distribution.
#[napi]
pub fn shannon_entropy(probabilities: Vec<f64>) -> f64 {
    let sum: f64 = probabilities.iter().sum();
    if sum <= 0.0 {
        return 0.0;
    }
    let normalized: Vec<f64> = probabilities.iter().map(|p| p / sum).collect();
    -normalized
        .iter()
        .filter(|&&p| p > 1e-10)
        .map(|&p| p * p.ln())
        .sum::<f64>()
}

/// Compute expected information gain for a query.
/// gain = H(current) - E[H(posterior)]
#[napi]
pub fn expected_info_gain(
    current_probs: Vec<f64>,
    query_relevance: Vec<f64>, // How relevant the query is to each hypothesis
) -> f64 {
    let current_entropy = shannon_entropy(current_probs.clone());
    let n = current_probs.len().min(query_relevance.len());
    if n == 0 {
        return 0.0;
    }

    let sum: f64 = current_probs.iter().sum();
    let probs: Vec<f64> = if sum > 0.0 {
        current_probs.iter().map(|p| p / sum).collect()
    } else {
        return 0.0;
    };

    let mut expected_posterior_entropy = 0.0f64;
    for i in 0..n {
        let rel = query_relevance[i].clamp(0.0, 1.0);
        let p_evidence = probs[i] * rel + (1.0 - probs[i]) * (1.0 - rel);
        if p_evidence < 1e-10 {
            continue;
        }

        let mut posterior = probs.clone();
        posterior[i] *= 1.0 + rel;
        let post_sum: f64 = posterior.iter().sum();
        if post_sum > 0.0 {
            for p in &mut posterior {
                *p /= post_sum;
            }
        }

        let post_entropy = shannon_entropy(posterior);
        expected_posterior_entropy += p_evidence * post_entropy;
    }

    (current_entropy - expected_posterior_entropy).max(0.0)
}

/// Rank multiple queries by expected information gain.
#[napi]
pub fn rank_by_info_gain(
    current_probs: Vec<f64>,
    queries_relevance: Vec<Vec<f64>>,
) -> Vec<Vec<f64>> {
    let mut results: Vec<(usize, f64)> = queries_relevance
        .iter()
        .enumerate()
        .map(|(i, rel)| (i, expected_info_gain(current_probs.clone(), rel.clone())))
        .collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results.iter().map(|(i, g)| vec![*i as f64, *g]).collect()
}
