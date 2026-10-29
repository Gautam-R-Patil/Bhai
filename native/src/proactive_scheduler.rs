// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Proactive Scheduler — Rust-side queue + dedup + priority + boundary + DND + rate limits.
// See docs/superpowers/specs/2026-04-21-proactiveness-overhaul-design.md

use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, VecDeque};
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
    pub scheduled_for: f64,
    pub payload_kind: String,
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

#[derive(Clone)]
struct ScheduledIntent {
    scheduled_for: u64,
    intent: QueuedIntent,
}

impl PartialEq for ScheduledIntent {
    fn eq(&self, other: &Self) -> bool {
        self.scheduled_for == other.scheduled_for
    }
}
impl Eq for ScheduledIntent {}
impl PartialOrd for ScheduledIntent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ScheduledIntent {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.scheduled_for.cmp(&other.scheduled_for)
    }
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
    pending_scheduled: BinaryHeap<Reverse<ScheduledIntent>>,
}

/// Tests share STATE: each holds this for its whole run (cargo runs tests in parallel).
#[cfg(test)]
static TEST_SERIAL: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

static STATE: Lazy<Arc<Mutex<HashMap<String, ChannelState>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// The owner's local day, so the daily cap resets at their midnight (it was UTC's: 05:30 in
/// India, late afternoon on the US west coast).
fn day_index(ms: f64) -> i64 {
    ((ms + local_offset_ms(ms)) / 86_400_000.0).floor() as i64
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn local_offset_ms(ms: f64) -> f64 {
    let t = (ms / 1000.0) as libc::time_t;
    // SAFETY: localtime_r only writes the caller-owned `tm`; a zeroed tm is a valid input.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return 0.0;
    }
    tm.tm_gmtoff as f64 * 1000.0
}

