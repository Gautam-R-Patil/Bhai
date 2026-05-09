// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Proactive V3 — task urgency scoring: overdue, urgent-today, normal-today, deadline nudges.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskEntry {
    pub id: String,
    pub title: String,
    pub due_ms: Option<f64>,
    pub priority: String,
    pub completed: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct DeadlineNudge {
    pub task_id: String,
    pub title: String,
    pub due_ms: f64,
    pub fire_at_ms: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskUrgencyResult {
    pub urgent_today: Vec<String>,
    pub normal_today: Vec<String>,
    pub overdue: Vec<String>,
    pub deadline_nudges: Vec<DeadlineNudge>,
}

fn start_of_day_ms(now_ms: f64, tz_offset_min: i32) -> f64 {
    let tz_offset_ms = (tz_offset_min as f64) * 60_000.0;
    let local = now_ms + tz_offset_ms;
    let day = (local / 86_400_000.0).floor() * 86_400_000.0;
    day - tz_offset_ms
}

#[napi]
pub fn tasks_score(tasks: Vec<TaskEntry>, now_ms: f64, timezone_offset_min: i32) -> TaskUrgencyResult {
    let sod = start_of_day_ms(now_ms, timezone_offset_min);
    let eod = sod + 86_400_000.0;

    let mut urgent_today: Vec<TaskEntry> = Vec::new();
    let mut normal_today: Vec<TaskEntry> = Vec::new();
    let mut overdue_list: Vec<TaskEntry> = Vec::new();
    let mut deadline_nudges: Vec<DeadlineNudge> = Vec::new();

    for t in tasks.into_iter() {
        if t.completed { continue; }
        let Some(due) = t.due_ms else { continue; };
        if due < now_ms {
            overdue_list.push(t);
        } else if due >= sod && due < eod {
            let within_3h = due - now_ms < 3.0 * 3600_000.0;
            if t.priority == "high" || within_3h {
                urgent_today.push(t.clone());
            } else {
                normal_today.push(t.clone());
            }
            if due - now_ms <= 4.0 * 3600_000.0 {
                let mut fire_at = due - 60.0 * 60_000.0;
                if fire_at <= now_ms { fire_at = now_ms + 30_000.0; }
                deadline_nudges.push(DeadlineNudge {
                    task_id: t.id.clone(),
                    title: t.title.clone(),
                    due_ms: due,
                    fire_at_ms: fire_at,
                });
            }
        }
    }

    urgent_today.sort_by(|a, b| a.due_ms.partial_cmp(&b.due_ms).unwrap_or(std::cmp::Ordering::Equal));
    normal_today.sort_by(|a, b| a.due_ms.partial_cmp(&b.due_ms).unwrap_or(std::cmp::Ordering::Equal));
    overdue_list.sort_by(|a, b| a.due_ms.partial_cmp(&b.due_ms).unwrap_or(std::cmp::Ordering::Equal));

    TaskUrgencyResult {
        urgent_today: urgent_today.into_iter().map(|t| t.id).collect(),
        normal_today: normal_today.into_iter().map(|t| t.id).collect(),
        overdue: overdue_list.into_iter().map(|t| t.id).collect(),
        deadline_nudges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tk(id: &str, due_offset_ms: f64, now: f64, priority: &str) -> TaskEntry {
        TaskEntry {
            id: id.into(),
            title: format!("task {}", id),
            due_ms: Some(now + due_offset_ms),
            priority: priority.into(),
            completed: false,
        }
    }

    #[test]
    fn overdue_partitioned() {
        let now = 10.0 * 3600_000.0;
        let t = tk("ov", -3600_000.0, now, "normal");
        let r = tasks_score(vec![t], now, 0);
        assert_eq!(r.overdue, vec!["ov".to_string()]);
        assert!(r.urgent_today.is_empty());
    }

    #[test]
    fn high_priority_today_is_urgent() {
        let now = 10.0 * 3600_000.0;
        let t = tk("hp", 5.0 * 3600_000.0, now, "high");
        let r = tasks_score(vec![t], now, 0);
        assert_eq!(r.urgent_today, vec!["hp".to_string()]);
    }

    #[test]
    fn within_3h_is_urgent_regardless_of_priority() {
        let now = 10.0 * 3600_000.0;
        let t = tk("close", 2.0 * 3600_000.0, now, "normal");
        let r = tasks_score(vec![t], now, 0);
        assert_eq!(r.urgent_today, vec!["close".to_string()]);
    }

    #[test]
    fn deadline_nudge_60min_before_due() {
        let now = 10.0 * 3600_000.0;
        let due_off = 2.0 * 3600_000.0;
        let t = tk("dn", due_off, now, "normal");
        let r = tasks_score(vec![t], now, 0);
        assert_eq!(r.deadline_nudges.len(), 1);
        assert!((r.deadline_nudges[0].fire_at_ms - (now + due_off - 3600_000.0)).abs() < 1.0);
    }

    #[test]
    fn completed_skipped_entirely() {
        let now = 10.0 * 3600_000.0;
        let mut t = tk("done", -3600_000.0, now, "normal");
        t.completed = true;
        let r = tasks_score(vec![t], now, 0);
        assert!(r.overdue.is_empty());
        assert!(r.urgent_today.is_empty());
    }

    #[test]
    fn overdue_sorted_oldest_first() {
        let now = 10.0 * 3600_000.0;
        let a = tk("a", -1.0 * 3600_000.0, now, "normal");
        let b = tk("b", -5.0 * 3600_000.0, now, "normal");
        let r = tasks_score(vec![a, b], now, 0);
        assert_eq!(r.overdue, vec!["b".to_string(), "a".to_string()]);
    }
}
