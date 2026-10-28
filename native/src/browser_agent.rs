// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Native Rust module for browser agent acceleration.
// Handles: element scoring, video player state cache, action rate limiting,
// loop detection, and hover coordinate caching.
// All state is process-local (lazy_static); no I/O in this module.

use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

// ── Constants ────────────────────────────────

/// Max actions tracked per URL for loop detection
const MAX_ACTION_HISTORY: usize = 80;

/// How many times the same (action, selector, url) can repeat before loop is flagged
const LOOP_THRESHOLD: u32 = 3;

/// Max rate for any single action type per URL (actions / second)
const MAX_ACTIONS_PER_SECOND: u32 = 12;

/// Max video state entries in cache
const VIDEO_CACHE_MAX: usize = 16;

/// Max hover hints stored per origin (domain)
const HOVER_HINTS_MAX: usize = 256;

// ═══════════════════════════════════════════════════
// A. DOM ELEMENT SCORER
// ═══════════════════════════════════════════════════

/// A candidate DOM element passed in from TypeScript after browser_scan
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementCandidate {
    pub label: u32,
    pub tag: String,
    pub text: String,
    pub class_name: String,
    pub aria_label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Scored result returned to TypeScript
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoredElement {
    pub label: u32,
    pub score: f64,
    pub reason: String,
}

/// Score a list of DOM element candidates against a natural-language description.
/// Returns candidates sorted best-first with a confidence score (0.0–1.0).
///
/// Scoring factors:
/// 1. Token overlap between description and (text + aria_label + class_name)
/// 2. Tag affinity bonuses (button/a for action verbs, input for "type/fill")
/// 3. YouTube-specific class bonuses (.ytp-* selector matches)
/// 4. Size/position bias (prefer larger, more central elements)
/// 5. Exact text match bonus
#[napi]
pub fn score_element_candidates(
    description: String,
    candidates: Vec<ElementCandidate>,
    viewport_width: Option<f64>,
    viewport_height: Option<f64>,
) -> Vec<ScoredElement> {
    let vw = viewport_width.unwrap_or(1280.0);
    let vh = viewport_height.unwrap_or(800.0);
    let desc_lower = description.to_lowercase();
    let desc_tokens: Vec<&str> = desc_lower.split_whitespace().collect();

    // Determine target tag hints from description verbs
    let prefer_button = desc_lower.contains("click")
        || desc_lower.contains("press")
        || desc_lower.contains("button")
        || desc_lower.contains("toggle")
        || desc_lower.contains("tap");
    let prefer_input = desc_lower.contains("type")
        || desc_lower.contains("fill")
        || desc_lower.contains("enter")
        || desc_lower.contains("input")
        || desc_lower.contains("search");
    let prefer_link = desc_lower.contains("link")
        || desc_lower.contains("navigate")
        || desc_lower.contains("open");

    let mut scored: Vec<ScoredElement> = candidates
        .iter()
        .map(|el| {
            let mut score = 0.0f64;
            let mut reasons: Vec<&str> = Vec::new();

            let el_text = el.text.to_lowercase();
            let el_class = el.class_name.to_lowercase();
            let el_aria = el.aria_label.to_lowercase();
            let el_tag = el.tag.to_lowercase();

            // 1. Token overlap with visible text
            let text_tokens: Vec<&str> = el_text.split_whitespace().collect();
            let aria_tokens: Vec<&str> = el_aria.split_whitespace().collect();
            let class_tokens: Vec<&str> = el_class
                .split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty())
                .collect();

            let all_tokens: Vec<&str> = text_tokens
                .iter()
                .chain(aria_tokens.iter())
                .chain(class_tokens.iter())
                .copied()
                .collect();

            let mut overlap = 0u32;
            for dt in &desc_tokens {
                if all_tokens
                    .iter()
                    .any(|et| et.contains(dt) || dt.contains(*et))
                {
                    overlap += 1;
                }
            }
            if !desc_tokens.is_empty() {
                let overlap_ratio = overlap as f64 / desc_tokens.len() as f64;
                score += overlap_ratio * 0.40;
                if overlap_ratio > 0.0 {
                    reasons.push("token_overlap");
                }
            }

            // 2. Exact text match bonus
            if el_text == desc_lower || el_aria == desc_lower {
                score += 0.25;
                reasons.push("exact_match");
            } else if el_text.contains(&desc_lower) || el_aria.contains(&desc_lower) {
                score += 0.15;
                reasons.push("contains_desc");
            }

            // 3. Tag affinity
            if prefer_button
                && (el_tag == "button" || el_class.contains("btn") || el_class.contains("button"))
            {
                score += 0.12;
                reasons.push("button_tag");
            }
            if prefer_input && (el_tag == "input" || el_tag == "textarea") {
                score += 0.12;
                reasons.push("input_tag");
            }
            if prefer_link && el_tag == "a" {
                score += 0.08;
                reasons.push("link_tag");
            }

            // 4. YouTube .ytp-* class bonus — these are exactly what we want for player controls
            if desc_lower.contains("mute") && el_class.contains("ytp-mute") {
                score += 0.30;
                reasons.push("ytp_mute_class");
            }
            if (desc_lower.contains("caption") || desc_lower.contains("subtitle"))
                && el_class.contains("ytp-subtitles")
            {
                score += 0.30;
                reasons.push("ytp_subtitle_class");
            }
            if (desc_lower.contains("play") || desc_lower.contains("pause"))
                && el_class.contains("ytp-play")
            {
                score += 0.30;
                reasons.push("ytp_play_class");
            }
            if desc_lower.contains("fullscreen") && el_class.contains("ytp-fullscreen") {
                score += 0.30;
                reasons.push("ytp_fullscreen_class");
            }
            if el_class.contains("ytp-") {
                score += 0.05;
                reasons.push("ytp_class");
            }

            // 5. Position/size bias — prefer elements in the lower 30% of the viewport
            // (where YouTube controls live) if description mentions video controls
            let is_video_query = desc_lower.contains("video")
                || desc_lower.contains("player")
                || desc_lower.contains("mute")
                || desc_lower.contains("caption")
                || desc_lower.contains("playback");

            if is_video_query {
                let y_ratio = el.y / vh;
                if y_ratio > 0.65 {
                    score += 0.08; // lower portion of screen
                    reasons.push("lower_position");
                }
            }

            // Prefer larger elements (more likely to be the main interactive target)
            let area = el.width * el.height;
            if area > 1000.0 {
                score += 0.03;
            } else if area < 16.0 {
                score -= 0.05; // tiny elements are rarely the target
            }

            // Penalize elements outside typical viewport
            if el.x < 0.0 || el.y < 0.0 || el.x > vw || el.y > vh {
                score -= 0.20;
                reasons.push("offscreen");
            }

            let reason_str = if reasons.is_empty() {
                "no_match".to_string()
            } else {
                reasons.join("+")
            };

            ScoredElement {
                label: el.label,
                score: score.clamp(0.0, 1.0),
                reason: reason_str,
            }
        })
        .collect();

    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}

