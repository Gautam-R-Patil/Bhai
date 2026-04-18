// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pattern Speculator — PASTE-inspired speculative tool execution.
// Learns recurring tool-call patterns and pre-executes likely next calls.
// 48.5% latency reduction in the PASTE paper.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

/// Minimum occurrences of a pattern before we speculate on it
const MIN_PATTERN_COUNT: u32 = 3;

/// Maximum sequence length for pattern matching
const MAX_PATTERN_LENGTH: usize = 4;

/// Confidence threshold for executing speculation
const SPECULATION_THRESHOLD: f64 = 0.7;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ToolCallPattern {
    pub sequence: Vec<String>,     // e.g., ["web_search", "read_url", "summarize"]
    pub next_tool: String,         // Predicted next tool after this sequence
    pub count: u32,                // How many times this pattern was observed
    pub success_rate: f64,         // How often the predicted next tool succeeded
    pub avg_data_dependency: f64,  // 0=independent, 1=fully dependent on previous output
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SpeculationDecision {
    pub should_speculate: bool,
    pub predicted_tool: String,
    pub confidence: f64,
    pub pattern_sequence: Vec<String>,
    pub is_safe: bool,             // True if the tool is read-only / side-effect-free
    pub needs_previous_output: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PatternDatabase {
    pub patterns: Vec<ToolCallPattern>,
    pub total_sequences_observed: u32,
}

// ── Pattern Learning ───────────────────────────────

/// Record a tool call sequence and update the pattern database.
/// Called after each tool execution with the recent tool call history.
#[napi]
pub fn record_tool_sequence(
    mut db: PatternDatabase,
    recent_tools: Vec<String>,
    next_tool: String,
    next_tool_succeeded: bool,
) {
    db.total_sequences_observed += 1;

    // Extract sub-sequences of various lengths
    for len in 1..=MAX_PATTERN_LENGTH.min(recent_tools.len()) {
        let start = recent_tools.len() - len;
        let sequence: Vec<String> = recent_tools[start..].to_vec();

        // Find or create pattern
        if let Some(pattern) = db.patterns.iter_mut().find(|p| {
            p.sequence == sequence && p.next_tool == next_tool
        }) {
            pattern.count += 1;
            // Update success rate with exponential moving average
            let alpha = 0.1;
            let success_val = if next_tool_succeeded { 1.0 } else { 0.0 };
            pattern.success_rate = pattern.success_rate * (1.0 - alpha) + success_val * alpha;
        } else {
            db.patterns.push(ToolCallPattern {
                sequence,
                next_tool: next_tool.clone(),
                count: 1,
                success_rate: if next_tool_succeeded { 1.0 } else { 0.0 },
                avg_data_dependency: 0.5, // Default: moderate dependency
            });
        }
    }

    // Prune patterns with very low counts (cleanup)
    if db.patterns.len() > 1000 {
        db.patterns.retain(|p| p.count >= 2 || db.total_sequences_observed < 100);
    }
}

/// Create an empty pattern database.
#[napi]
pub fn create_pattern_db() -> PatternDatabase {
    PatternDatabase {
        patterns: vec![],
        total_sequences_observed: 0,
    }
}

// ── Speculation Decision ───────────────────────────

/// Decide whether to speculatively execute the next tool call.
/// Looks at recent tool history, finds matching patterns, and predicts next tool.
#[napi]
pub fn should_speculate(
    db: PatternDatabase,
    recent_tools: Vec<String>,
    safe_tools: Vec<String>,       // Tools that are read-only / safe to speculate
) -> SpeculationDecision {
    if recent_tools.is_empty() || db.patterns.is_empty() {
        return empty_decision();
    }

    let safe_set: std::collections::HashSet<&str> = safe_tools.iter().map(|s| s.as_str()).collect();

    // Find the best matching pattern (longest match preferred)
    let mut best_match: Option<&ToolCallPattern> = None;
    let mut best_confidence = 0.0f64;

    for len in (1..=MAX_PATTERN_LENGTH.min(recent_tools.len())).rev() {
        let start = recent_tools.len() - len;
        let sequence: Vec<&str> = recent_tools[start..].iter().map(|s| s.as_str()).collect();

        for pattern in &db.patterns {
            if pattern.count < MIN_PATTERN_COUNT {
                continue;
            }

            let pattern_seq: Vec<&str> = pattern.sequence.iter().map(|s| s.as_str()).collect();
            if pattern_seq == sequence {
                // Confidence = count-based + success rate + length bonus
                let count_factor = (pattern.count as f64 / 10.0).min(1.0);
                let length_bonus = len as f64 * 0.1;
                let confidence = (count_factor * 0.4 + pattern.success_rate * 0.4 + length_bonus * 0.2)
                    .clamp(0.0, 1.0);

                if confidence > best_confidence {
                    best_confidence = confidence;
                    best_match = Some(pattern);
                }
            }
        }
    }

    match best_match {
        Some(pattern) if best_confidence >= SPECULATION_THRESHOLD => {
            let is_safe = safe_set.contains(pattern.next_tool.as_str());
            let needs_output = pattern.avg_data_dependency > 0.5;

            SpeculationDecision {
                should_speculate: is_safe || (!needs_output && best_confidence > 0.85),
                predicted_tool: pattern.next_tool.clone(),
                confidence: best_confidence,
                pattern_sequence: pattern.sequence.clone(),
                is_safe,
                needs_previous_output: needs_output,
            }
        }
        _ => empty_decision(),
    }
}

fn empty_decision() -> SpeculationDecision {
    SpeculationDecision {
        should_speculate: false,
        predicted_tool: String::new(),
        confidence: 0.0,
        pattern_sequence: vec![],
        is_safe: false,
        needs_previous_output: false,
    }
}

/// Update data dependency estimation for a pattern.
/// Called after speculation succeeds/fails to learn whether next tool
/// actually needed the previous tool's output.
#[napi]
pub fn update_dependency(
    mut db: PatternDatabase,
    sequence: Vec<String>,
    next_tool: String,
    was_dependent: bool,
) {
    if let Some(pattern) = db.patterns.iter_mut().find(|p| {
        p.sequence == sequence && p.next_tool == next_tool
    }) {
        let alpha = 0.15;
        let dep_val = if was_dependent { 1.0 } else { 0.0 };
        pattern.avg_data_dependency = pattern.avg_data_dependency * (1.0 - alpha) + dep_val * alpha;
    }
}

/// Get the top-N most common patterns for debugging/visualization.
#[napi]
pub fn get_top_patterns(db: PatternDatabase, n: u32) -> Vec<ToolCallPattern> {
    let mut sorted = db.patterns.clone();
    sorted.sort_by(|a, b| b.count.cmp(&a.count));
    sorted.truncate(n as usize);
    sorted
}
