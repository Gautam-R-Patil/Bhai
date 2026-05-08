// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Proactive V3 — calendar analyzer: conflicts, back-to-back, long gaps, prep intents.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub location: Option<String>,
    pub has_attendees: bool,
    pub is_all_day: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EventPair {
    pub first: String,
    pub second: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct LongGap {
    pub start_ms: f64,
    pub end_ms: f64,
    pub prev_event_id: Option<String>,
    pub next_event_id: Option<String>,
    pub duration_min: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CalendarAnalysis {
    pub conflicts: Vec<EventPair>,
    pub back_to_back: Vec<EventPair>,
    pub long_gaps: Vec<LongGap>,
    pub next_event_id: Option<String>,
    pub morning_meeting_count: u32,
    pub afternoon_meeting_count: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PrepIntent {
    pub event_id: String,
    pub title: String,
    pub fire_at_ms: f64,
    pub event_start_ms: f64,
    pub location: Option<String>,
    pub has_attendees: bool,
}

#[napi]
pub fn calendar_analyze(
    events: Vec<CalendarEvent>,
    now_ms: f64,
    work_start_hr: u32,
    work_end_hr: u32,
    timezone_offset_min: i32,
) -> CalendarAnalysis {
    let mut filtered: Vec<CalendarEvent> = events.into_iter().filter(|e| !e.is_all_day).collect();
    filtered.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    let mut conflicts: Vec<EventPair> = Vec::new();
    let mut back_to_back: Vec<EventPair> = Vec::new();
    let mut long_gaps: Vec<LongGap> = Vec::new();

    let tz_offset_ms = (timezone_offset_min as f64) * 60_000.0;

    // Conflict detection: O(n^2) over the sorted list
    for i in 0..filtered.len() {
        for j in (i + 1)..filtered.len() {
            let a = &filtered[i];
            let b = &filtered[j];
            if b.start_ms >= a.end_ms { break; }
            if a.start_ms < b.start_ms && b.start_ms < a.end_ms {
                conflicts.push(EventPair { first: a.id.clone(), second: b.id.clone() });
            }
        }
    }

    // Back-to-back + long-gap detection via sliding window
    for w in filtered.windows(2) {
        let a = &w[0];
        let b = &w[1];
        let gap_ms = b.start_ms - a.end_ms;
        if gap_ms > 0.0 && gap_ms < 5.0 * 60_000.0 {
            back_to_back.push(EventPair { first: a.id.clone(), second: b.id.clone() });
        }
        if gap_ms >= 90.0 * 60_000.0 {
            let start_hr_of_day = ((a.end_ms + tz_offset_ms) % 86_400_000.0) / 3600_000.0;
            let end_hr_of_day = ((b.start_ms + tz_offset_ms) % 86_400_000.0) / 3600_000.0;
            if start_hr_of_day >= work_start_hr as f64 && end_hr_of_day <= work_end_hr as f64 {
                long_gaps.push(LongGap {
                    start_ms: a.end_ms,
                    end_ms: b.start_ms,
                    prev_event_id: Some(a.id.clone()),
                    next_event_id: Some(b.id.clone()),
                    duration_min: (gap_ms / 60_000.0) as u32,
                });
            }
        }
    }

    let next_event_id = filtered.iter().find(|e| e.start_ms > now_ms).map(|e| e.id.clone());

    let mut morning_meeting_count = 0u32;
    let mut afternoon_meeting_count = 0u32;
    for e in filtered.iter() {
        let hr_of_day = ((e.start_ms + tz_offset_ms) % 86_400_000.0) / 3600_000.0;
        if hr_of_day < 12.0 {
            morning_meeting_count += 1;
        } else {
            afternoon_meeting_count += 1;
        }
    }

    CalendarAnalysis {
        conflicts,
        back_to_back,
        long_gaps,
        next_event_id,
        morning_meeting_count,
        afternoon_meeting_count,
    }
}

#[napi]
pub fn calendar_prep_intents(
    events: Vec<CalendarEvent>,
    now_ms: f64,
    offset_minutes: i32,
) -> Vec<PrepIntent> {
    let mut out = Vec::new();
    let day_ms = 24.0 * 3600_000.0;

    for e in events.into_iter() {
        if e.is_all_day { continue; }
        let (anchor_ms, fire_at_ms) = if offset_minutes >= 0 {
            let anchor = e.start_ms;
            let fire = anchor - (offset_minutes as f64) * 60_000.0;
            if fire <= now_ms { continue; }
            if anchor <= now_ms + 60_000.0 { continue; }
            if anchor - now_ms > day_ms { continue; }
            (anchor, fire)
        } else {
            let anchor = e.end_ms;
            let fire = anchor + (-offset_minutes as f64) * 60_000.0;
            if fire <= now_ms { continue; }
            if fire - now_ms > day_ms { continue; }
            (anchor, fire)
        };
        out.push(PrepIntent {
            event_id: e.id,
            title: e.title,
            fire_at_ms,
            event_start_ms: anchor_ms,
            location: e.location,
            has_attendees: e.has_attendees,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, start: f64, end: f64) -> CalendarEvent {
        CalendarEvent {
            id: id.into(),
            title: format!("ev {}", id),
            start_ms: start,
            end_ms: end,
            location: None,
            has_attendees: false,
            is_all_day: false,
        }
    }

    #[test]
    fn overlap_detected() {
        let events = vec![ev("a", 9.0e6, 10.0e6), ev("b", 9.5e6, 10.5e6)];
        let r = calendar_analyze(events, 8.0e6, 9, 18, 0);
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!(r.conflicts[0].first, "a");
        assert_eq!(r.conflicts[0].second, "b");
    }

    #[test]
    fn back_to_back_detected() {
        let events = vec![ev("a", 9.0e6, 10.0e6), ev("b", 10.0e6 + 3.0 * 60_000.0, 11.0e6)];
        let r = calendar_analyze(events, 8.0e6, 9, 18, 0);
        assert_eq!(r.back_to_back.len(), 1);
    }

    #[test]
    fn no_back_to_back_when_gap_over_5min() {
        let events = vec![ev("a", 9.0e6, 10.0e6), ev("b", 10.0e6 + 6.0 * 60_000.0, 11.0e6)];
        let r = calendar_analyze(events, 8.0e6, 9, 18, 0);
        assert_eq!(r.back_to_back.len(), 0);
    }

    #[test]
    fn long_gap_within_work_hours() {
        let t9 = 9.0 * 3600_000.0;
        let t10 = 10.0 * 3600_000.0;
        let t15 = 15.0 * 3600_000.0;
        let t16 = 16.0 * 3600_000.0;
        let events = vec![ev("a", t9, t10), ev("b", t15, t16)];
        let r = calendar_analyze(events, 0.0, 9, 18, 0);
        assert!(r.long_gaps.len() >= 1);
        assert!(r.long_gaps[0].duration_min >= 90);
    }

    #[test]
    fn all_day_excluded_from_analysis() {
        let mut allday = ev("a", 0.0, 86400_000.0);
        allday.is_all_day = true;
        let events = vec![allday, ev("b", 9.0e6, 10.0e6)];
        let r = calendar_analyze(events, 8.0e6, 9, 18, 0);
        assert_eq!(r.conflicts.len(), 0);
    }

    #[test]
    fn prep_intents_for_upcoming_events() {
        let now = 10.0 * 3600_000.0;
        let start = now + 2.0 * 3600_000.0;
        let events = vec![ev("a", start, start + 3600_000.0)];
        let prep = calendar_prep_intents(events, now, 15);
        assert_eq!(prep.len(), 1);
        assert!((prep[0].fire_at_ms - (start - 15.0 * 60_000.0)).abs() < 1.0);
    }

    #[test]
    fn prep_intents_positive_offset_skips_past_events() {
        let now = 10.0 * 3600_000.0;
        let events = vec![ev("a", now - 3600_000.0, now - 1800_000.0)];
        let prep = calendar_prep_intents(events, now, 15);
        assert_eq!(prep.len(), 0);
    }

    #[test]
    fn prep_intents_negative_offset_emits_followup() {
        let now = 10.0 * 3600_000.0;
        let events = vec![ev("a", now - 3600_000.0, now - 60_000.0)];
        let prep = calendar_prep_intents(events, now, -10);
        assert_eq!(prep.len(), 1);
        assert!(prep[0].fire_at_ms > now);
    }
}
