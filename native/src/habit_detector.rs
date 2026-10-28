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
    pub pattern: String, // "daily_morning" | "weekday_evening" | "weekly_monday" etc
    pub typical_hour: f64,
    pub typical_day: Option<u32>,
    pub frequency: u32,
    pub consistency: f64, // 0-1 (low stddev = high consistency)
    pub confidence: f64,
    pub next_expected_ms: f64, // Predicted next occurrence
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
        by_type
            .entry(event.event_type.clone())
            .or_default()
            .push(event);
    }

    for (event_type, type_events) in &by_type {
        if (type_events.len() as u32) < min_freq {
            continue;
        }

        // Analyze hour-of-day patterns
        let hours: Vec<f64> = type_events.iter().map(|e| e.hour_of_day).collect();
        let mean_hour = hours.iter().sum::<f64>() / hours.len() as f64;
        let variance =
            hours.iter().map(|h| (h - mean_hour).powi(2)).sum::<f64>() / hours.len() as f64;
        let stddev = variance.sqrt();

        if stddev > 3.0 {
            continue;
        } // Too inconsistent

        // Analyze day-of-week patterns
        let mut day_counts = [0u32; 7];
        for e in type_events {
            day_counts[e.day_of_week as usize % 7] += 1;
        }

        let total = type_events.len() as f64;
        let weekday_ratio: f64 = day_counts[1..6].iter().sum::<u32>() as f64 / total;

        let (pattern, typical_day) = if weekday_ratio > 0.85 {
            // Check for specific day
            let max_day = day_counts
                .iter()
                .enumerate()
                .max_by_key(|(_, &c)| c)
                .map(|(i, _)| i)
                .unwrap_or(0);
            if day_counts[max_day] as f64 / total > 0.5 {
                (
                    format!("weekly_{}", day_name(max_day)),
                    Some(max_day as u32),
                )
            } else {
                ("weekday".to_string(), None)
            }
        } else if weekday_ratio < 0.25 {
            ("weekend".to_string(), None)
        } else {
            ("daily".to_string(), None)
        };

        let time_label = if mean_hour < 6.0 {
            "night"
        } else if mean_hour < 12.0 {
            "morning"
        } else if mean_hour < 18.0 {
            "afternoon"
        } else {
            "evening"
        };

        let consistency = (1.0 - stddev / 3.0).clamp(0.0, 1.0);
        let confidence = (type_events.len() as f64 / 10.0).min(1.0) * consistency;

        // Predict next occurrence
        let now_ms = type_events.last().map(|e| e.timestamp_ms).unwrap_or(0.0);
        let avg_interval = if type_events.len() > 1 {
            let mut intervals: Vec<f64> = Vec::new();
            for i in 1..type_events.len() {
                intervals.push(type_events[i].timestamp_ms - type_events[i - 1].timestamp_ms);
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

    habits.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    habits
}

fn day_name(day: usize) -> &'static str {
    [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
    ][day % 7]
}

/// Check if now is within the expected window for a habit.
#[napi]
pub fn is_habit_due(habit: DetectedHabit, current_hour: f64, current_day: u32) -> bool {
    let hour_match = (current_hour - habit.typical_hour).abs() < 1.0;
    let day_match = habit.typical_day.is_none_or(|d| d == current_day);
    hour_match && day_match
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct HabitEvent {
    pub event_type: String,
    pub ts_ms: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct HabitAnomaly {
    pub event_type: String,
    pub expected_hour: u32,
    pub last_seen_days_ago: u32,
    pub confidence: f64,
}

#[napi]
pub fn habit_detect_anomalies(
    habits: Vec<DetectedHabit>,
    recent_events: Vec<HabitEvent>,
    now_ms: f64,
) -> Vec<HabitAnomaly> {
    let now_hour = ((now_ms / 1000.0 / 3600.0) as u32) % 24;
    let six_h_ago = now_ms - 6.0 * 3600.0 * 1000.0;
    let mut out = Vec::new();

    for habit in habits.iter() {
        let hour_diff = {
            let d = (habit.typical_hour as i32 - now_hour as i32).abs();
            d.min(24 - d)
        };
        if hour_diff > 1 {
            continue;
        }

        let seen = recent_events
            .iter()
            .any(|e| e.event_type == habit.event_type && e.ts_ms >= six_h_ago);
        if seen {
            continue;
        }

        let proximity = 1.0 - (hour_diff as f64) * 0.5;
        let confidence = habit.confidence * proximity;
        if confidence < 0.3 {
            continue;
        }

        let last_ts = recent_events
            .iter()
            .filter(|e| e.event_type == habit.event_type)
            .map(|e| e.ts_ms)
            .fold(f64::NEG_INFINITY, f64::max);
        let days_ago = if last_ts.is_finite() {
            ((now_ms - last_ts) / 86_400_000.0) as u32
        } else {
            99
        };

        out.push(HabitAnomaly {
            event_type: habit.event_type.clone(),
            expected_hour: habit.typical_hour as u32,
            last_seen_days_ago: days_ago,
            confidence,
        });
    }

    out
}

#[cfg(test)]
mod tests_anomaly {
    use super::*;

    fn make_habit(event_type: &str, typical_hour: f64, confidence: f64) -> DetectedHabit {
        DetectedHabit {
            event_type: event_type.into(),
            pattern: "daily_morning".into(),
            typical_hour,
            typical_day: None,
            frequency: 10,
            consistency: 0.9,
            confidence,
            next_expected_ms: 0.0,
        }
    }

    #[test]
    fn anomaly_fires_within_1h_of_typical_hour_when_no_recent_event() {
        // now_ms at hour=9 exactly: 9 * 3600 * 1000 = 32_400_000
        let now_ms = 9.0 * 3600_000.0;
        let habits = vec![make_habit("morning_run", 9.0, 0.8)];
        let result = habit_detect_anomalies(habits, vec![], now_ms);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].event_type, "morning_run");
        assert_eq!(result[0].expected_hour, 9);
        assert_eq!(result[0].last_seen_days_ago, 99);
    }

    #[test]
    fn anomaly_suppressed_when_recent_event_matches_type() {
        let now_ms = 9.0 * 3600_000.0;
        let habits = vec![make_habit("morning_run", 9.0, 0.8)];
        let recent_events = vec![HabitEvent {
            event_type: "morning_run".into(),
            ts_ms: now_ms - 1.0 * 3600_000.0, // 1h ago, within 6h window
        }];
        let result = habit_detect_anomalies(habits, recent_events, now_ms);
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn anomaly_handles_midnight_wrap_around() {
        // Habit at 23:00, now at 00:00 (1 circular hour later) — should fire.
        // UTC midnight is epoch multiples of 86_400_000.
        let now_ms = 86_400_000.0 * 1000.0; // day 1000, 00:00 UTC → now_hour = 0

        let habit = DetectedHabit {
            event_type: "coding".into(),
            pattern: "daily".into(),
            typical_hour: 23.0,
            typical_day: None,
            frequency: 5,
            consistency: 0.9,
            confidence: 0.9,
            next_expected_ms: 0.0,
        };

        let recent = vec![];
        let anomalies = habit_detect_anomalies(vec![habit], recent, now_ms);
        assert_eq!(anomalies.len(), 1, "habit at 23:00 should fire at 00:00");
    }

    #[test]
    fn anomaly_suppressed_when_outside_1h_window() {
        // now_ms at hour=11 (typical_hour=9, diff=2 > 1)
        let now_ms = 11.0 * 3600_000.0;
        let habits = vec![make_habit("morning_run", 9.0, 0.8)];
        let result = habit_detect_anomalies(habits, vec![], now_ms);
        assert_eq!(result.len(), 0);
    }
}
