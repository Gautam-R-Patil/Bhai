// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// User Model — Rust hot-path for routine detection, communication style analysis,
// and need prediction scoring.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

/// Time bucket size in hours for routine detection
const TIME_BUCKET_HOURS: f64 = 4.0;

/// Minimum occurrences to consider a pattern a routine
const MIN_ROUTINE_FREQUENCY: u32 = 3;

/// Maximum standard deviation (in hours) for a routine to be considered consistent
const MAX_ROUTINE_STDDEV: f64 = 1.5;

/// Observation window for routine detection (days)
const ROUTINE_WINDOW_DAYS: f64 = 14.0;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct InteractionEvent {
    pub timestamp_ms: f64,
    pub hour_of_day: f64,       // 0-23.99
    pub day_of_week: u32,       // 0-6
    pub topic: String,          // main topic/category
    pub message_length: u32,    // characters
    pub had_emoji: bool,
    pub response_time_ms: f64,  // time user took to respond (-1 if N/A)
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct DetectedRoutine {
    pub time_bucket: String,    // e.g. "morning_6_10", "afternoon_14_18"
    pub day_pattern: String,    // "daily" | "weekdays" | "weekends" | specific days
    pub typical_topics: Vec<String>,
    pub frequency: u32,
    pub consistency: f64,       // 0-1 (low stddev = high consistency)
    pub confidence: f64,        // 0-1
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CommunicationStyle {
    pub avg_message_length: f64,
    pub preferred_length: String,   // "terse" | "normal" | "detailed"
    pub formality_score: f64,       // 0-1
    pub emoji_frequency: f64,       // 0-1
    pub avg_response_time_mins: f64,
    pub response_time_expectation: String, // "instant" | "quick" | "relaxed"
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PredictedNeed {
    pub need: String,
    pub confidence: f64,
    pub basis: String,          // What evidence supports this prediction
    pub time_window: String,    // When this need is likely to manifest
}

// ── Routine Detection ──────────────────────────────

/// Detect recurring interaction patterns from event history.
/// Groups events by time-of-day buckets and days, then identifies
/// consistent topic-time pairs.
#[napi]
pub fn detect_routines(events: Vec<InteractionEvent>) -> Vec<DetectedRoutine> {
    if events.is_empty() {
        return vec![];
    }

    // Group by time bucket
    let mut bucket_events: HashMap<String, Vec<&InteractionEvent>> = HashMap::new();
    for event in &events {
        let bucket = time_bucket_name(event.hour_of_day);
        bucket_events.entry(bucket).or_default().push(event);
    }

    let mut routines: Vec<DetectedRoutine> = Vec::new();

    for (bucket, events_in_bucket) in &bucket_events {
        // Group by topic within this bucket
        let mut topic_events: HashMap<String, Vec<&InteractionEvent>> = HashMap::new();
        for event in events_in_bucket {
            topic_events
                .entry(event.topic.clone())
                .or_default()
                .push(event);
        }

        for (topic, topic_events_list) in &topic_events {
            if (topic_events_list.len() as u32) < MIN_ROUTINE_FREQUENCY {
                continue;
            }

            // Compute time consistency (stddev of hours within bucket)
            let hours: Vec<f64> = topic_events_list.iter().map(|e| e.hour_of_day).collect();
            let mean_hour = hours.iter().sum::<f64>() / hours.len() as f64;
            let variance = hours.iter().map(|h| (h - mean_hour).powi(2)).sum::<f64>()
                / hours.len() as f64;
            let stddev = variance.sqrt();

            if stddev > MAX_ROUTINE_STDDEV {
                continue; // Too inconsistent
            }

            // Determine day pattern
            let days: Vec<u32> = topic_events_list.iter().map(|e| e.day_of_week).collect();
            let day_pattern = classify_day_pattern(&days);

            let consistency = (1.0 - stddev / MAX_ROUTINE_STDDEV).clamp(0.0, 1.0);
            let frequency = topic_events_list.len() as u32;
            let confidence = (frequency as f64 / 10.0).min(1.0) * consistency;

            routines.push(DetectedRoutine {
                time_bucket: bucket.clone(),
                day_pattern,
                typical_topics: vec![topic.clone()],
                frequency,
                consistency,
                confidence,
            });
        }
    }

    // Sort by confidence descending
    routines.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Merge routines with same bucket and day pattern
    let mut merged: Vec<DetectedRoutine> = Vec::new();
    for routine in routines {
        if let Some(existing) = merged.iter_mut().find(|r| {
            r.time_bucket == routine.time_bucket && r.day_pattern == routine.day_pattern
        }) {
            existing.typical_topics.extend(routine.typical_topics);
            existing.frequency += routine.frequency;
            existing.confidence = existing.confidence.max(routine.confidence);
        } else {
            merged.push(routine);
        }
    }

    merged.truncate(10); // Cap at 10 routines
    merged
}

fn time_bucket_name(hour: f64) -> String {
    if hour < 6.0 {
        "late_night_0_6".to_string()
    } else if hour < 10.0 {
        "morning_6_10".to_string()
    } else if hour < 14.0 {
        "midday_10_14".to_string()
    } else if hour < 18.0 {
        "afternoon_14_18".to_string()
    } else if hour < 22.0 {
        "evening_18_22".to_string()
    } else {
        "night_22_24".to_string()
    }
}

fn classify_day_pattern(days: &[u32]) -> String {
    let mut day_counts = [0u32; 7];
    for &d in days {
        if (d as usize) < 7 {
            day_counts[d as usize] += 1;
        }
    }

    let weekday_count: u32 = day_counts[1..6].iter().sum();
    let weekend_count: u32 = day_counts[0] + day_counts[6];
    let total = weekday_count + weekend_count;

    if total == 0 {
        return "unknown".to_string();
    }

    let weekday_ratio = weekday_count as f64 / total as f64;

    if weekday_ratio > 0.85 {
        "weekdays".to_string()
    } else if weekday_ratio < 0.25 {
        "weekends".to_string()
    } else {
        "daily".to_string()
    }
}

// ── Communication Style ────────────────────────────

/// Analyze user's communication style from interaction events.
#[napi]
pub fn analyze_communication_style(events: Vec<InteractionEvent>) -> CommunicationStyle {
    if events.is_empty() {
        return CommunicationStyle {
            avg_message_length: 100.0,
            preferred_length: "normal".to_string(),
            formality_score: 0.5,
            emoji_frequency: 0.0,
            avg_response_time_mins: 5.0,
            response_time_expectation: "quick".to_string(),
        };
    }

    let n = events.len() as f64;

    // Average message length
    let avg_len = events.iter().map(|e| e.message_length as f64).sum::<f64>() / n;
    let preferred_length = if avg_len < 50.0 {
        "terse"
    } else if avg_len < 200.0 {
        "normal"
    } else {
        "detailed"
    };

    // Emoji frequency
    let emoji_count = events.iter().filter(|e| e.had_emoji).count() as f64;
    let emoji_freq = emoji_count / n;

    // Formality: inverse of emoji usage + message length factor
    // Short messages with emojis = informal; long messages without = formal
    let formality = (1.0 - emoji_freq * 0.5 + (avg_len / 500.0).min(0.3)).clamp(0.0, 1.0);

    // Response time
    let response_times: Vec<f64> = events
        .iter()
        .filter(|e| e.response_time_ms > 0.0)
        .map(|e| e.response_time_ms / 60_000.0) // Convert to minutes
        .collect();
    let avg_response = if response_times.is_empty() {
        5.0
    } else {
        response_times.iter().sum::<f64>() / response_times.len() as f64
    };
    let expectation = if avg_response < 1.0 {
        "instant"
    } else if avg_response < 10.0 {
        "quick"
    } else {
        "relaxed"
    };

    CommunicationStyle {
        avg_message_length: avg_len,
        preferred_length: preferred_length.to_string(),
        formality_score: formality,
        emoji_frequency: emoji_freq,
        avg_response_time_mins: avg_response,
        response_time_expectation: expectation.to_string(),
    }
}

// ── Need Prediction ────────────────────────────────

/// Predict user's likely needs based on current time, routines, and recent activity.
/// Returns top-N predicted needs sorted by confidence.
#[napi]
pub fn predict_needs(
    current_hour: f64,
    current_day: u32,
    routines: Vec<DetectedRoutine>,
    recent_topics: Vec<String>,
    active_goal_titles: Vec<String>,
) -> Vec<PredictedNeed> {
    let mut predictions: Vec<PredictedNeed> = Vec::new();
    let current_bucket = time_bucket_name(current_hour);

    // Routine-based predictions: "At this time, user usually does X"
    for routine in &routines {
        if routine.time_bucket == current_bucket {
            let day_matches = match routine.day_pattern.as_str() {
                "daily" => true,
                "weekdays" => current_day >= 1 && current_day <= 5,
                "weekends" => current_day == 0 || current_day == 6,
                _ => true,
            };

            if day_matches && routine.confidence > 0.4 {
                for topic in &routine.typical_topics {
                    predictions.push(PredictedNeed {
                        need: format!("User typically engages with '{}' at this time", topic),
                        confidence: routine.confidence * 0.8,
                        basis: format!(
                            "Routine: {} {}, {}x occurrences, {:.0}% consistency",
                            routine.day_pattern,
                            routine.time_bucket,
                            routine.frequency,
                            routine.consistency * 100.0
                        ),
                        time_window: "now".to_string(),
                    });
                }
            }
        }
    }

    // Goal-based predictions: active goals suggest upcoming needs
    for goal in &active_goal_titles {
        predictions.push(PredictedNeed {
            need: format!("May want to work on goal: '{}'", goal),
            confidence: 0.4,
            basis: "Active goal".to_string(),
            time_window: "this_session".to_string(),
        });
    }

    // Sort by confidence descending
    predictions.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    predictions.truncate(5);
    predictions
}
