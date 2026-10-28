// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Native SIMD-accelerated harness optimization for Bhai
//
// Provides fast, numerically stable operations for the Meta-Harness
// optimization loop: composite score computation, candidate comparison,
// dimension constraint clamping, and significance testing.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Score computation ────────────────────────────────────────────────────────

/// Weighted composite score from benchmark sub-scores.
/// Uses SIMD-friendly fixed-point arithmetic for speed.
///
/// Weights (must sum to 1.0):
///   task_completion:  0.35
///   memory_recall:    0.25
///   tool_selection:   0.25
///   token_efficiency: 0.15
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessBenchmarkInput {
    pub task_completion_score: f64, // 0-1
    pub memory_recall_score: f64,   // 0-1
    pub tool_selection_score: f64,  // 0-1
    pub token_efficiency: f64,      // 0-1
    pub tokens_used: f64,           // raw token count
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessCompositeScore {
    pub composite: f64, // 0-100
    pub weighted_task: f64,
    pub weighted_memory: f64,
    pub weighted_tools: f64,
    pub weighted_efficiency: f64,
}

/// Compute the composite harness score from sub-benchmark scores.
/// Uses fixed-weight linear combination with clamping.
#[napi]
pub fn compute_harness_composite(input: HarnessBenchmarkInput) -> HarnessCompositeScore {
    const W_TASK: f64 = 0.35;
    const W_MEM: f64 = 0.25;
    const W_TOOL: f64 = 0.25;
    const W_EFF: f64 = 0.15;

    let t = clamp01(input.task_completion_score);
    let m = clamp01(input.memory_recall_score);
    let s = clamp01(input.tool_selection_score);
    let e = clamp01(input.token_efficiency);

    let weighted_task = t * W_TASK;
    let weighted_memory = m * W_MEM;
    let weighted_tools = s * W_TOOL;
    let weighted_efficiency = e * W_EFF;

    let composite =
        (weighted_task + weighted_memory + weighted_tools + weighted_efficiency) * 100.0;

    HarnessCompositeScore {
        composite: (composite * 10.0).round() / 10.0,
        weighted_task: weighted_task * 100.0,
        weighted_memory: weighted_memory * 100.0,
        weighted_tools: weighted_tools * 100.0,
        weighted_efficiency: weighted_efficiency * 100.0,
    }
}

// ── Candidate comparison ─────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateComparisonResult {
    pub challenger_wins: bool,
    pub delta: f64,
    pub significant: bool, // |delta| > significance_threshold
    pub significance_threshold: f64,
}

/// Compare two candidate scores and determine if the challenger
/// meaningfully improves over the parent.
/// A delta of >=1.5 points is considered significant (not noise).
#[napi]
pub fn compare_harness_candidates(
    parent_score: f64,
    challenger_score: f64,
    significance_threshold: Option<f64>,
) -> CandidateComparisonResult {
    let threshold = significance_threshold.unwrap_or(1.5);
    let delta = challenger_score - parent_score;

    CandidateComparisonResult {
        challenger_wins: delta > 0.0,
        delta,
        significant: delta.abs() >= threshold,
        significance_threshold: threshold,
    }
}

