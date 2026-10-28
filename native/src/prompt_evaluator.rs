// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Prompt Evaluator — Rust hot-path for prompt quality scoring.
// Inspired by HyperAgent (Meta, ICLR 2026) self-modification loop.
// Scores prompts based on: task success correlation, response quality signals,
// token efficiency, and user satisfaction proxies.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

/// Minimum samples before a prompt variant is scored
const MIN_SAMPLES: u32 = 5;

/// Weight for each scoring dimension
const W_SUCCESS: f64 = 0.35;
const W_QUALITY: f64 = 0.25;
const W_EFFICIENCY: f64 = 0.20;
const W_SATISFACTION: f64 = 0.20;

/// Improvement threshold to adopt a new prompt variant
const ADOPTION_THRESHOLD: f64 = 0.05;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PromptVariant {
    pub id: String,
    pub segment_name: String, // Which prompt section this is for
    pub content_hash: String, // Hash of the prompt content
    pub success_count: u32,
    pub failure_count: u32,
    pub total_uses: u32,
    pub avg_quality_score: f64,     // 0-1 from evaluator
    pub avg_token_count: f64,       // Avg tokens used in responses
    pub avg_user_satisfaction: f64, // 0-1 proxy from engagement signals
    pub created_at_ms: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PromptScore {
    pub variant_id: String,
    pub composite_score: f64,
    pub success_rate: f64,
    pub quality_score: f64,
    pub efficiency_score: f64,
    pub satisfaction_score: f64,
    pub sample_size: u32,
    pub is_significant: bool, // Has enough samples
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EvolutionDecision {
    pub should_evolve: bool,
    pub current_best_id: String,
    pub challenger_id: String,
    pub improvement: f64, // How much better the challenger is
    pub reasoning: String,
}

// ── Scoring ────────────────────────────────────────

/// Score a prompt variant based on accumulated metrics.
#[napi]
pub fn score_prompt_variant(variant: PromptVariant) -> PromptScore {
    let is_significant = variant.total_uses >= MIN_SAMPLES;

    let success_rate = if variant.total_uses > 0 {
        variant.success_count as f64 / variant.total_uses as f64
    } else {
        0.5
    };

    // Token efficiency: lower is better, normalized inversely
    // Assume 500 tokens is "very efficient", 5000 is "very wasteful"
    let efficiency_score = (1.0 - (variant.avg_token_count - 500.0) / 4500.0).clamp(0.0, 1.0);

    let composite = W_SUCCESS * success_rate
        + W_QUALITY * variant.avg_quality_score
        + W_EFFICIENCY * efficiency_score
        + W_SATISFACTION * variant.avg_user_satisfaction;

    PromptScore {
        variant_id: variant.id,
        composite_score: composite.clamp(0.0, 1.0),
        success_rate,
        quality_score: variant.avg_quality_score,
        efficiency_score,
        satisfaction_score: variant.avg_user_satisfaction,
        sample_size: variant.total_uses,
        is_significant,
    }
}

/// Compare two prompt variants and decide whether to adopt the challenger.
#[napi]
pub fn compare_variants(current: PromptVariant, challenger: PromptVariant) -> EvolutionDecision {
    let current_score = score_prompt_variant(current.clone());
    let challenger_score = score_prompt_variant(challenger.clone());

    // Both must have significant sample sizes
    if !current_score.is_significant || !challenger_score.is_significant {
        return EvolutionDecision {
            should_evolve: false,
            current_best_id: current.id,
            challenger_id: challenger.id,
            improvement: 0.0,
            reasoning: format!(
                "Insufficient samples: current={}, challenger={}",
                current_score.sample_size, challenger_score.sample_size
            ),
        };
    }

    let improvement = challenger_score.composite_score - current_score.composite_score;

    if improvement > ADOPTION_THRESHOLD {
        EvolutionDecision {
            should_evolve: true,
            current_best_id: current.id,
            challenger_id: challenger.id.clone(),
            improvement,
            reasoning: format!(
                "Challenger ({:.3}) outperforms current ({:.3}) by {:.3} (>{:.3} threshold). Success: {:.0}%→{:.0}%, Quality: {:.2}→{:.2}",
                challenger_score.composite_score,
                current_score.composite_score,
                improvement,
                ADOPTION_THRESHOLD,
                current_score.success_rate * 100.0,
                challenger_score.success_rate * 100.0,
                current_score.quality_score,
                challenger_score.quality_score
            ),
        }
    } else {
        EvolutionDecision {
            should_evolve: false,
            current_best_id: current.id,
            challenger_id: challenger.id,
            improvement,
            reasoning: format!(
                "Challenger improvement {:.3} below threshold {:.3}",
                improvement, ADOPTION_THRESHOLD
            ),
        }
    }
}

/// Update a prompt variant's metrics after a task execution.
#[napi]
pub fn update_variant_metrics(
    mut variant: PromptVariant,
    task_succeeded: bool,
    quality_score: f64,
    token_count: u32,
    user_engaged: bool,
) {
    variant.total_uses += 1;
    if task_succeeded {
        variant.success_count += 1;
    } else {
        variant.failure_count += 1;
    }

    // Exponential moving average for continuous metrics
    let alpha = 1.0 / (variant.total_uses as f64).min(20.0);
    variant.avg_quality_score = variant.avg_quality_score * (1.0 - alpha) + quality_score * alpha;
    variant.avg_token_count = variant.avg_token_count * (1.0 - alpha) + token_count as f64 * alpha;

    let satisfaction = if user_engaged { 0.8 } else { 0.3 };
    variant.avg_user_satisfaction =
        variant.avg_user_satisfaction * (1.0 - alpha) + satisfaction * alpha;
}

/// Rank multiple prompt variants by composite score.
/// Returns variant IDs sorted best-to-worst.
#[napi]
pub fn rank_variants(variants: Vec<PromptVariant>) -> Vec<String> {
    let mut scored: Vec<(String, f64)> = variants
        .into_iter()
        .map(|v| {
            let id = v.id.clone();
            let score = score_prompt_variant(v);
            (id, score.composite_score)
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(id, _)| id).collect()
}