// ponytail: Windows keeps UTC days; use GetTimeZoneInformation if a Windows owner notices.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn local_offset_ms(_ms: f64) -> f64 {
    0.0
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
    let entry = st
        .entry(posture.channel.clone())
        .or_insert_with(|| ChannelState {
            queue: VecDeque::new(),
            posture: posture.clone(),
            last_sent_ms: 0.0,
            sent_today: 0,
            day_bucket: day_index(now_ms()),
            boundary_window_until_ms: 0.0,
            dnd_active: false,
            recent_topic_embeddings: VecDeque::new(),
            pending_scheduled: BinaryHeap::new(),
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

    if intent.scheduled_for > 0.0 && intent.scheduled_for > now {
        if cs.pending_scheduled.len() >= 500 {
            return "scheduled_cap".into();
        }
        cs.pending_scheduled.push(Reverse(ScheduledIntent {
            scheduled_for: intent.scheduled_for as u64,
            intent,
        }));
        return "scheduled".into();
    }

    let six_h_ago = now - 6.0 * 3600.0 * 1000.0;
    cs.recent_topic_embeddings
        .retain(|(ts, _)| *ts >= six_h_ago);
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
pub fn scheduler_drain_scheduled(channel: String) -> Vec<String> {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&channel) {
        Some(c) => c,
        None => return vec![],
    };
    let now = now_ms() as u64;
    let mut promoted = Vec::new();
    while let Some(Reverse(top)) = cs.pending_scheduled.peek() {
        if top.scheduled_for > now {
            break;
        }
        let Reverse(entry) = cs.pending_scheduled.pop().unwrap();
        let id = entry.intent.id.clone();
        cs.queue.push_back(entry.intent);
        promoted.push(id);
    }
    promoted
}

#[napi]
pub fn scheduler_set_dnd(channel: String, active: bool) {
    let mut st = STATE.lock();
    if let Some(cs) = st.get_mut(&channel) {
        cs.dnd_active = active;
    }
}

fn _release_candidates(
    cs: &mut ChannelState,
    now: f64,
    dropped: &mut Vec<DropEntry>,
) -> Vec<QueuedIntent> {
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
    let mut selected: Vec<QueuedIntent> = Vec::new();
    // The gap is checked once per release: checking it per item, after the first selected
    // item reset last_sent_ms, let only one morning item out per release (with any real
    // gap), so the morning batch never formed and each piece used up the daily cap.
    let gap_ok = (now - cs.last_sent_ms) >= (p.min_gap_min as f64) * 60_000.0;
    // Morning items released together become ONE message (scheduler_release_grouped): one
    // slot. With a gap configured, a release sends at most one non-urgent message (the batch
    // or a single), so messages stay spaced; with no gap, everything eligible goes.
    let one_per_release = p.min_gap_min > 0;
    let mut morning_slot = false;
    let mut single_slot = false;

    for q in sorted {
        let urgent = q.urgency == "urgent";
        let can_bypass = urgent && p.urgent_bypass;

        // Same topic as something already sent (or selected just now): a stale queued copy.
        // Urgent alerts are never dropped for looking similar.
        if !urgent
            && cs
                .recent_topic_embeddings
                .iter()
                .any(|(_, e)| cosine(&q.topic_embedding, e) > 0.9)
        {
            dropped.push(DropEntry {
                id: q.id.clone(),
                reason: "dedup".into(),
            });
            continue;
        }
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
        let batchable = q.mode != "review" && is_morning_kind(&q.payload_kind);
        let new_slot = if can_bypass {
            true
        } else if batchable {
            if one_per_release && single_slot {
                cs.queue.push_back(q);
                continue;
            }
            !morning_slot
        } else if one_per_release && (single_slot || morning_slot) {
            cs.queue.push_back(q);
            continue;
        } else {
            true
        };
        if new_slot && cs.sent_today >= p.max_per_day && !can_bypass {
            cs.queue.push_back(q);
            continue;
        }
        if new_slot {
            cs.sent_today += 1;
        }
        if batchable && !can_bypass {
            morning_slot = true;
        } else if !can_bypass {
            single_slot = true;
        }

        cs.last_sent_ms = now;
        cs.recent_topic_embeddings
            .push_back((now, q.topic_embedding.clone()));
        selected.push(q);
    }

    selected
}

#[napi]
pub fn scheduler_try_release(channel: String) -> ReleaseResult {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&channel) {
        Some(c) => c,
        None => {
            return ReleaseResult {
                released: vec![],
                dropped: vec![],
            }
        }
    };
    let now = now_ms();
    let today = day_index(now);
    if today != cs.day_bucket {
        cs.day_bucket = today;
        cs.sent_today = 0;
    }
    let mut dropped: Vec<DropEntry> = Vec::new();
    let selected = _release_candidates(cs, now, &mut dropped);
    ReleaseResult {
        released: selected.into_iter().map(|q| q.id).collect(),
        dropped,
    }
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct GroupedReleaseResult {
    pub morning_batch: Vec<String>,
    pub singles: Vec<String>,
    pub dropped: Vec<DropEntry>,
}

const MORNING_KINDS: &[&str] = &[
    "calendar_today_summary",
    "tasks_today",
    "goals_status",
    "weather_today",
    "news_today",
    "habit_anomaly",
];

fn is_morning_kind(kind: &str) -> bool {
    MORNING_KINDS.contains(&kind)
}

#[napi]
pub fn scheduler_release_grouped(channel: String) -> GroupedReleaseResult {
    let mut st = STATE.lock();
    let cs = match st.get_mut(&channel) {
        Some(c) => c,
        None => {
            return GroupedReleaseResult {
                morning_batch: vec![],
                singles: vec![],
                dropped: vec![],
            }
        }
    };
    let now = now_ms();
    let today = day_index(now);
    if today != cs.day_bucket {
        cs.day_bucket = today;
        cs.sent_today = 0;
    }

    let mut dropped: Vec<DropEntry> = Vec::new();
    let selected = _release_candidates(cs, now, &mut dropped);

    let mut morning: Vec<QueuedIntent> = Vec::new();
    let mut singles_vec: Vec<QueuedIntent> = Vec::new();
    for q in selected.into_iter() {
        if q.mode != "review" && is_morning_kind(&q.payload_kind) {
            morning.push(q);
        } else {
            singles_vec.push(q);
        }
    }

    if morning.len() < 2 {
        singles_vec.append(&mut morning);
    }

    GroupedReleaseResult {
        morning_batch: morning.iter().map(|q| q.id.clone()).collect(),
        singles: singles_vec.iter().map(|q| q.id.clone()).collect(),
        dropped,
    }
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

    #[must_use]
    fn fresh() -> parking_lot::MutexGuard<'static, ()> {
        let g = TEST_SERIAL.lock();
        STATE.lock().clear();
        g
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
            scheduled_for: 0.0,
            payload_kind: String::new(),
        }
    }

    fn configure(
        channel: &str,
        max_per_day: u32,
        min_gap_min: u32,
        boundary_only: bool,
        urgent_bypass: bool,
    ) {
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
        let _serial = fresh();
        let r = scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0]));
        assert_eq!(r, "no_posture_configured");
    }

    #[test]
    fn dedup_rejects_same_topic() {
        let _serial = fresh();
        configure("t", 10, 0, false, true);
        assert_eq!(
            scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0, 0.0])),
            "enqueued"
        );
        let r = scheduler_try_release("t".into());
        assert!(r.released.contains(&"a".to_string()));
        assert_eq!(
            scheduler_enqueue(mk("b", "t", "normal", vec![1.0, 0.0, 0.0])),
            "dedup"
        );
    }

    #[test]
    fn boundary_gate_holds_non_urgent() {
        let _serial = fresh();
        configure("t", 10, 0, true, true);
        scheduler_enqueue(mk("q", "t", "normal", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert!(
            r.released.is_empty(),
            "non-urgent should be held without boundary"
        );
        scheduler_mark_boundary("t".into(), 60_000.0);
        let r2 = scheduler_try_release("t".into());
        assert_eq!(r2.released, vec!["q".to_string()]);
    }

    #[test]
    fn urgent_bypasses_boundary() {
        let _serial = fresh();
        configure("t", 10, 0, true, true);
        scheduler_enqueue(mk("u", "t", "urgent", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released, vec!["u".to_string()]);
    }

    #[test]
    fn dnd_blocks_non_urgent() {
        let _serial = fresh();
        configure("t", 10, 0, false, true);
        scheduler_set_dnd("t".into(), true);
        scheduler_enqueue(mk("a", "t", "normal", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert!(r.released.is_empty());
    }

    #[test]
    fn dnd_allows_urgent_with_bypass() {
        let _serial = fresh();
        configure("t", 10, 0, false, true);
        scheduler_set_dnd("t".into(), true);
        scheduler_enqueue(mk("u", "t", "urgent", vec![1.0, 0.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released, vec!["u".to_string()]);
    }

    #[test]
    fn expired_intents_are_dropped() {
        let _serial = fresh();
        configure("t", 10, 0, false, true);
        let mut q = mk("old", "t", "normal", vec![1.0, 0.0]);
        q.expires_at = now_ms() - 1000.0;
        scheduler_enqueue(q);
        let r = scheduler_try_release("t".into());
        assert!(r.released.is_empty());
        assert!(r
            .dropped
            .iter()
            .any(|d| d.id == "old" && d.reason == "expired"));
    }

    #[test]
    fn rate_limit_blocks_extra_sends() {
        let _serial = fresh();
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
        let _serial = fresh();
        configure("t", 10, 0, false, true);
        scheduler_enqueue(mk("normal", "t", "normal", vec![1.0, 0.0]));
        scheduler_enqueue(mk("urgent", "t", "urgent", vec![0.0, 1.0]));
        let r = scheduler_try_release("t".into());
        assert_eq!(r.released.len(), 2);
        assert_eq!(r.released[0], "urgent");
    }

    fn morning(id: &str, ch: &str, kind: &str, axis: usize) -> QueuedIntent {
        let mut e = vec![0.0; 8];
        e[axis] = 1.0;
        let mut q = mk(id, ch, "normal", e);
        q.payload_kind = kind.into();
        q
    }

    #[test]
    fn morning_batch_forms_with_a_real_gap() {
        // Production postures have a 45+ min gap: the batch must still go out whole, as one slot.
        let _serial = fresh();
        configure("mb", 3, 45, false, true);
        scheduler_enqueue(morning("w", "mb", "weather_today", 0));
        scheduler_enqueue(morning("n", "mb", "news_today", 1));
        scheduler_enqueue(morning("c", "mb", "calendar_today_summary", 2));
        scheduler_enqueue(mk("other", "mb", "normal", {
            let mut e = vec![0.0; 8];
            e[3] = 1.0;
            e
        }));
        let r = scheduler_release_grouped("mb".into());
        assert_eq!(r.morning_batch.len(), 3);
        assert!(
            r.singles.is_empty(),
            "the single waits for the next gap, not right behind the batch"
        );
        assert!(scheduler_debug_state("mb".into()).contains("sent_today=1"));
    }

    #[test]
    fn the_daily_cap_rolls_over_at_local_midnight() {
        let now = now_ms();
        let off = local_offset_ms(now);
        // Local midnight today, in UTC ms.
        let local_midnight = ((now + off) / 86_400_000.0).floor() * 86_400_000.0 - off;
        assert_ne!(
            day_index(local_midnight - 60_000.0),
            day_index(local_midnight + 60_000.0)
        );
        if off.abs() >= 120_000.0 {
            // UTC midnight is no longer a boundary.
            let utc_midnight = (now / 86_400_000.0).floor() * 86_400_000.0;
            assert_eq!(
                day_index(utc_midnight - 60_000.0),
                day_index(utc_midnight + 60_000.0)
            );
        }
    }

    #[test]
    fn a_stale_same_topic_copy_is_dropped_at_release() {
        let _serial = fresh();
        configure("dd", 10, 0, false, true);
        scheduler_enqueue(morning("w1", "dd", "weather_today", 0));
        scheduler_enqueue(morning("w2", "dd", "weather_today", 0)); // hourly re-emit, queued first
        let r = scheduler_release_grouped("dd".into());
        assert_eq!(r.singles.len() + r.morning_batch.len(), 1);
        assert!(r.dropped.iter().any(|d| d.reason == "dedup"));
    }
}

#[cfg(test)]
mod tests_scheduled_fire {
    use super::*;

    #[must_use]
    fn clear_state() -> parking_lot::MutexGuard<'static, ()> {
        let g = TEST_SERIAL.lock();
        STATE.lock().clear();
        g
    }

    fn mk_intent(id: &str, channel: &str, scheduled_for: f64) -> QueuedIntent {
        QueuedIntent {
            id: id.into(),
            source: "test".into(),
            mode: "fyi".into(),
            urgency: "normal".into(),
            channel: channel.into(),
            topic_embedding: vec![0.0; 384],
            created_at: 0.0,
            expires_at: now_ms() + 3600_000.0,
            posture_weight: 1.0,
            source_weight: 1.0,
            scheduled_for,
            payload_kind: "".into(),
        }
    }

    #[test]
    fn enqueue_future_scheduled_goes_to_pending() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "sfire_a".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let future = now_ms() + 3600_000.0;
        let res = scheduler_enqueue(mk_intent("i1", "sfire_a", future));
        assert_eq!(res, "scheduled");
    }

    #[test]
    fn enqueue_zero_scheduled_takes_normal_path() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "sfire_b".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let res = scheduler_enqueue(mk_intent("i1", "sfire_b", 0.0));
        assert_eq!(res, "enqueued");
    }

    #[test]
    fn scheduled_cap_enforced_at_500() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "sfire_c".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let future = now_ms() + 3600_000.0;
        for i in 0..500 {
            let res =
                scheduler_enqueue(mk_intent(&format!("i{}", i), "sfire_c", future + i as f64));
            assert_eq!(res, "scheduled");
        }
        let res = scheduler_enqueue(mk_intent("i500", "sfire_c", future + 500.0));
        assert_eq!(res, "scheduled_cap");
    }

    #[test]
    fn drain_before_time_returns_empty() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "drain_a".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let future = now_ms() + 10.0 * 60_000.0;
        scheduler_enqueue(mk_intent("i1", "drain_a", future));
        let promoted = scheduler_drain_scheduled("drain_a".into());
        assert_eq!(promoted.len(), 0);
    }

    #[test]
    fn drain_after_time_promotes_to_queue() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "drain_b".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let soon = now_ms() + 50.0;
        scheduler_enqueue(mk_intent("i2", "drain_b", soon));
        std::thread::sleep(std::time::Duration::from_millis(80));
        let promoted = scheduler_drain_scheduled("drain_b".into());
        assert_eq!(promoted, vec!["i2".to_string()]);
    }

    #[test]
    fn drain_preserves_heap_order() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "drain_c".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let base = now_ms() + 50.0;
        scheduler_enqueue(mk_intent("late", "drain_c", base + 20.0));
        scheduler_enqueue(mk_intent("early", "drain_c", base));
        std::thread::sleep(std::time::Duration::from_millis(100));
        let promoted = scheduler_drain_scheduled("drain_c".into());
        assert_eq!(promoted, vec!["early".to_string(), "late".to_string()]);
    }

    #[test]
    fn grouped_release_batches_morning_kinds() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "grp_a".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let mut m1 = mk_intent("m1", "grp_a", 0.0);
        m1.payload_kind = "calendar_today_summary".into();
        m1.topic_embedding = vec![1.0; 384];
        let mut m2 = mk_intent("m2", "grp_a", 0.0);
        m2.payload_kind = "tasks_today".into();
        m2.topic_embedding = {
            let mut v = vec![0.0; 384];
            v[0] = 1.0;
            v
        };
        let mut m3 = mk_intent("m3", "grp_a", 0.0);
        m3.payload_kind = "goals_status".into();
        m3.topic_embedding = {
            let mut v = vec![0.0; 384];
            v[1] = 1.0;
            v
        };
        let mut s1 = mk_intent("s1", "grp_a", 0.0);
        s1.payload_kind = "meeting_prep".into();
        s1.topic_embedding = {
            let mut v = vec![0.0; 384];
            v[2] = 1.0;
            v
        };
        scheduler_enqueue(m1);
        scheduler_enqueue(m2);
        scheduler_enqueue(m3);
        scheduler_enqueue(s1);

        let r = scheduler_release_grouped("grp_a".into());
        assert_eq!(r.morning_batch.len(), 3);
        assert_eq!(r.singles.len(), 1);
        assert_eq!(r.singles[0], "s1");
    }

    #[test]
    fn grouped_release_demotes_single_morning_kind() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "grp_b".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let mut m1 = mk_intent("only", "grp_b", 0.0);
        m1.payload_kind = "calendar_today_summary".into();
        m1.topic_embedding = vec![1.0; 384];
        scheduler_enqueue(m1);
        let r = scheduler_release_grouped("grp_b".into());
        assert_eq!(r.morning_batch.len(), 0);
        assert_eq!(r.singles, vec!["only".to_string()]);
    }

    #[test]
    fn grouped_release_review_never_in_batch() {
        let _serial = clear_state();
        scheduler_configure(PostureParams {
            channel: "grp_c".into(),
            max_per_day: 10,
            min_gap_min: 0,
            heartbeat_min: 0,
            boundary_only: false,
            urgent_bypass: true,
        });
        let mut rv = mk_intent("rv", "grp_c", 0.0);
        rv.mode = "review".into();
        rv.payload_kind = "habit_anomaly".into();
        rv.topic_embedding = vec![1.0; 384];
        let mut m1 = mk_intent("m1", "grp_c", 0.0);
        m1.payload_kind = "tasks_today".into();
        m1.topic_embedding = {
            let mut v = vec![0.0; 384];
            v[0] = 1.0;
            v
        };
        let mut m2 = mk_intent("m2", "grp_c", 0.0);
        m2.payload_kind = "goals_status".into();
        m2.topic_embedding = {
            let mut v = vec![0.0; 384];
            v[1] = 1.0;
            v
        };
        scheduler_enqueue(rv);
        scheduler_enqueue(m1);
        scheduler_enqueue(m2);
        let r = scheduler_release_grouped("grp_c".into());
        assert!(!r.morning_batch.contains(&"rv".to_string()));
        assert!(r.singles.contains(&"rv".to_string()));
        assert_eq!(r.morning_batch.len(), 2);
    }
}
