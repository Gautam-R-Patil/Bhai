// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Source Credibility Model — Bayesian credibility tracking per domain/author.
// Updates credibility scores based on cross-referencing research results.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SourceCredibility {
    pub domain: String,
    pub credibility_score: f64,   // 0-1, Bayesian posterior
    pub total_citations: u32,     // Times this source was cited
    pub confirmed_claims: u32,    // Claims that were cross-verified
    pub contradicted_claims: u32, // Claims contradicted by other sources
    pub last_updated_ms: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CredibilityUpdate {
    pub domain: String,
    pub new_score: f64,
    pub delta: f64,
    pub reason: String,
}

// ── Bayesian Credibility Update ────────────────────

/// Update credibility for a source after cross-referencing.
/// Uses Beta-Binomial model: prior Beta(alpha, beta) + evidence → posterior.
#[napi]
pub fn update_credibility(
    current: SourceCredibility,
    claim_confirmed: bool,
    evidence_strength: f64,  // 0-1
) -> CredibilityUpdate {
    // Beta distribution parameters from current state
    let alpha = (current.confirmed_claims as f64) + 1.0;
    let beta_param = (current.contradicted_claims as f64) + 1.0;

    // Update based on evidence
    let (new_alpha, new_beta) = if claim_confirmed {
        (alpha + evidence_strength, beta_param)
    } else {
        (alpha, beta_param + evidence_strength)
    };

    // Posterior mean = alpha / (alpha + beta)
    let new_score = new_alpha / (new_alpha + new_beta);
    let delta = new_score - current.credibility_score;

    let reason = if claim_confirmed {
        format!("Claim confirmed (strength {:.2}), score {:.3} → {:.3}", evidence_strength, current.credibility_score, new_score)
    } else {
        format!("Claim contradicted (strength {:.2}), score {:.3} → {:.3}", evidence_strength, current.credibility_score, new_score)
    };

    CredibilityUpdate {
        domain: current.domain,
        new_score,
        delta,
        reason,
    }
}

/// Batch score multiple sources and return ranked by credibility.
#[napi]
pub fn rank_sources_by_credibility(sources: Vec<SourceCredibility>) -> Vec<SourceCredibility> {
    let mut sorted = sources;
    sorted.sort_by(|a, b| b.credibility_score.partial_cmp(&a.credibility_score)
        .unwrap_or(std::cmp::Ordering::Equal));
    sorted
}

/// Compute weighted credibility considering recency and citation count.
#[napi]
pub fn weighted_credibility(source: SourceCredibility, now_ms: f64) -> f64 {
    let age_hours = (now_ms - source.last_updated_ms) / 3_600_000.0;
    let recency_factor = (-0.001 * age_hours).exp(); // Slow decay
    let citation_factor = (source.total_citations as f64 / 10.0).min(1.0);

    source.credibility_score * 0.6 + recency_factor * 0.2 + citation_factor * 0.2
}
