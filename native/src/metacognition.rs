// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Metacognition Module — Rust hot-path for confidence scoring and struggle detection.
// Runs every agent iteration to assess reasoning quality and decide interventions.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

/// Confidence below this triggers intervention
const LOW_CONFIDENCE_THRESHOLD: f64 = 0.35;

/// Error ratio above this signals struggle
const HIGH_ERROR_RATIO: f64 = 0.4;

/// Minimum iterations before metacognitive assessment kicks in
const MIN_ITERATIONS_FOR_ASSESSMENT: u32 = 3;

/// Pattern matching window for loop detection
const LOOP_DETECTION_WINDOW: usize = 6;

/// Similarity threshold for considering two tool-call sequences a "loop"
const LOOP_SIMILARITY_THRESHOLD: f64 = 0.8;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MetaSignals {
    /// Current iteration number (0-based)
    pub iteration: u32,
    /// Total errors so far
    pub error_count: u32,
    /// Total tool calls so far
    pub tool_call_count: u32,
    /// Number of consecutive errors
    pub consecutive_errors: u32,
    /// Recent tool names called (last N)
    pub recent_tool_names: Vec<String>,
    /// Whether the model was already escalated this session
    pub already_escalated: bool,
    /// Last response length (tokens or chars) — high variance signals confusion
    pub last_response_length: u32,
    /// Rolling average response length
    pub avg_response_length: f64,
    /// Number of times the agent asked for clarification
    pub clarification_count: u32,
    /// Whether any tool returned empty/null
    pub empty_tool_results: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MetaAssessment {
    /// Overall confidence in current approach (0-1)
    pub confidence: f64,
    /// Is the agent going in circles?
    pub struggle_detected: bool,
    /// Repeating tool-call patterns detected?
    pub loop_detected: bool,
    /// Recommended intervention
    pub intervention: String, // "none" | "escalate" | "replan" | "critics" | "ask_user"
    /// Human-readable reasoning for the assessment
    pub reasoning: String,
}

// ── Core Assessment ────────────────────────────────

/// Compute metacognitive assessment from iteration signals.
/// This runs on every agent iteration (hot path).
#[napi]
pub fn compute_confidence(signals: MetaSignals) -> MetaAssessment {
    // Too early to assess
    if signals.iteration < MIN_ITERATIONS_FOR_ASSESSMENT {
        return MetaAssessment {
            confidence: 0.7,
            struggle_detected: false,
            loop_detected: false,
            intervention: "none".to_string(),
            reasoning: "Too early for metacognitive assessment".to_string(),
        };
    }

    let mut confidence = 1.0f64;
    let mut reasons: Vec<String> = Vec::new();

    // ── Factor 1: Error ratio ──
    let error_ratio = if signals.tool_call_count > 0 {
        signals.error_count as f64 / signals.tool_call_count as f64
    } else {
        0.0
    };
    if error_ratio > HIGH_ERROR_RATIO {
        confidence -= 0.3;
        reasons.push(format!(
            "High error ratio: {:.0}% of tool calls failed",
            error_ratio * 100.0
        ));
    } else if error_ratio > 0.2 {
        confidence -= 0.15;
    }

    // ── Factor 2: Consecutive errors ──
    if signals.consecutive_errors >= 3 {
        confidence -= 0.25;
        reasons.push(format!(
            "{} consecutive errors — likely stuck",
            signals.consecutive_errors
        ));
    } else if signals.consecutive_errors >= 2 {
        confidence -= 0.1;
    }

    // ── Factor 3: Response length variance (confusion signal) ──
    if signals.avg_response_length > 0.0 && signals.last_response_length > 0 {
        let variance = (signals.last_response_length as f64 - signals.avg_response_length).abs()
            / signals.avg_response_length;
        if variance > 1.5 {
            confidence -= 0.1;
            reasons.push("High response length variance".to_string());
        }
    }

    // ── Factor 4: Empty tool results (searching in the dark) ──
    if signals.empty_tool_results > 2 {
        confidence -= 0.15;
        reasons.push(format!(
            "{} empty tool results — may need different approach",
            signals.empty_tool_results
        ));
    }

    // ── Factor 5: Iteration count (diminishing returns) ──
    if signals.iteration > 15 {
        confidence -= 0.2;
        reasons.push(format!(
            "High iteration count ({}) — task may be too complex for current approach",
            signals.iteration
        ));
    } else if signals.iteration > 10 {
        confidence -= 0.1;
    }

    // ── Factor 6: Loop detection ──
    let loop_detected = detect_loop_pattern_internal(&signals.recent_tool_names);
    if loop_detected {
        confidence -= 0.25;
        reasons.push("Repeating tool-call pattern detected".to_string());
    }

    // ── Clamp confidence ──
    confidence = confidence.clamp(0.0, 1.0);

    // ── Determine intervention ──
    let struggle_detected = confidence < 0.5 || signals.consecutive_errors >= 3;

    let intervention = if confidence < 0.2 {
        if signals.already_escalated {
            "ask_user" // Already escalated and still failing
        } else {
            "critics" // Need multi-critic debate
        }
    } else if confidence < LOW_CONFIDENCE_THRESHOLD {
        if signals.already_escalated {
            "replan"
        } else {
            "escalate"
        }
    } else if loop_detected {
        "replan" // Break the loop with a new plan
    } else {
        "none"
    };

    let reasoning = if reasons.is_empty() {
        format!("Confidence {:.2} — proceeding normally", confidence)
    } else {
        format!("Confidence {:.2} — {}", confidence, reasons.join("; "))
    };

    MetaAssessment {
        confidence,
        struggle_detected,
        loop_detected,
        intervention: intervention.to_string(),
        reasoning,
    }
}

/// Detect repeating patterns in tool call sequences.
/// Looks for repeated subsequences of length 2-3 within the window.
#[napi]
pub fn detect_loop_pattern(recent_tool_names: Vec<String>) -> bool {
    detect_loop_pattern_internal(&recent_tool_names)
}

fn detect_loop_pattern_internal(tools: &[String]) -> bool {
    if tools.len() < LOOP_DETECTION_WINDOW {
        return false;
    }

    let window = &tools[tools.len().saturating_sub(LOOP_DETECTION_WINDOW)..];

    // Check for exact repetitions of length 2
    for pattern_len in 2..=3 {
        if window.len() < pattern_len * 2 {
            continue;
        }

        let pattern = &window[window.len() - pattern_len..];
        let mut repetitions = 0;
        let mut pos = window.len() - pattern_len;

        while pos >= pattern_len {
            pos -= pattern_len;
            let candidate = &window[pos..pos + pattern_len];
            if candidate == pattern {
                repetitions += 1;
            } else {
                break;
            }
        }

        if repetitions >= 2 {
            return true; // Pattern repeated 3+ times (original + 2 repetitions)
        }
    }

    false
}

/// Compute a meta-reasoning quality score for a completed task.
/// Used post-session to evaluate overall reasoning trajectory.
#[napi]
pub fn compute_reasoning_quality(
    total_iterations: u32,
    total_errors: u32,
    total_tool_calls: u32,
    escalations: u32,
    replans: u32,
    task_completed: bool,
) -> f64 {
    if total_iterations == 0 {
        return if task_completed { 0.8 } else { 0.2 };
    }

    let mut score = if task_completed { 0.6 } else { 0.1 };

    // Efficiency bonus: fewer iterations = better
    let efficiency = 1.0 - (total_iterations as f64 / 50.0).min(1.0);
    score += efficiency * 0.15;

    // Low error rate bonus
    let error_rate = total_errors as f64 / total_tool_calls.max(1) as f64;
    score += (1.0 - error_rate) * 0.15;

    // Penalties for escalations and replans (needed help)
    score -= escalations as f64 * 0.05;
    score -= replans as f64 * 0.03;

    score.clamp(0.0, 1.0)
}
