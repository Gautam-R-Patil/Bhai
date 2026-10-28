// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Notification Tracker — Rust hot-path for wake-time estimation, engagement scoring,
// and notification fatigue detection.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

/// Rolling window size for wake-time estimation (days)
const WAKE_TIME_WINDOW_DAYS: usize = 14;

/// Fatigue detection: if N+ notifications sent within window and low engagement
const FATIGUE_WINDOW_HOURS: f64 = 4.0;
const FATIGUE_COUNT_THRESHOLD: u32 = 5;
const FATIGUE_ENGAGEMENT_THRESHOLD: f64 = 0.3;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct WakeTimeEstimate {
    /// Estimated wake time as hour-of-day (0-23.99, e.g. 7.5 = 7:30 AM)
    pub mean_hour: f64,
    /// Standard deviation in hours
    pub std_dev: f64,
    /// Recommended briefing hour (mean - 1 stddev, but not before 5 AM)
    pub briefing_hour: f64,
    /// Confidence in the estimate (0-1, based on sample size and consistency)
    pub confidence: f64,
    /// Number of data points used
    pub sample_size: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct NotificationEntry {
    pub notification_type: String, // "briefing" | "thought" | "monitor_alert" | "proactive"
    pub sent_at_hour: f64,         // Hour of day (0-23.99)
    pub response_time_mins: f64,   // -1 if no response
    pub response_type: String,     // "engaged" | "read_no_reply" | "ignored" | ""
    pub day_of_week: u32,          // 0-6 (Sunday=0)
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EngagementScore {
    pub notification_type: String,
    pub engagement_rate: f64, // 0-1
    pub avg_response_time_mins: f64,
    pub best_hour: f64, // Hour of day with highest engagement
    pub best_day: u32,  // Day of week with highest engagement
    pub sample_size: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FatigueStatus {
    pub is_fatigued: bool,
    pub recent_notification_count: u32,
    pub recent_engagement_rate: f64,
    pub recommendation: String, // "proceed" | "reduce_frequency" | "suppress"
}

// ── Wake Time Estimation ───────────────────────────

/// Estimate user's wake time from first-message timestamps.
/// Uses Gaussian estimation over a rolling window.
///
/// Input: array of first-message hours (0-23.99) for recent days.
/// Output: mean, stddev, recommended briefing time, confidence.
#[napi]
pub fn estimate_wake_time(first_message_hours: Vec<f64>) -> WakeTimeEstimate {
    if first_message_hours.is_empty() {
        return WakeTimeEstimate {
            mean_hour: 7.0,
            std_dev: 1.5,
            briefing_hour: 6.5,
            confidence: 0.0,
            sample_size: 0,
        };
    }

    // Use only the most recent N days
    let hours: Vec<f64> = first_message_hours
        .iter()
        .rev()
        .take(WAKE_TIME_WINDOW_DAYS)
        .copied()
        .collect();

    let n = hours.len() as f64;

    // Handle circular time (wrap-around near midnight)
    // If there's a mix of late-night and early-morning, adjust
    let has_late = hours.iter().any(|&h| h > 22.0);
    let has_early = hours.iter().any(|&h| h < 4.0);
    let adjusted: Vec<f64> = if has_late && has_early {
        hours
            .iter()
            .map(|&h| if h > 22.0 { h - 24.0 } else { h })
            .collect()
    } else {
        hours.clone()
    };

    // Compute mean
    let mean = adjusted.iter().sum::<f64>() / n;

    // Compute stddev
    let variance = adjusted.iter().map(|&h| (h - mean).powi(2)).sum::<f64>() / n;
    let std_dev = variance.sqrt().max(0.25); // Floor at 15 minutes

    // Normalize mean back to 0-24 range
    let mean_hour = if mean < 0.0 { mean + 24.0 } else { mean };

    // Briefing time: arrive 1 stddev before expected wake
    let briefing = (mean_hour - std_dev).max(5.0); // Not before 5 AM

    // Confidence based on sample size and consistency
    let size_factor = (n / WAKE_TIME_WINDOW_DAYS as f64).min(1.0);
    let consistency_factor = (1.0 - std_dev / 3.0).max(0.0); // Very inconsistent = low confidence
    let confidence = (size_factor * 0.6 + consistency_factor * 0.4).clamp(0.0, 1.0);

    WakeTimeEstimate {
        mean_hour,
        std_dev,
        briefing_hour: briefing,
        confidence,
        sample_size: hours.len() as u32,
    }
}

// ── Engagement Scoring ─────────────────────────────

/// Compute engagement scores per notification type.
/// Identifies which types the user engages with and optimal delivery times.
#[napi]
pub fn compute_engagement_scores(entries: Vec<NotificationEntry>) -> Vec<EngagementScore> {
    if entries.is_empty() {
        return vec![];
    }

    // Group by notification type
    let mut groups: std::collections::HashMap<String, Vec<&NotificationEntry>> =
        std::collections::HashMap::new();
    for entry in &entries {
        groups
            .entry(entry.notification_type.clone())
            .or_default()
            .push(entry);
    }

    let mut scores: Vec<EngagementScore> = Vec::new();

    for (ntype, group_entries) in groups {
        let total = group_entries.len() as f64;

        // Engagement rate
        let engaged = group_entries
            .iter()
            .filter(|e| e.response_type == "engaged")
            .count() as f64;
        let engagement_rate = engaged / total;

        // Average response time (only for those who responded)
        let response_times: Vec<f64> = group_entries
            .iter()
            .filter(|e| e.response_time_mins >= 0.0)
            .map(|e| e.response_time_mins)
            .collect();
        let avg_response = if response_times.is_empty() {
            -1.0
        } else {
            response_times.iter().sum::<f64>() / response_times.len() as f64
        };

        // Best hour (highest engagement rate per hour bucket)
        let mut hour_engagement: std::collections::HashMap<u32, (u32, u32)> =
            std::collections::HashMap::new(); // hour -> (engaged, total)
        for e in &group_entries {
            let hour = e.sent_at_hour as u32;
            let entry = hour_engagement.entry(hour).or_insert((0, 0));
            entry.1 += 1;
            if e.response_type == "engaged" {
                entry.0 += 1;
            }
        }
        let best_hour = hour_engagement
            .iter()
            .max_by(|a, b| {
                let rate_a = a.1 .0 as f64 / a.1 .1.max(1) as f64;
                let rate_b = b.1 .0 as f64 / b.1 .1.max(1) as f64;
                rate_a
                    .partial_cmp(&rate_b)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(&h, _)| h as f64)
            .unwrap_or(9.0);

        // Best day
        let mut day_engagement: std::collections::HashMap<u32, (u32, u32)> =
            std::collections::HashMap::new();
        for e in &group_entries {
            let entry = day_engagement.entry(e.day_of_week).or_insert((0, 0));
            entry.1 += 1;
            if e.response_type == "engaged" {
                entry.0 += 1;
            }
        }
        let best_day = day_engagement
            .iter()
            .max_by(|a, b| {
                let rate_a = a.1 .0 as f64 / a.1 .1.max(1) as f64;
                let rate_b = b.1 .0 as f64 / b.1 .1.max(1) as f64;
                rate_a
                    .partial_cmp(&rate_b)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(&d, _)| d)
            .unwrap_or(1); // Default Monday

        scores.push(EngagementScore {
            notification_type: ntype,
            engagement_rate,
            avg_response_time_mins: avg_response,
            best_hour,
            best_day,
            sample_size: total as u32,
        });
    }

    scores
}

// ── Fatigue Detection ──────────────────────────────

/// Detect notification fatigue based on recent notification density and engagement drop.
#[napi]
pub fn detect_fatigue(
    recent_notifications: Vec<NotificationEntry>,
    window_hours: Option<f64>,
) -> FatigueStatus {
    let window = window_hours.unwrap_or(FATIGUE_WINDOW_HOURS);

    if recent_notifications.is_empty() {
        return FatigueStatus {
            is_fatigued: false,
            recent_notification_count: 0,
            recent_engagement_rate: 0.0,
            recommendation: "proceed".to_string(),
        };
    }

    let count = recent_notifications.len() as u32;

    let engaged = recent_notifications
        .iter()
        .filter(|e| e.response_type == "engaged")
        .count() as f64;
    let engagement_rate = engaged / recent_notifications.len() as f64;

    let is_fatigued =
        count >= FATIGUE_COUNT_THRESHOLD && engagement_rate < FATIGUE_ENGAGEMENT_THRESHOLD;

    let recommendation = if is_fatigued {
        if engagement_rate < 0.1 {
            "suppress" // Almost no engagement — stop notifications
        } else {
            "reduce_frequency" // Some engagement — just slow down
        }
    } else {
        "proceed"
    };

    FatigueStatus {
        is_fatigued,
        recent_notification_count: count,
        recent_engagement_rate: engagement_rate,
        recommendation: recommendation.to_string(),
    }
}