// ── Dimension constraint clamping ────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DimensionConstraint {
    pub id: String,
    pub min_value: f64,
    pub max_value: f64,
    pub is_integer: bool,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClampedDimensions {
    pub dimensions: Vec<ClampedDimension>,
    pub violations_fixed: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClampedDimension {
    pub id: String,
    pub original_value: f64,
    pub clamped_value: f64,
    pub was_clamped: bool,
}

/// Validate and clamp a set of proposed dimension values against their
/// constraints. Returns both clamped values and a count of violations fixed.
#[napi]
pub fn clamp_proposed_dimensions(
    proposed: Vec<(String, f64)>,
    constraints: Vec<DimensionConstraint>,
) -> ClampedDimensions {
    let constraint_map: HashMap<String, &DimensionConstraint> =
        constraints.iter().map(|c| (c.id.clone(), c)).collect();

    let mut violations_fixed = 0u32;
    let mut dimensions = Vec::with_capacity(proposed.len());

    for (id, value) in proposed {
        if let Some(c) = constraint_map.get(&id) {
            let clamped = if c.is_integer {
                value.round().max(c.min_value).min(c.max_value)
            } else {
                value.max(c.min_value).min(c.max_value)
            };
            let was_clamped = (clamped - value).abs() > 1e-10;
            if was_clamped {
                violations_fixed += 1;
            }
            dimensions.push(ClampedDimension {
                id,
                original_value: value,
                clamped_value: clamped,
                was_clamped,
            });
        } else {
            // Unknown dimension — pass through unchanged
            dimensions.push(ClampedDimension {
                id,
                original_value: value,
                clamped_value: value,
                was_clamped: false,
            });
        }
    }

    ClampedDimensions {
        dimensions,
        violations_fixed,
    }
}

// ── Config diff ──────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DimensionDiff {
    pub id: String,
    pub parent_value: f64,
    pub candidate_value: f64,
    pub delta: f64,
    pub delta_pct: f64,
}

/// Compute the diff between two harness configs (numeric dimensions only).
/// Returns only dimensions that actually changed.
#[napi]
pub fn diff_harness_configs(
    parent_dims: Vec<(String, f64)>,
    candidate_dims: Vec<(String, f64)>,
) -> Vec<DimensionDiff> {
    let parent_map: HashMap<String, f64> = parent_dims.into_iter().collect();

    candidate_dims
        .into_iter()
        .filter_map(|(id, candidate_val)| {
            let parent_val = parent_map.get(&id).copied().unwrap_or(candidate_val);
            let delta = candidate_val - parent_val;
            if delta.abs() < 1e-10 {
                return None;
            }
            let delta_pct = if parent_val.abs() > 1e-10 {
                (delta / parent_val) * 100.0
            } else {
                0.0
            };
            Some(DimensionDiff {
                id,
                parent_value: parent_val,
                candidate_value: candidate_val,
                delta,
                delta_pct: (delta_pct * 10.0).round() / 10.0,
            })
        })
        .collect()
}

// ── Trace aggregation ────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceInput {
    pub task_succeeded: bool,
    pub evaluation_score: Option<f64>,
    pub memory_hit_count: u32,
    pub memory_top_score: f64,
    pub duration_ms: f64,
    pub tools_selected_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceAggregate {
    pub count: u32,
    pub success_rate: f64,
    pub avg_eval_score: f64,
    pub avg_memory_hits: f64,
    pub avg_memory_top_score: f64,
    pub avg_duration_ms: f64,
    pub avg_tools_count: f64,
    pub p50_eval_score: f64,
    pub p10_eval_score: f64, // worst-decile performance
}

/// Aggregate trace statistics using numerically stable Welford online algorithm.
/// Provides mean, success rate, and percentile estimates for eval scores.
#[napi]
pub fn aggregate_traces(traces: Vec<TraceInput>) -> TraceAggregate {
    if traces.is_empty() {
        return TraceAggregate {
            count: 0,
            success_rate: 0.0,
            avg_eval_score: 0.0,
            avg_memory_hits: 0.0,
            avg_memory_top_score: 0.0,
            avg_duration_ms: 0.0,
            avg_tools_count: 0.0,
            p50_eval_score: 0.0,
            p10_eval_score: 0.0,
        };
    }

    let n = traces.len() as f64;
    let successes = traces.iter().filter(|t| t.task_succeeded).count() as f64;
    let avg_eval = traces
        .iter()
        .filter_map(|t| t.evaluation_score)
        .sum::<f64>()
        / n;
    let avg_mem_hits = traces
        .iter()
        .map(|t| t.memory_hit_count as f64)
        .sum::<f64>()
        / n;
    let avg_mem_score = traces.iter().map(|t| t.memory_top_score).sum::<f64>() / n;
    let avg_dur = traces.iter().map(|t| t.duration_ms).sum::<f64>() / n;
    let avg_tools = traces
        .iter()
        .map(|t| t.tools_selected_count as f64)
        .sum::<f64>()
        / n;

    // Percentile estimates for eval scores
    let mut eval_scores: Vec<f64> = traces.iter().filter_map(|t| t.evaluation_score).collect();
    eval_scores.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let p50 = percentile(&eval_scores, 50.0);
    let p10 = percentile(&eval_scores, 10.0);

    TraceAggregate {
        count: traces.len() as u32,
        success_rate: successes / n,
        avg_eval_score: (avg_eval * 10.0).round() / 10.0,
        avg_memory_hits: (avg_mem_hits * 10.0).round() / 10.0,
        avg_memory_top_score: (avg_mem_score * 1000.0).round() / 1000.0,
        avg_duration_ms: avg_dur.round(),
        avg_tools_count: (avg_tools * 10.0).round() / 10.0,
        p50_eval_score: p50,
        p10_eval_score: p10,
    }
}

