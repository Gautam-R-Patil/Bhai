// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Inner Thoughts Engine — Rust hot-path module
// Handles: thought scoring, novelty detection, trigger aggregation, suppression stats
// LLM calls stay in TypeScript; Rust handles the compute-intensive scoring/filtering.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

/// Weights for composite thought score
const W_RELEVANCE: f64 = 0.35;
const W_URGENCY: f64 = 0.25;
const W_NOVELTY: f64 = 0.25;
const W_APPROPRIATENESS: f64 = 0.15;

/// Minimum composite score to surface a thought
const SURFACE_THRESHOLD: f64 = 0.55;

/// Minimum composite score to queue a thought for later
const QUEUE_THRESHOLD: f64 = 0.35;

/// Cosine similarity threshold for considering a thought "novel"
const NOVELTY_SIM_THRESHOLD: f64 = 0.82;

/// Default cooldown between trigger firings of the same type (seconds)
const DEFAULT_TRIGGER_COOLDOWN_SECS: f64 = 1800.0; // 30 minutes

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ThoughtScores {
    pub relevance: f64,
    pub urgency: f64,
    pub novelty: f64,
    pub appropriateness: f64,
    pub composite: f64,
    pub decision: String, // "suppressed" | "queued" | "surfaced"
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TriggerSignal {
    pub source: String, // "monitor", "activity", "memory", "time", "emotional", "prospective"
    pub signal_type: String, // specific signal identifier
    pub weight: f64,    // 0-1 importance weight
    pub timestamp_ms: f64, // when the signal was detected
    pub metadata: String, // JSON-encoded extra context
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ActivationEvent {
    pub primary_trigger: String,
    pub combined_weight: f64,
    pub signals: Vec<TriggerSignal>,
    pub should_activate: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub composite_score: f64,
    pub decision: String,
    pub user_response: String, // "" for no response yet
    pub created_at_ms: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SuppressionStats {
    pub total_24h: u32,
    pub suppressed_24h: u32,
    pub surfaced_24h: u32,
    pub queued_24h: u32,
    pub suppression_rate: f64,
    pub avg_engaged_score: f64,
    pub avg_ignored_score: f64,
}

// ── Core Scoring ───────────────────────────────────

/// Score a thought candidate and determine the participation decision.
/// Returns composite score + decision ("suppressed" / "queued" / "surfaced").
///
/// The composite score is a weighted sum of 4 dimensions.
/// Decision thresholds adapt based on historical engagement data:
/// if the user ignores many surfaced thoughts, the surface threshold rises.
#[napi]
pub fn score_thought(
    relevance: f64,
    urgency: f64,
    novelty: f64,
    appropriateness: f64,
    adaptive_surface_threshold: Option<f64>,
    adaptive_queue_threshold: Option<f64>,
) -> ThoughtScores {
    let r = relevance.clamp(0.0, 1.0);
    let u = urgency.clamp(0.0, 1.0);
    let n = novelty.clamp(0.0, 1.0);
    let a = appropriateness.clamp(0.0, 1.0);

    let composite = W_RELEVANCE * r + W_URGENCY * u + W_NOVELTY * n + W_APPROPRIATENESS * a;

    let surf_thresh = adaptive_surface_threshold.unwrap_or(SURFACE_THRESHOLD);
    let queue_thresh = adaptive_queue_threshold.unwrap_or(QUEUE_THRESHOLD);

    let decision = if composite >= surf_thresh {
        "surfaced"
    } else if composite >= queue_thresh {
        "queued"
    } else {
        "suppressed"
    };

    ThoughtScores {
        relevance: r,
        urgency: u,
        novelty: n,
        appropriateness: a,
        composite,
        decision: decision.to_string(),
    }
}

/// Compute adaptive thresholds based on historical engagement.
/// If user frequently ignores surfaced thoughts, raise the bar.
/// If user engages even with lower-scored thoughts, lower it.
#[napi]
pub fn compute_adaptive_thresholds(entries: Vec<JournalEntry>) -> Vec<f64> {
    if entries.is_empty() {
        return vec![SURFACE_THRESHOLD, QUEUE_THRESHOLD];
    }

    let mut engaged_scores: Vec<f64> = Vec::new();
    let mut ignored_scores: Vec<f64> = Vec::new();

    for entry in &entries {
        if entry.decision == "surfaced" {
            if entry.user_response == "engaged" {
                engaged_scores.push(entry.composite_score);
            } else if entry.user_response == "ignored" || entry.user_response == "dismissed" {
                ignored_scores.push(entry.composite_score);
            }
        }
    }

    // Base threshold
    let mut surface_thresh = SURFACE_THRESHOLD;

    if !engaged_scores.is_empty() {
        let avg_engaged: f64 = engaged_scores.iter().sum::<f64>() / engaged_scores.len() as f64;
        // Lower threshold toward the average score of engaged thoughts (but not below 0.3)
        surface_thresh = (surface_thresh * 0.6 + avg_engaged * 0.4).max(0.3);
    }

    if !ignored_scores.is_empty() {
        let ignore_ratio =
            ignored_scores.len() as f64 / (engaged_scores.len() + ignored_scores.len()) as f64;
        // If >60% of surfaced thoughts are ignored, raise threshold
        if ignore_ratio > 0.6 {
            surface_thresh = (surface_thresh + 0.05).min(0.85);
        }
    }

    let queue_thresh = (surface_thresh - 0.2).max(0.2);

    vec![surface_thresh, queue_thresh]
}

// ── Novelty Detection ──────────────────────────────

/// Detect if a thought is novel compared to recent thoughts.
/// Uses SIMD-accelerated cosine similarity scanning.
/// Returns true if the thought is sufficiently novel (below similarity threshold).
#[napi]
pub fn detect_novelty(
    thought_embedding: Float32Array,
    recent_embeddings: Vec<Float32Array>,
    threshold: Option<f64>,
) -> bool {
    let thresh = threshold.unwrap_or(NOVELTY_SIM_THRESHOLD);
    let query = thought_embedding.as_ref();

    if recent_embeddings.is_empty() {
        return true; // No history = everything is novel
    }

    // Find max similarity to any recent thought
    let mut max_sim: f64 = -1.0;

    for recent in &recent_embeddings {
        let vec = recent.as_ref();
        if vec.len() != query.len() {
            continue;
        }
        let sim = cosine_sim_simd(query, vec);
        if sim > max_sim {
            max_sim = sim;
        }
    }

    // Novel if max similarity is below threshold
    max_sim < thresh
}

/// Compute novelty score (0 = duplicate, 1 = completely novel).
/// Inverse of max cosine similarity to recent thoughts.
#[napi]
pub fn compute_novelty_score(
    thought_embedding: Float32Array,
    recent_embeddings: Vec<Float32Array>,
) -> f64 {
    let query = thought_embedding.as_ref();

    if recent_embeddings.is_empty() {
        return 1.0;
    }

    let mut max_sim: f64 = -1.0;

    for recent in &recent_embeddings {
        let vec = recent.as_ref();
        if vec.len() != query.len() {
            continue;
        }
        let sim = cosine_sim_simd(query, vec);
        if sim > max_sim {
            max_sim = sim;
        }
    }

    // Convert similarity to novelty score
    (1.0 - max_sim.max(0.0)).clamp(0.0, 1.0)
}

// ── Trigger Aggregation ────────────────────────────

/// Aggregate multiple trigger signals into activation events.
/// Groups signals by source, applies cooldown filtering, and computes
/// combined weights to determine if the thought engine should activate.
///
/// Returns a list of activation events, sorted by combined weight descending.
#[napi]
pub fn aggregate_triggers(
    signals: Vec<TriggerSignal>,
    last_activation_times: Vec<f64>, // Parallel array: timestamp of last activation per source
    last_activation_sources: Vec<String>, // Parallel array: source names
    activation_threshold: Option<f64>,
) -> Vec<ActivationEvent> {
    let act_thresh = activation_threshold.unwrap_or(0.3);
    let now_ms = now_ms_f64();

    // Build cooldown map
    let mut cooldown_map: HashMap<String, f64> = HashMap::new();
    for (i, source) in last_activation_sources.iter().enumerate() {
        if i < last_activation_times.len() {
            cooldown_map.insert(source.clone(), last_activation_times[i]);
        }
    }

    // Group signals by source
    let mut groups: HashMap<String, Vec<TriggerSignal>> = HashMap::new();
    for signal in signals {
        // Check cooldown
        if let Some(&last_time) = cooldown_map.get(&signal.source) {
            let elapsed_secs = (now_ms - last_time) / 1000.0;
            if elapsed_secs < DEFAULT_TRIGGER_COOLDOWN_SECS {
                continue; // Still in cooldown
            }
        }

        groups
            .entry(signal.source.clone())
            .or_default()
            .push(signal);
    }

    // Compute activation events per source group
    let mut events: Vec<ActivationEvent> = Vec::new();

    for (source, signals) in groups {
        let combined_weight: f64 = signals.iter().map(|s| s.weight).sum::<f64>().min(1.0); // Cap at 1.0

        let should_activate = combined_weight >= act_thresh;

        events.push(ActivationEvent {
            primary_trigger: source,
            combined_weight,
            signals,
            should_activate,
        });
    }

    // Sort by combined weight descending
    events.sort_by(|a, b| {
        b.combined_weight
            .partial_cmp(&a.combined_weight)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    events
}

// ── Suppression Statistics ─────────────────────────

/// Compute suppression statistics from the thought journal.
/// Rolling 24-hour window analysis.
#[napi]
pub fn compute_suppression_stats(entries: Vec<JournalEntry>) -> SuppressionStats {
    let now_ms = now_ms_f64();
    let window_ms = 24.0 * 60.0 * 60.0 * 1000.0;

    let mut total = 0u32;
    let mut suppressed = 0u32;
    let mut surfaced = 0u32;
    let mut queued = 0u32;
    let mut engaged_sum = 0.0f64;
    let mut engaged_count = 0u32;
    let mut ignored_sum = 0.0f64;
    let mut ignored_count = 0u32;

    for entry in &entries {
        if now_ms - entry.created_at_ms > window_ms {
            continue; // Outside 24h window
        }

        total += 1;
        match entry.decision.as_str() {
            "suppressed" => suppressed += 1,
            "surfaced" => {
                surfaced += 1;
                match entry.user_response.as_str() {
                    "engaged" => {
                        engaged_sum += entry.composite_score;
                        engaged_count += 1;
                    }
                    "ignored" | "dismissed" => {
                        ignored_sum += entry.composite_score;
                        ignored_count += 1;
                    }
                    _ => {}
                }
            }
            "queued" => queued += 1,
            _ => {}
        }
    }

    let suppression_rate = if total > 0 {
        suppressed as f64 / total as f64
    } else {
        0.0
    };

    let avg_engaged = if engaged_count > 0 {
        engaged_sum / engaged_count as f64
    } else {
        0.0
    };

    let avg_ignored = if ignored_count > 0 {
        ignored_sum / ignored_count as f64
    } else {
        0.0
    };

    SuppressionStats {
        total_24h: total,
        suppressed_24h: suppressed,
        surfaced_24h: surfaced,
        queued_24h: queued,
        suppression_rate,
        avg_engaged_score: avg_engaged,
        avg_ignored_score: avg_ignored,
    }
}

// ── Thought Prioritization ─────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct QueuedThought {
    pub content: String,
    pub composite_score: f64,
    pub trigger_type: String,
    pub created_at_ms: f64,
}

/// Prioritize queued thoughts for surfacing during the next interaction.
/// Factors in: original score, time in queue (urgency boost), and trigger diversity.
/// Returns indices of the top-N thoughts to surface, sorted by priority.
#[napi]
pub fn prioritize_queued_thoughts(
    thoughts: Vec<QueuedThought>,
    max_to_surface: Option<u32>,
) -> Vec<u32> {
    let max_n = max_to_surface.unwrap_or(2) as usize;
    let now_ms = now_ms_f64();

    if thoughts.is_empty() {
        return vec![];
    }

    // Score each queued thought
    let mut scored: Vec<(usize, f64)> = thoughts
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let hours_in_queue = (now_ms - t.created_at_ms) / (1000.0 * 60.0 * 60.0);
            // Urgency boost: thoughts waiting longer get a boost (capped at +0.15)
            let time_boost = (hours_in_queue * 0.02).min(0.15);
            let priority = t.composite_score + time_boost;
            (i, priority)
        })
        .collect();

    // Sort by priority descending
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Ensure trigger type diversity: don't surface 2 thoughts of the same trigger
    let mut selected: Vec<u32> = Vec::new();
    let mut seen_triggers: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (idx, _score) in scored {
        if selected.len() >= max_n {
            break;
        }
        let trigger = &thoughts[idx].trigger_type;
        if seen_triggers.contains(trigger) && !selected.is_empty() {
            continue; // Allow first duplicate but not second
        }
        seen_triggers.insert(trigger.clone());
        selected.push(idx as u32);
    }

    selected
}

// ── SIMD Helpers ───────────────────────────────────

#[inline]
fn cosine_sim_simd(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    // Process 4 elements at a time (basic SIMD-friendly loop)
    let chunks = a.len() / 4;
    let remainder = a.len() % 4;

    for i in 0..chunks {
        let base = i * 4;
        let a0 = a[base] as f64;
        let a1 = a[base + 1] as f64;
        let a2 = a[base + 2] as f64;
        let a3 = a[base + 3] as f64;

        let b0 = b[base] as f64;
        let b1 = b[base + 1] as f64;
        let b2 = b[base + 2] as f64;
        let b3 = b[base + 3] as f64;

        dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
        norm_a += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
        norm_b += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
    }

    let base = chunks * 4;
    for i in 0..remainder {
        let av = a[base + i] as f64;
        let bv = b[base + i] as f64;
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }

    let denom = (norm_a * norm_b).sqrt();
    if denom < 1e-10 {
        return 0.0;
    }
    dot / denom
}

fn now_ms_f64() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
