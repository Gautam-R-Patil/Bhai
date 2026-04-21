// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Proactive Scheduler — Rust-side queue + dedup + priority + boundary + DND + rate limits.
// See docs/superpowers/specs/2026-04-21-proactiveness-overhaul-design.md

use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct QueuedIntent {
    pub id: String,
    pub source: String,
    pub mode: String,
    pub urgency: String,
    pub channel: String,
    pub topic_embedding: Vec<f64>,
    pub created_at: f64,
    pub expires_at: f64,
    pub posture_weight: f64,
    pub source_weight: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PostureParams {
    pub channel: String,
    pub max_per_day: u32,
    pub min_gap_min: u32,
    pub heartbeat_min: u32,
    pub boundary_only: bool,
    pub urgent_bypass: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct DropEntry {
    pub id: String,
    pub reason: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ReleaseResult {
    pub released: Vec<String>,
    pub dropped: Vec<DropEntry>,
}

struct ChannelState {
    queue: VecDeque<QueuedIntent>,
    posture: PostureParams,
    last_sent_ms: f64,
    sent_today: u32,
    day_bucket: i64,
    boundary_window_until_ms: f64,
    dnd_active: bool,
    recent_topic_embeddings: VecDeque<(f64, Vec<f64>)>,
}

static STATE: Lazy<Arc<Mutex<HashMap<String, ChannelState>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn day_index(ms: f64) -> i64 {
    (ms / 86_400_000.0) as i64
}

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for i in 0..a.len().min(b.len()) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn priority(q: &QueuedIntent, now: f64) -> f64 {
    let base = match q.urgency.as_str() {
        "urgent" => 100.0,
        "normal" => 10.0,
        _ => 1.0,
    };
    let age_min = ((now - q.created_at) / 60_000.0).max(0.0);
    let life_min = ((q.expires_at - q.created_at) / 60_000.0).max(1.0);
    let freshness = (-age_min / life_min).exp();
    base * freshness * q.posture_weight * q.source_weight
}

#[napi]
pub fn scheduler_configure(posture: PostureParams) {
    let mut st = STATE.lock();
    let entry = st.entry(posture.channel.clone()).or_insert_with(|| ChannelState {
        queue: VecDeque::new(),
        posture: posture.clone(),
        last_sent_ms: 0.0,
        sent_today: 0,
        day_bucket: day_index(now_ms()),
        boundary_window_until_ms: 0.0,
        dnd_active: false,
        recent_topic_embeddings: VecDeque::new(),
    });
    entry.posture = posture;
}

#[napi]
pub fn scheduler_enqueue(intent: QueuedIntent) -> String {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&intent.channel) {
        Some(c) => c,
        None => return "no_posture_configured".into(),
    };
    let now = now_ms();
    let today = day_index(now);
    if today != cs.day_bucket {
        cs.day_bucket = today;
        cs.sent_today = 0;
    }
    let six_h_ago = now - 6.0 * 3600.0 * 1000.0;
    cs.recent_topic_embeddings.retain(|(ts, _)| *ts >= six_h_ago);
    for (_, emb) in cs.recent_topic_embeddings.iter() {
        if cosine(&intent.topic_embedding, emb) > 0.9 {
            return "dedup".into();
        }
    }
    cs.queue.push_back(intent);
    "enqueued".into()
}

#[napi]
pub fn scheduler_mark_boundary(channel: String, window_ms: f64) {
    let mut st = STATE.lock();
    if let Some(cs) = st.get_mut(&channel) {
        cs.boundary_window_until_ms = now_ms() + window_ms;
    }
}

#[napi]
pub fn scheduler_set_dnd(channel: String, active: bool) {
    let mut st = STATE.lock();
    if let Some(cs) = st.get_mut(&channel) {
        cs.dnd_active = active;
    }
}

#[napi]
pub fn scheduler_try_release(channel: String) -> ReleaseResult {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&channel) {
        Some(c) => c,
        None => return ReleaseResult { released: vec![], dropped: vec![] },
    };
    let now = now_ms();
    let mut released: Vec<String> = Vec::new();
    let mut dropped: Vec<DropEntry> = Vec::new();

    let today = day_index(now);
    if today != cs.day_bucket {
        cs.day_bucket = today;
        cs.sent_today = 0;
    }

    cs.queue.retain(|q| {
        if q.expires_at < now {
            dropped.push(DropEntry {
                id: q.id.clone(),
                reason: "expired".into(),
            });
            false
        } else {
            true
        }
    });

    let mut sorted: Vec<QueuedIntent> = cs.queue.drain(..).collect();
    sorted.sort_by(|a, b| {
        priority(b, now)
            .partial_cmp(&priority(a, now))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let p = cs.posture.clone();
    let boundary_active = now <= cs.boundary_window_until_ms;

    for q in sorted {
        let urgent = q.urgency == "urgent";
        let can_bypass = urgent && p.urgent_bypass;

        if cs.sent_today >= p.max_per_day && !can_bypass {
            cs.queue.push_back(q);
            continue;
        }
        let gap_ok = (now - cs.last_sent_ms) >= (p.min_gap_min as f64) * 60_000.0;
        if !gap_ok && !can_bypass {
            cs.queue.push_back(q);
            continue;
        }
        if cs.dnd_active && !can_bypass {
            cs.queue.push_back(q);
            continue;
        }
        if p.boundary_only && !boundary_active && !can_bypass {
            cs.queue.push_back(q);
            continue;
        }

        cs.last_sent_ms = now;
        cs.sent_today += 1;
        cs.recent_topic_embeddings.push_back((now, q.topic_embedding.clone()));
        released.push(q.id);
    }

    ReleaseResult { released, dropped }
}

#[napi]
pub fn scheduler_debug_state(channel: String) -> String {
    let st = STATE.lock();
    match st.get(&channel) {
        Some(cs) => format!(
            "queue={} sent_today={} last_sent={} boundary_until={} dnd={}",
            cs.queue.len(),
            cs.sent_today,
            cs.last_sent_ms,
            cs.boundary_window_until_ms,
            cs.dnd_active
        ),
        None => "no posture configured".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() {
        let mut st = STATE.lock();
        st.clear();
    }

    fn mk(id: &str, channel: &str, urgency: &str, embedding: Vec<f64>) -> QueuedIntent {
        QueuedIntent {
            id: id.into(),
            source: "memory_anticipation".into(),
            mode: "fyi".into(),
            urgency: urgency.into(),
            channel: channel.into(),
            topic_embedding: embedding,
            created_at: now_ms(),
            expires_at: now_ms() + 60_000.0,
            posture_weight: 1.0,
            source_weight: 1.0,
        }
    }

    fn configure(channel: &str, max_per_day: u32, min_gap_min: u32, boundary_only: bool, urgent_bypass: bool) {
        scheduler_configure(PostureParams {
            channel: channel.into(),
            max_per_day,
            min_gap_min,
            heartbeat_min: 60,
            boundary_only,
            urgent_bypass,
        });
    }

    #[test]
    fn enqueue_without_posture_returns_error() {
        fresh();
        let r = scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0]));
        assert_eq!(r, "no_posture_configured");
    }

    #[test]
    fn dedup_rejects_same_topic() {
        fresh();
        configure("t", 10, 0, false, true);
        assert_eq!(scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0, 0.0])), "enqueued");
        let r = scheduler_try_release("t".into());
        assert!(r.released.contains(&"a".to_string()));
        assert_eq!(scheduler_enqueue(mk("b", "t", "normal", vec![1.0, 0.0, 0.0])), "dedup");
    }

    #[test]
    fn boundary_gate_holds_non_urgent() {
        fresh();
        configure("t", 10, 0, true, true);
        scheduler_enqueue(mk("q", "t", "normal", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert!(r.released.is_empty(), "non-urgent should be held without boundary");
        scheduler_mark_boundary("t".into(), 60_000.0);
        let r2 = scheduler_try_release("t".into());
        assert_eq!(r2.released, vec!["q".to_string()]);
    }

    #[test]
    fn urgent_bypasses_boundary() {
        fresh();
        configure("t", 10, 0, true, true);
        scheduler_enqueue(mk("u", "t", "urgent", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released, vec!["u".to_string()]);
    }

    #[test]
    fn dnd_blocks_non_urgent() {
        fresh();
        configure("t", 10, 0, false, true);
        scheduler_set_dnd("t".into(), true);
        scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert!(r.released.is_empty());
    }

    #[test]
    fn dnd_allows_urgent_with_bypass() {
        fresh();
        configure("t", 10, 0, false, true);
        scheduler_set_dnd("t".into(), true);
        scheduler_enqueue(mk("u", "t", "urgent", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released, vec!["u".to_string()]);
    }

    #[test]
    fn expired_intents_are_dropped() {
        fresh();
        configure("t", 10, 0, false, true);
        let mut q = mk("old", "t", "normal", vec![1.0, 0.0]);
        q.expires_at = now_ms() - 1000.0;
        scheduler_enqueue(q);
        let r = scheduler_try_release("t".into());
        assert!(r.released.is_empty());
        assert!(r.dropped.iter().any(|d| d.id == "old" && d.reason == "expired"));
    }

    #[test]
    fn rate_limit_blocks_extra_sends() {
        fresh();
        configure("t", 1, 0, false, true);
        scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0]));
        scheduler_enqueue(mk("b", "t", "normal", vec![0.0, 1.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released.len(), 1);
        let r2 = scheduler_try_release("t".into());
        assert!(r2.released.is_empty());
    }

    #[test]
    fn priority_orders_urgent_first() {
        fresh();
        configure("t", 10, 0, false, true);
        scheduler_enqueue(mk("normal", "t", "normal", vec![1.0, 0.0]));
        scheduler_enqueue(mk("urgent", "t", "urgent", vec![0.0, 1.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released.len(), 2);
        assert_eq!(r.released[0], "urgent");
    }
}
