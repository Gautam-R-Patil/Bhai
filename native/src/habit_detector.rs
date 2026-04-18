// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Habit Detector — Time-series pattern detection for user behavioral habits.
// Detects recurring temporal patterns for proactive automation.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TimestampedEvent {
    pub timestamp_ms: f64,
    pub event_type: String,
    pub hour_of_day: f64,
    pub day_of_week: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct DetectedHabit {
    pub event_type: String,
    pub pattern: String,        // "daily_morning" | "weekday_evening" | "weekly_monday" etc
    pub typical_hour: f64,
    pub typical_day: Option<u32>,
    pub frequency: u32,
    pub consistency: f64,       // 0-1 (low stddev = high consistency)
    pub confidence: f64,
    pub next_expected_ms: f64,  // Predicted next occurrence
}

// ── Habit Detection ────────────────────────────────

/// Detect recurring behavioral patterns from timestamped events.
#[napi]
pub fn detect_habits(events: Vec<TimestampedEvent>, min_frequency: u32) -> Vec<DetectedHabit> {
    let min_freq = min_frequency.max(3);
    let mut habits = Vec::new();

    // Group events by type
    let mut by_type: HashMap<String, Vec<&TimestampedEvent>> = HashMap::new();
    for event in &events {
        by_type.entry(event.event_type.clone()).or_default().push(event);
    }

    for (event_type, type_events) in &by_type {
        if (type_events.len() as u32) < min_freq { continue; }

        // Analyze hour-of-day patterns
        let hours: Vec<f64> = type_events.iter().map(|e| e.hour_of_day).collect();
        let mean_hour = hours.iter().sum::<f64>() / hours.len() as f64;
        let variance = hours.iter().map(|h| (h - mean_hour).powi(2)).sum::<f64>() / hours.len() as f64;
        let stddev = variance.sqrt();

        if stddev > 3.0 { continue; } // Too inconsistent

        // Analyze day-of-week patterns
        let mut day_counts = [0u32; 7];
        for e in type_events { day_counts[e.day_of_week as usize % 7] += 1; }

        let total = type_events.len() as f64;
        let weekday_ratio: f64 = day_counts[1..6].iter().sum::<u32>() as f64 / total;

        let (pattern, typical_day) = if weekday_ratio > 0.85 {
            // Check for specific day
            let max_day = day_counts.iter().enumerate().max_by_key(|(_, &c)| c).map(|(i, _)| i).unwrap_or(0);
            if day_counts[max_day] as f64 / total > 0.5 {
                (format!("weekly_{}", day_name(max_day)), Some(max_day as u32))
            } else {
                ("weekday".to_string(), None)
            }
        } else if weekday_ratio < 0.25 {
            ("weekend".to_string(), None)
        } else {
            ("daily".to_string(), None)
        };

        let time_label = if mean_hour < 6.0 { "night" }
            else if mean_hour < 12.0 { "morning" }
            else if mean_hour < 18.0 { "afternoon" }
            else { "evening" };

        let consistency = (1.0 - stddev / 3.0).clamp(0.0, 1.0);
        let confidence = (type_events.len() as f64 / 10.0).min(1.0) * consistency;

        // Predict next occurrence
        let now_ms = type_events.last().map(|e| e.timestamp_ms).unwrap_or(0.0);
        let avg_interval = if type_events.len() > 1 {
            let mut intervals: Vec<f64> = Vec::new();
            for i in 1..type_events.len() {
                intervals.push(type_events[i].timestamp_ms - type_events[i-1].timestamp_ms);
            }
            intervals.iter().sum::<f64>() / intervals.len() as f64
        } else {
            86_400_000.0 // Default 24h
        };

        habits.push(DetectedHabit {
            event_type: event_type.clone(),
            pattern: format!("{}_{}", pattern, time_label),
            typical_hour: mean_hour,
            typical_day,
            frequency: type_events.len() as u32,
            consistency,
            confidence,
            next_expected_ms: now_ms + avg_interval,
        });
    }

    habits.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    habits
}

fn day_name(day: usize) -> &'static str {
    ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][day % 7]
}

/// Check if now is within the expected window for a habit.
#[napi]
pub fn is_habit_due(habit: DetectedHabit, current_hour: f64, current_day: u32) -> bool {
    let hour_match = (current_hour - habit.typical_hour).abs() < 1.0;
    let day_match = habit.typical_day.map_or(true, |d| d == current_day);
    hour_match && day_match
}
