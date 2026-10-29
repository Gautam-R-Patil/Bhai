// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Process Reward Model — Rust hot-path for step-level reward scoring.
// Inspired by ThinkPRM (2025), BiRM (A*-inspired), and Skywork-o1-Open-PRM.
// Handles: step reward aggregation, bidirectional scoring, threshold-based decisions.
// Actual LLM-based step verification stays in TypeScript.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

/// Default threshold for accepting a step as correct
const DEFAULT_STEP_THRESHOLD: f64 = 0.6;

/// Weight for backward (correctness) vs forward (success probability) in BiRM
const BIRM_BACKWARD_WEIGHT: f64 = 0.6;
const BIRM_FORWARD_WEIGHT: f64 = 0.4;

/// Discount factor for earlier steps (later steps matter more for final correctness)
const TEMPORAL_DISCOUNT: f64 = 0.95;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct StepReward {
    pub step_index: u32,
    pub step_description: String,
    pub correctness_score: f64, // Backward: is this step logically correct? (0-1)
    pub progress_score: f64,    // Forward: does this step advance toward the goal? (0-1)
    pub composite_score: f64,   // BiRM combined score
    pub is_accepted: bool,      // Above threshold?
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TrajectoryScore {
    pub step_scores: Vec<f64>,
    pub trajectory_reward: f64, // Aggregated reward for the entire trajectory
    pub min_step_score: f64,    // Weakest link
    pub bottleneck_step: u32,   // Index of the weakest step
    pub is_trajectory_valid: bool, // All steps above threshold?
    pub early_termination_step: i32, // -1 if no early termination needed
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct StepVerdict {
    pub should_continue: bool,
    pub should_backtrack: bool,
    pub should_escalate: bool,
    pub reasoning: String,
    pub confidence: f64,
}

// ── BiRM Bidirectional Scoring ─────────────────────

/// Compute BiRM-style bidirectional reward for a single step.
/// Combines backward correctness (is this step right?) with
/// forward progress (does this bring us closer to the goal?).
#[napi]
pub fn compute_birm_score(
    correctness: f64,
    progress: f64,
    backward_weight: Option<f64>,
    forward_weight: Option<f64>,
) -> f64 {
    let bw = backward_weight.unwrap_or(BIRM_BACKWARD_WEIGHT);
    let fw = forward_weight.unwrap_or(BIRM_FORWARD_WEIGHT);

    let c = correctness.clamp(0.0, 1.0);
    let p = progress.clamp(0.0, 1.0);

    (bw * c + fw * p).clamp(0.0, 1.0)
}

/// Score a full trajectory of steps using BiRM.
/// Returns per-step scores and aggregate trajectory reward.
#[napi]
pub fn score_trajectory(
    correctness_scores: Vec<f64>,
    progress_scores: Vec<f64>,
    step_threshold: Option<f64>,
) -> TrajectoryScore {
    let threshold = step_threshold.unwrap_or(DEFAULT_STEP_THRESHOLD);
    let n = correctness_scores.len().min(progress_scores.len());

    if n == 0 {
        return TrajectoryScore {
            step_scores: vec![],
            trajectory_reward: 0.0,
            min_step_score: 0.0,
            bottleneck_step: 0,
            is_trajectory_valid: false,
            early_termination_step: -1,
        };
    }

    let mut step_scores = Vec::with_capacity(n);
    let mut min_score = f64::INFINITY;
    let mut bottleneck = 0u32;
    let mut all_valid = true;
    let mut early_term: i32 = -1;
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;

    for i in 0..n {
        let score = compute_birm_score(correctness_scores[i], progress_scores[i], None, None);
        step_scores.push(score);

        // Temporal discounting: later steps weighted more
        let weight = TEMPORAL_DISCOUNT.powi((n - 1 - i) as i32);
        weighted_sum += score * weight;
        weight_total += weight;

        if score < min_score {
            min_score = score;
            bottleneck = i as u32;
        }

        if score < threshold {
            all_valid = false;
            if early_term < 0 {
                early_term = i as i32;
            }
        }
    }

    let trajectory_reward = if weight_total > 0.0 {
        weighted_sum / weight_total
    } else {
        0.0
    };

    TrajectoryScore {
        step_scores,
        trajectory_reward,
        min_step_score: if min_score == f64::INFINITY {
            0.0
        } else {
            min_score
        },
        bottleneck_step: bottleneck,
        is_trajectory_valid: all_valid,
        early_termination_step: early_term,
    }
}

// ── Step-Level Decision Making ─────────────────────

/// Given a step's BiRM score and context, decide what to do next.
/// Returns a verdict: continue, backtrack, or escalate.
#[napi]
pub fn step_verdict(
    step_score: f64,
    step_index: u32,
    total_steps_planned: u32,
    consecutive_low_scores: u32,
    already_backtracked: bool,
) -> StepVerdict {
    let threshold = DEFAULT_STEP_THRESHOLD;

    // High confidence — continue normally
    if step_score >= 0.8 {
        return StepVerdict {
            should_continue: true,
            should_backtrack: false,
            should_escalate: false,
            reasoning: format!("Step score {:.2} is high — proceeding", step_score),
            confidence: step_score,
        };
    }

    // Acceptable — continue with caution
    if step_score >= threshold {
        return StepVerdict {
            should_continue: true,
            should_backtrack: false,
            should_escalate: false,
            reasoning: format!("Step score {:.2} is acceptable", step_score),
            confidence: step_score,
        };
    }

    // Below threshold — consider backtracking
    if step_score < threshold && !already_backtracked {
        return StepVerdict {
            should_continue: false,
            should_backtrack: true,
            should_escalate: false,
            reasoning: format!(
                "Step score {:.2} below threshold {:.2} — backtrack and try alternative",
                step_score, threshold
            ),
            confidence: step_score,
        };
    }

    // Already backtracked and still low — escalate
    if consecutive_low_scores >= 3 || (already_backtracked && step_score < 0.3) {
        return StepVerdict {
            should_continue: false,
            should_backtrack: false,
            should_escalate: true,
            reasoning: format!(
                "Persistent low scores ({} consecutive, current {:.2}) — escalate to stronger model or ask user",
                consecutive_low_scores, step_score
            ),
            confidence: step_score,
        };
    }

    // Default: try to continue
    StepVerdict {
        should_continue: true,
        should_backtrack: false,
        should_escalate: false,
        reasoning: format!(
            "Step score {:.2} — marginal, continuing cautiously",
            step_score
        ),
        confidence: step_score,
    }
}

// ── Reward Aggregation ─────────────────────────────

/// Aggregate step rewards into a trajectory-level reward for MCTS backpropagation.
/// Multiple aggregation modes: min (conservative), mean, weighted-mean, product.
#[napi]
pub fn aggregate_rewards(scores: Vec<f64>, mode: String) -> f64 {
    if scores.is_empty() {
        return 0.0;
    }

    match mode.as_str() {
        "min" => scores
            .iter()
            .cloned()
            .fold(f64::INFINITY, f64::min)
            .max(0.0),
        "product" => scores.iter().product::<f64>().max(0.0),
        "weighted_mean" => {
            let n = scores.len();
            let mut sum = 0.0;
            let mut weight_total = 0.0;
            for (i, &s) in scores.iter().enumerate() {
                let w = TEMPORAL_DISCOUNT.powi((n - 1 - i) as i32);
                sum += s * w;
                weight_total += w;
            }
            if weight_total > 0.0 {
                sum / weight_total
            } else {
                0.0
            }
        }
        _ => {
            // "mean" (default)
            scores.iter().sum::<f64>() / scores.len() as f64
        }
    }
}

/// Compare two trajectories and return which is better.
/// Returns: 1 if first is better, -1 if second, 0 if equal.
#[napi]
pub fn compare_trajectories(scores_a: Vec<f64>, scores_b: Vec<f64>) -> i32 {
    let reward_a = aggregate_rewards(scores_a.clone(), "weighted_mean".to_string());
    let reward_b = aggregate_rewards(scores_b.clone(), "weighted_mean".to_string());

    // Also consider minimum step (weakest link)
    let min_a = scores_a.iter().cloned().fold(f64::INFINITY, f64::min);
    let min_b = scores_b.iter().cloned().fold(f64::INFINITY, f64::min);

    // Weighted comparison: 70% average reward, 30% min step
    let composite_a = 0.7 * reward_a + 0.3 * min_a;
    let composite_b = 0.7 * reward_b + 0.3 * min_b;

    if (composite_a - composite_b).abs() < 0.01 {
        0
    } else if composite_a > composite_b {
        1
    } else {
        -1
    }
}