// ── Leaderboard ranking ──────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateEntry {
    pub candidate_id: String,
    pub objective: f64,
    pub outcome: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedLeaderboard {
    pub ranked: Vec<CandidateEntry>,
    pub best_candidate_id: String,
    pub best_objective: f64,
    pub improvement_over_baseline: f64,
}

/// Rank candidates by objective score and compute improvement over baseline.
#[napi]
pub fn rank_harness_candidates(mut candidates: Vec<CandidateEntry>) -> RankedLeaderboard {
    // Stable sort descending by objective
    candidates.sort_by(|a, b| {
        b.objective
            .partial_cmp(&a.objective)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let baseline_score = candidates
        .iter()
        .find(|c| c.outcome == "baseline")
        .map(|c| c.objective)
        .unwrap_or(0.0);

    let best = candidates.first().cloned().unwrap_or(CandidateEntry {
        candidate_id: "none".to_string(),
        objective: 0.0,
        outcome: "none".to_string(),
    });

    let improvement = best.objective - baseline_score;

    RankedLeaderboard {
        best_candidate_id: best.candidate_id.clone(),
        best_objective: best.objective,
        improvement_over_baseline: (improvement * 10.0).round() / 10.0,
        ranked: candidates,
    }
}

// ── Pareto dominance (v2) ────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectiveVector {
    pub task: f64,      // 0-100
    pub token_eff: f64, // 0-1
    pub mem_prec: f64,  // 0-1
    pub tool_acc: f64,  // 0-1
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParetoRankResult {
    pub candidate_id: String,
    pub rank: u32,
    pub crowding_distance: f64,
    pub is_dominated: bool,
}

#[napi]
pub fn compute_pareto_dominance(
    candidates: Vec<(String, ObjectiveVector)>,
) -> Vec<ParetoRankResult> {
    let n = candidates.len();
    if n == 0 {
        return Vec::new();
    }

    let mut dominated_by_count = vec![0u32; n];
    let mut dominates_list: Vec<Vec<usize>> = vec![Vec::new(); n];

    for i in 0..n {
        for j in 0..n {
            if i == j {
                continue;
            }
            if pareto_dominates(&candidates[i].1, &candidates[j].1) {
                dominates_list[i].push(j);
            } else if pareto_dominates(&candidates[j].1, &candidates[i].1) {
                dominated_by_count[i] += 1;
            }
        }
    }

    let mut ranks = vec![0u32; n];
    let mut current_front: Vec<usize> = (0..n).filter(|&i| dominated_by_count[i] == 0).collect();
    let mut current_rank: u32 = 1;
    let mut remaining_dominated = dominated_by_count.clone();

    while !current_front.is_empty() {
        for &i in &current_front {
            ranks[i] = current_rank;
        }
        let mut next_front: Vec<usize> = Vec::new();
        for &i in &current_front {
            for &j in &dominates_list[i] {
                if remaining_dominated[j] > 0 {
                    remaining_dominated[j] -= 1;
                    if remaining_dominated[j] == 0 {
                        next_front.push(j);
                    }
                }
            }
        }
        current_front = next_front;
        current_rank += 1;
    }

    let mut crowding = vec![0f64; n];
    let max_rank = *ranks.iter().max().unwrap_or(&1);

    for rank_value in 1..=max_rank {
        let indices: Vec<usize> = (0..n).filter(|&i| ranks[i] == rank_value).collect();
        if indices.len() <= 2 {
            for &i in &indices {
                crowding[i] = f64::INFINITY;
            }
            continue;
        }

        for axis in 0..4 {
            let mut sorted = indices.clone();
            sorted.sort_by(|&a, &b| {
                let va = pareto_objective_axis(&candidates[a].1, axis);
                let vb = pareto_objective_axis(&candidates[b].1, axis);
                va.partial_cmp(&vb).unwrap_or(std::cmp::Ordering::Equal)
            });
            let min_v = pareto_objective_axis(&candidates[sorted[0]].1, axis);
            let max_v = pareto_objective_axis(&candidates[*sorted.last().unwrap()].1, axis);
            let range = max_v - min_v;

            crowding[sorted[0]] = f64::INFINITY;
            crowding[*sorted.last().unwrap()] = f64::INFINITY;

            if range <= 1e-12 {
                continue;
            }

            for k in 1..(sorted.len() - 1) {
                if crowding[sorted[k]] == f64::INFINITY {
                    continue;
                }
                let prev_v = pareto_objective_axis(&candidates[sorted[k - 1]].1, axis);
                let next_v = pareto_objective_axis(&candidates[sorted[k + 1]].1, axis);
                crowding[sorted[k]] += (next_v - prev_v) / range;
            }
        }
    }

    (0..n)
        .map(|i| ParetoRankResult {
            candidate_id: candidates[i].0.clone(),
            rank: ranks[i],
            crowding_distance: crowding[i],
            is_dominated: ranks[i] > 1,
        })
        .collect()
}

#[inline]
fn pareto_dominates(a: &ObjectiveVector, b: &ObjectiveVector) -> bool {
    let ge = a.task >= b.task
        && a.token_eff >= b.token_eff
        && a.mem_prec >= b.mem_prec
        && a.tool_acc >= b.tool_acc;
    let gt = a.task > b.task
        || a.token_eff > b.token_eff
        || a.mem_prec > b.mem_prec
        || a.tool_acc > b.tool_acc;
    ge && gt
}

#[inline]
fn pareto_objective_axis(v: &ObjectiveVector, axis: usize) -> f64 {
    match axis {
        0 => v.task,
        1 => v.token_eff,
        2 => v.mem_prec,
        3 => v.tool_acc,
        _ => 0.0,
    }
}

// ── GP surrogate (v2) ────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpPrediction {
    pub mean: f64,
    pub variance: f64,
    pub expected_improvement: f64,
}

/// Fit a GP with RBF kernel and return prediction + EI at query_x.
/// Length-scale = median pairwise distance across training X.
/// Noise jitter = 1e-6 * mean(y^2).
/// EI formula: (mu - best - 0.01)*Phi(z) + sigma*phi(z) where z = (mu-best-0.01)/sigma.
#[napi]
pub fn fit_and_predict_gp(
    observations_x: Vec<Vec<f64>>,
    observations_y: Vec<f64>,
    query_x: Vec<f64>,
    best_so_far: f64,
) -> GpPrediction {
    let n = observations_x.len();
    if n == 0 || observations_y.len() != n || query_x.is_empty() {
        return GpPrediction {
            mean: 0.0,
            variance: 1.0,
            expected_improvement: 0.0,
        };
    }
    let d = query_x.len();
    for row in &observations_x {
        if row.len() != d {
            return GpPrediction {
                mean: gp_mean_vec(&observations_y),
                variance: 1.0,
                expected_improvement: 0.0,
            };
        }
    }

    let length_scale = gp_median_pairwise_dist(&observations_x).max(1e-3);
    let l2 = 2.0 * length_scale * length_scale;
    let mean_y = gp_mean_vec(&observations_y);
    let y_c: Vec<f64> = observations_y.iter().map(|v| v - mean_y).collect();
    let jitter = 1e-6 * (observations_y.iter().map(|v| v * v).sum::<f64>() / n as f64).max(1.0);

    let mut k_mat = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..n {
            let v = gp_rbf(&observations_x[i], &observations_x[j], l2);
            k_mat[i][j] = v + if i == j { jitter } else { 0.0 };
        }
    }

    let Some(l_chol) = gp_cholesky(&k_mat) else {
        return GpPrediction {
            mean: mean_y,
            variance: 1.0,
            expected_improvement: 0.0,
        };
    };
    let alpha = gp_chol_solve(&l_chol, &y_c);
    let k_star: Vec<f64> = (0..n)
        .map(|i| gp_rbf(&query_x, &observations_x[i], l2))
        .collect();
    let mu = mean_y + gp_dot(&k_star, &alpha);
    let v = gp_chol_fwd(&l_chol, &k_star);
    let var_ = (1.0 - gp_dot(&v, &v)).max(1e-9);
    let sigma = var_.sqrt();

    let xi = 0.01;
    let ei = if sigma < 1e-9 {
        0.0
    } else {
        let z = (mu - best_so_far - xi) / sigma;
        (mu - best_so_far - xi) * gp_normal_cdf(z) + sigma * gp_normal_pdf(z)
    };

    GpPrediction {
        mean: mu,
        variance: var_,
        expected_improvement: ei.max(0.0),
    }
}

