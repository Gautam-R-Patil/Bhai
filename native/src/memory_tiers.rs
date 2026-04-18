// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Tiered Memory Architecture — Full port of src/memory/memory-tiers.ts

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

const W_TIME: f64 = 0.30;
const W_ACCESS: f64 = 0.25;
const W_IMPORTANCE: f64 = 0.25;
const W_EMOTION: f64 = 0.20;

const LAMBDA: f64 = 0.01; // Decay rate (69-day half-life)

const HOT_THRESHOLD: f64 = 0.6;
const WARM_THRESHOLD: f64 = 0.25;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TierableMemory {
    pub id: i64,
    pub importance: f64,
    pub decay_score: f64,
    pub access_count: i64,
    pub created_at_ms: f64,      // milliseconds since epoch
    pub last_accessed_ms: f64,   // milliseconds since epoch (0 if never)
    pub emotional_intensity: f64, // 0 if not set
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TierAssignment {
    pub id: i64,
    pub tier: String,
    pub score: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TierCounts {
    pub hot: u32,
    pub warm: u32,
    pub cold: u32,
}

// ── Tier Scoring ───────────────────────────────────

/// Compute Adaptive Tier Score for a memory.
#[napi]
pub fn compute_tier_score(
    importance: f64,
    access_count: i64,
    created_at_ms: f64,
    last_accessed_ms: f64,
    max_access_count: i64,
    avg_emotional_intensity: f64,
    emotional_intensity: f64,
) -> f64 {
    let now = now_ms();

    // Time decay (exponential, based on last access or creation)
    let last_access_time = if last_accessed_ms > 0.0 {
        last_accessed_ms
    } else {
        created_at_ms
    };
    let days_since_access = (now - last_access_time) / (1000.0 * 60.0 * 60.0 * 24.0);
    let time_decay = (-LAMBDA * days_since_access).exp();

    // Access frequency (log-normalized)
    let access_freq = if max_access_count > 0 {
        (1.0 + access_count as f64).log2() / (1.0 + max_access_count as f64).log2()
    } else {
        0.0
    };

    // Importance (0-10 scale, normalize to 0-1)
    let imp = (importance / 10.0).min(1.0);

    // Emotional weight
    let emo_val = if emotional_intensity > 0.0 {
        emotional_intensity
    } else {
        avg_emotional_intensity
    };
    let emotional_weight = 1.0 + 0.3 * emo_val;

    W_TIME * time_decay + W_ACCESS * access_freq + W_IMPORTANCE * imp + W_EMOTION * emotional_weight
}

/// Determine tier from score.
#[napi]
pub fn score_to_tier(score: f64) -> String {
    if score > HOT_THRESHOLD {
        "hot".to_string()
    } else if score > WARM_THRESHOLD {
        "warm".to_string()
    } else {
        "cold".to_string()
    }
}

/// Batch compute tier assignments for all memories.
/// Returns a list of TierAssignment with id, tier, and score.
#[napi]
pub fn batch_assign_tiers(memories: Vec<TierableMemory>) -> Vec<TierAssignment> {
    if memories.is_empty() {
        return Vec::new();
    }

    let max_access_count = memories.iter().map(|m| m.access_count).max().unwrap_or(0);

    memories
        .iter()
        .map(|m| {
            let score = compute_tier_score(
                m.importance,
                m.access_count,
                m.created_at_ms,
                m.last_accessed_ms,
                max_access_count,
                0.0,
                m.emotional_intensity,
            );
            let tier = score_to_tier(score);
            TierAssignment {
                id: m.id,
                tier,
                score,
            }
        })
        .collect()
}

/// Count tiers from assignments
#[napi]
pub fn count_tiers(assignments: Vec<TierAssignment>) -> TierCounts {
    let mut counts = TierCounts {
        hot: 0,
        warm: 0,
        cold: 0,
    };

    for a in &assignments {
        match a.tier.as_str() {
            "hot" => counts.hot += 1,
            "warm" => counts.warm += 1,
            "cold" => counts.cold += 1,
            _ => counts.cold += 1,
        }
    }

    counts
}

/// Get which tiers to search based on query classification.
#[napi]
pub fn get_search_tiers(query_mode: String) -> Vec<String> {
    match query_mode.as_str() {
        "retrieve" => vec![
            "hot".to_string(),
            "warm".to_string(),
            "cold".to_string(),
        ],
        "llm_with_traits" => vec!["hot".to_string(), "warm".to_string()],
        "llm_only" => vec!["hot".to_string()],
        _ => vec!["hot".to_string(), "warm".to_string()],
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