// ═══════════════════════════════════════════════════
// B. VIDEO PLAYER STATE CACHE
// ═══════════════════════════════════════════════════

#[derive(Default)]
struct VideoStateCache {
    entries: Vec<(String, String, u64)>, // (url, state_json, timestamp_ms)
    hits: u64,
    misses: u64,
    evictions: u64,
}

lazy_static! {
    static ref VIDEO_CACHE: Mutex<VideoStateCache> = Mutex::new(VideoStateCache::default());
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Store video player state after an action (mute, seek, play, etc.)
/// Keyed by the full tab URL. Evicts oldest entry when capacity is reached.
#[napi]
pub fn set_video_player_state(url: String, state_json: String) {
    let mut cache = VIDEO_CACHE.lock();
    // Update if key exists
    if let Some(entry) = cache.entries.iter_mut().find(|(u, _, _)| *u == url) {
        entry.1 = state_json;
        entry.2 = now_ms();
        return;
    }
    // Evict oldest
    if cache.entries.len() >= VIDEO_CACHE_MAX {
        cache.entries.sort_by_key(|(_, _, ts)| *ts);
        cache.entries.remove(0);
        cache.evictions += 1;
    }
    cache.entries.push((url, state_json, now_ms()));
}

/// Retrieve cached video player state. Returns None if not cached or stale (>10s).
/// TypeScript should call page.evaluate() only when this returns None.
#[napi]
pub fn get_video_player_state(url: String) -> Option<String> {
    let mut cache = VIDEO_CACHE.lock();
    let now = now_ms();
    // Clone out what we need before any mutable borrow
    let found = cache
        .entries
        .iter()
        .find(|(u, _, _)| *u == url)
        .map(|(_, state, ts)| (state.clone(), *ts));

    match found {
        Some((state, ts)) if now - ts < 10_000 => {
            cache.hits += 1;
            Some(state)
        }
        _ => {
            cache.misses += 1;
            None
        }
    }
}

/// Invalidate video state cache for a URL (call on navigation or page reload)
#[napi]
pub fn invalidate_video_state(url: String) {
    let mut cache = VIDEO_CACHE.lock();
    cache.entries.retain(|(u, _, _)| *u != url);
}

/// Get cache statistics as JSON
#[napi]
pub fn get_video_cache_stats() -> String {
    let cache = VIDEO_CACHE.lock();
    serde_json::json!({
        "entries": cache.entries.len(),
        "hits": cache.hits,
        "misses": cache.misses,
        "evictions": cache.evictions,
        "hit_rate": if cache.hits + cache.misses > 0 {
            cache.hits as f64 / (cache.hits + cache.misses) as f64
        } else { 0.0 }
    })
    .to_string()
}

// ═══════════════════════════════════════════════════
// C. BROWSER ACTION RATE LIMITER + LOOP DETECTOR
// ═══════════════════════════════════════════════════

/// One action record in the history ring buffer
#[derive(Clone, Serialize)]
struct ActionRecord {
    action_type: String,
    url: String,
    selector: String,
    success: bool,
    timestamp_ms: u64,
}

#[derive(Default)]
struct ActionState {
    history: Vec<ActionRecord>,
    /// rate limit windows: (action_type+url) -> (count, window_start_ms)
    rate_windows: HashMap<String, (u32, u64)>,
    /// loop counters: (action_type+selector+url) -> consecutive_count
    loop_counters: HashMap<String, u32>,
    loops_detected: u64,
    throttles: u64,
}

lazy_static! {
    static ref ACTION_STATE: Mutex<ActionState> = Mutex::new(ActionState::default());
}

/// Check if an action is within the rate limit for the given URL.
/// Returns false (throttled) if the action type has exceeded MAX_ACTIONS_PER_SECOND on this URL.
#[napi]
pub fn check_browser_action_rate_limit(action_type: String, url: String) -> bool {
    let now = now_ms();
    let key = format!("{}|{}", action_type, normalise_url(&url));
    let mut state = ACTION_STATE.lock();
    let entry = state.rate_windows.entry(key).or_insert((0, now));

    if now - entry.1 > 1000 {
        entry.0 = 0;
        entry.1 = now;
    }

    if entry.0 >= MAX_ACTIONS_PER_SECOND {
        state.throttles += 1;
        return false;
    }
    entry.0 += 1;
    true
}

/// Record an executed browser action. Call this after every tool execution.
/// Used by the loop detector and for stats.
#[napi]
pub fn record_browser_action(action_type: String, url: String, selector: String, success: bool) {
    let norm_url = normalise_url(&url);
    let loop_key = format!("{}|{}|{}", action_type, selector, norm_url);
    let mut state = ACTION_STATE.lock();

    // Update loop counter
    if !selector.is_empty() {
        let counter = state.loop_counters.entry(loop_key).or_insert(0);
        if success {
            *counter = 0; // success resets the loop counter
        } else {
            *counter += 1;
        }
    }

    // Append to history ring buffer
    if state.history.len() >= MAX_ACTION_HISTORY {
        state.history.remove(0);
    }
    state.history.push(ActionRecord {
        action_type,
        url: norm_url,
        selector,
        success,
        timestamp_ms: now_ms(),
    });
}

/// Returns true if the agent appears to be looping on the same action.
/// Trigger: same (action_type, selector, normalised_url) failed ≥ LOOP_THRESHOLD times
/// consecutively without a successful action in between.
#[napi]
pub fn detect_action_loop(action_type: String, selector: String, url: String) -> bool {
    let loop_key = format!("{}|{}|{}", action_type, selector, normalise_url(&url));
    let mut state = ACTION_STATE.lock();
    let count = state.loop_counters.get(&loop_key).copied().unwrap_or(0);
    if count >= LOOP_THRESHOLD {
        state.loops_detected += 1;
        true
    } else {
        false
    }
}

/// Reset loop counter for a selector (call when agent intentionally switches strategy)
#[napi]
pub fn reset_action_loop(action_type: String, selector: String, url: String) {
    let loop_key = format!("{}|{}|{}", action_type, selector, normalise_url(&url));
    let mut state = ACTION_STATE.lock();
    state.loop_counters.remove(&loop_key);
}

/// Get action statistics as a JSON string
#[napi]
pub fn get_browser_action_stats() -> String {
    let state = ACTION_STATE.lock();
    let total = state.history.len();
    let successes = state.history.iter().filter(|r| r.success).count();
    serde_json::json!({
        "total_recorded": total,
        "success_count": successes,
        "failure_count": total - successes,
        "loops_detected": state.loops_detected,
        "throttles": state.throttles,
        "success_rate": if total > 0 { successes as f64 / total as f64 } else { 0.0 }
    })
    .to_string()
}

// ═══════════════════════════════════════════════════
// D. HOVER COORDINATE CACHE (PREDICTOR)
// ═══════════════════════════════════════════════════

/// A cached hover coordinate with confidence score
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoverHint {
    pub x: f64,
    pub y: f64,
    /// 0.0–1.0: fraction of past hover attempts at this (url, selector) that succeeded
    pub confidence: f64,
}

#[derive(Default)]
struct HoverEntry {
    x: f64,
    y: f64,
    successes: u32,
    failures: u32,
}

lazy_static! {
    /// Maps "origin|selector" → HoverEntry
    static ref HOVER_CACHE: Mutex<HashMap<String, HoverEntry>> = Mutex::new(HashMap::new());
}

fn hover_key(url: &str, selector: &str) -> String {
    format!("{}|{}", url_origin(url), selector)
}

/// Look up cached hover coordinates for a (url, selector) pair.
/// Returns None if not cached or confidence < 0.3.
#[napi]
pub fn get_hover_hint(url: String, selector: String) -> Option<HoverHint> {
    let key = hover_key(&url, &selector);
    let cache = HOVER_CACHE.lock();
    cache.get(&key).and_then(|e| {
        let total = (e.successes + e.failures) as f64;
        if total < 1.0 {
            return None;
        }
        let confidence = e.successes as f64 / total;
        if confidence < 0.30 {
            return None;
        }
        Some(HoverHint {
            x: e.x,
            y: e.y,
            confidence,
        })
    })
}

/// Record a successful hover. Updates cached coordinates with exponential moving average.
#[napi]
pub fn record_hover_success(url: String, selector: String, x: f64, y: f64) {
    let key = hover_key(&url, &selector);
    let mut cache = HOVER_CACHE.lock();

    // Evict if at capacity (remove lowest-confidence entry)
    if cache.len() >= HOVER_HINTS_MAX && !cache.contains_key(&key) {
        let worst = cache
            .iter()
            .min_by(|(_, a), (_, b)| {
                let ca = a.successes as f64 / (a.successes + a.failures).max(1) as f64;
                let cb = b.successes as f64 / (b.successes + b.failures).max(1) as f64;
                ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(k, _)| k.clone());
        if let Some(k) = worst {
            cache.remove(&k);
        }
    }

    let entry = cache.entry(key).or_insert(HoverEntry {
        x,
        y,
        successes: 0,
        failures: 0,
    });
    // EMA update: blend new coordinates 20% toward recorded coords
    entry.x = entry.x * 0.80 + x * 0.20;
    entry.y = entry.y * 0.80 + y * 0.20;
    entry.successes += 1;
}

/// Record a failed hover attempt.
#[napi]
pub fn record_hover_failure(url: String, selector: String) {
    let key = hover_key(&url, &selector);
    let mut cache = HOVER_CACHE.lock();
    let entry = cache.entry(key).or_insert(HoverEntry {
        x: 0.0,
        y: 0.0,
        successes: 0,
        failures: 0,
    });
    entry.failures += 1;
}

// ── Internal helpers ─────────────────────────────

/// Normalise URL for key purposes: strip query params + fragment, keep scheme+host+path
fn normalise_url(url: &str) -> String {
    if let Some(pos) = url.find('?') {
        url[..pos].to_string()
    } else if let Some(pos) = url.find('#') {
        url[..pos].to_string()
    } else {
        url.to_string()
    }
}

/// Extract origin (scheme + host) from a URL
fn url_origin(url: &str) -> String {
    // Find end of "scheme://host" portion
    if let Some(after_scheme) = url.find("://") {
        let rest = &url[after_scheme + 3..];
        let end = rest.find('/').unwrap_or(rest.len());
        format!("{}://{}", &url[..after_scheme], &rest[..end])
    } else {
        url.to_string()
    }
}