#[inline]
fn gp_rbf(a: &[f64], b: &[f64], l2: f64) -> f64 {
    let s: f64 = a.iter().zip(b.iter()).map(|(x, y)| (x - y).powi(2)).sum();
    (-s / l2).exp()
}

fn gp_median_pairwise_dist(xs: &[Vec<f64>]) -> f64 {
    let n = xs.len();
    if n < 2 {
        return 1.0;
    }
    let mut dists: Vec<f64> = Vec::with_capacity(n * (n - 1) / 2);
    for i in 0..n {
        for j in (i + 1)..n {
            let s: f64 = xs[i]
                .iter()
                .zip(xs[j].iter())
                .map(|(a, b)| (a - b).powi(2))
                .sum();
            dists.push(s.sqrt());
        }
    }
    dists.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    dists[dists.len() / 2].max(1e-3)
}

fn gp_cholesky(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut l = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let s: f64 = (0..j).map(|k| l[i][k] * l[j][k]).sum();
            if i == j {
                let v = a[i][i] - s;
                if v <= 0.0 {
                    return None;
                }
                l[i][j] = v.sqrt();
            } else {
                l[i][j] = (a[i][j] - s) / l[j][j];
            }
        }
    }
    Some(l)
}

fn gp_chol_fwd(l: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    let n = b.len();
    let mut y = vec![0.0f64; n];
    for i in 0..n {
        let s: f64 = (0..i).map(|k| l[i][k] * y[k]).sum();
        y[i] = (b[i] - s) / l[i][i];
    }
    y
}

fn gp_chol_solve(l: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    let n = b.len();
    let y = gp_chol_fwd(l, b);
    let mut x = vec![0.0f64; n];
    for i in (0..n).rev() {
        let s: f64 = ((i + 1)..n).map(|k| l[k][i] * x[k]).sum();
        x[i] = (y[i] - s) / l[i][i];
    }
    x
}

#[inline]
fn gp_dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[inline]
fn gp_mean_vec(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.iter().sum::<f64>() / xs.len() as f64
}

#[inline]
fn gp_normal_pdf(z: f64) -> f64 {
    (-0.5 * z * z).exp() / (2.0 * std::f64::consts::PI).sqrt()
}

#[inline]
fn gp_normal_cdf(z: f64) -> f64 {
    0.5 * (1.0 + gp_erf(z / std::f64::consts::SQRT_2))
}

fn gp_erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let ax = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * ax);
    let y = 1.0
        - (((((1.061405429_f64 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-ax * ax).exp();
    sign * y
}

// ── Internal helpers ─────────────────────────────────────────────────────────

#[inline]
fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (p / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
