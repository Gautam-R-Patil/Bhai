// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Working Memory — Rust hot-path for attention-weighted buffer management.
// Implements explicit working memory separation from LTM.
// Handles: attention scoring, capacity management, spill-to-LTM decisions.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

/// Maximum items in working memory buffer
const DEFAULT_WM_CAPACITY: usize = 20;

/// Attention decay rate per tick (items lose relevance over time)
const ATTENTION_DECAY: f64 = 0.05;

/// Minimum attention score to keep in working memory
const SPILL_THRESHOLD: f64 = 0.15;

/// Boost for items that were recently accessed
const ACCESS_BOOST: f64 = 0.3;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct WMItem {
    pub id: String,
    pub content_type: String,      // "fact" | "task_context" | "tool_result" | "user_message" | "agent_thought"
    pub summary: String,           // Brief content for injection
    pub attention_score: f64,      // 0-1, how relevant right now
    pub importance: f64,           // 0-1, intrinsic importance
    pub access_count: u32,
    pub created_tick: u32,
    pub last_accessed_tick: u32,
    pub token_estimate: u32,       // Estimated tokens this item consumes
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct WMState {
    pub items: Vec<WMItem>,
    pub current_tick: u32,
    pub total_tokens: u32,
    pub capacity: u32,
    pub token_budget: u32,         // Max tokens for WM injection
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SpillDecision {
    pub items_to_spill: Vec<String>,  // IDs of items to move to LTM
    pub items_to_keep: Vec<String>,   // IDs of items to keep
    pub freed_tokens: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct RetainDecision {
    pub should_retain: bool,
    pub attention_score: f64,
    pub replaces_id: String,        // Empty if no replacement needed
}

// ── Working Memory Operations ──────────────────────

/// Create initial working memory state.
#[napi]
pub fn create_wm_state(capacity: Option<u32>, token_budget: Option<u32>) -> WMState {
    WMState {
        items: vec![],
        current_tick: 0,
        total_tokens: 0,
        capacity: capacity.unwrap_or(DEFAULT_WM_CAPACITY as u32),
        token_budget: token_budget.unwrap_or(3000),
    }
}

/// Compute attention scores for all items based on current context.
/// Context embedding is compared against each item; items relevant to
/// current task get higher attention.
#[napi]
pub fn update_attention_scores(
    mut state: WMState,
    relevance_scores: Vec<f64>,  // Parallel to state.items: relevance to current query
) -> Vec<f64> {
    state.current_tick += 1;
    let tick = state.current_tick;

    let mut updated_scores = Vec::with_capacity(state.items.len());

    for (i, item) in state.items.iter_mut().enumerate() {
        // Time-based decay
        let ticks_since_access = (tick - item.last_accessed_tick) as f64;
        let decay = (-ATTENTION_DECAY * ticks_since_access).exp();

        // Relevance boost from current context
        let relevance = relevance_scores.get(i).copied().unwrap_or(0.0);

        // New attention = decayed old attention + relevance + importance baseline
        let new_attention = (item.attention_score * decay + relevance * 0.5 + item.importance * 0.1)
            .clamp(0.0, 1.0);

        item.attention_score = new_attention;
        updated_scores.push(new_attention);
    }

    updated_scores
}

/// Decide whether to retain a new item in working memory.
/// If WM is full, identifies the lowest-attention item for replacement.
#[napi]
pub fn should_retain(state: WMState, new_item_importance: f64, new_item_tokens: u32) -> RetainDecision {
    // If there's room, always retain
    if (state.items.len() as u32) < state.capacity
        && state.total_tokens + new_item_tokens <= state.token_budget
    {
        return RetainDecision {
            should_retain: true,
            attention_score: new_item_importance.max(0.5), // New items start with decent attention
            replaces_id: String::new(),
        };
    }

    // Find the item with lowest attention
    let mut min_attention = f64::INFINITY;
    let mut min_id = String::new();

    for item in &state.items {
        if item.attention_score < min_attention {
            min_attention = item.attention_score;
            min_id = item.id.clone();
        }
    }

    // Replace if new item is more important than the weakest existing item
    if new_item_importance > min_attention + 0.1 {
        RetainDecision {
            should_retain: true,
            attention_score: new_item_importance.max(0.5),
            replaces_id: min_id,
        }
    } else {
        RetainDecision {
            should_retain: false,
            attention_score: new_item_importance,
            replaces_id: String::new(),
        }
    }
}

/// Decide which items to spill from WM to LTM.
/// Called when WM is over capacity or token budget.
#[napi]
pub fn compute_spill_decisions(state: WMState) -> SpillDecision {
    let mut items_with_scores: Vec<(&WMItem, f64)> = state.items.iter()
        .map(|item| {
            // Combined score: attention + importance + recency
            let recency = 1.0 / (1.0 + (state.current_tick - item.last_accessed_tick) as f64 * 0.1);
            let combined = item.attention_score * 0.5 + item.importance * 0.3 + recency * 0.2;
            (item, combined)
        })
        .collect();

    // Sort by score ascending (lowest scores spill first)
    items_with_scores.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut to_spill = Vec::new();
    let mut to_keep = Vec::new();
    let mut freed_tokens = 0u32;
    let mut kept_tokens = 0u32;

    for (item, score) in &items_with_scores {
        let needs_spill = score < &SPILL_THRESHOLD
            || to_keep.len() >= state.capacity as usize
            || kept_tokens + item.token_estimate > state.token_budget;

        if needs_spill {
            to_spill.push(item.id.clone());
            freed_tokens += item.token_estimate;
        } else {
            to_keep.push(item.id.clone());
            kept_tokens += item.token_estimate;
        }
    }

    SpillDecision {
        items_to_spill: to_spill,
        items_to_keep: to_keep,
        freed_tokens,
    }
}

/// Select top-K items from working memory for injection into the prompt.
/// Ranked by attention score, respecting token budget.
#[napi]
pub fn select_for_injection(state: WMState, max_tokens: u32) -> Vec<String> {
    let mut sorted: Vec<&WMItem> = state.items.iter().collect();
    sorted.sort_by(|a, b| b.attention_score.partial_cmp(&a.attention_score).unwrap_or(std::cmp::Ordering::Equal));

    let mut selected = Vec::new();
    let mut token_count = 0u32;

    for item in sorted {
        if token_count + item.token_estimate > max_tokens {
            continue; // Skip items that don't fit
        }
        selected.push(item.id.clone());
        token_count += item.token_estimate;
    }

    selected
}

/// Record an access to a WM item (boosts its attention score).
#[napi]
pub fn record_access(mut state: WMState, item_id: String) {
    if let Some(item) = state.items.iter_mut().find(|i| i.id == item_id) {
        item.access_count += 1;
        item.last_accessed_tick = state.current_tick;
        item.attention_score = (item.attention_score + ACCESS_BOOST).min(1.0);
    }
}
