// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Session Memory — Full port of src/memory/session.ts (algorithmic parts)
// Persistence (SQLite) stays in JS; Rust handles compression and state logic.

use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

const SESSION_TIMEOUT_MS: f64 = 30.0 * 60.0 * 1000.0; // 30 minutes
const MAX_RECENT_TURNS: usize = 6;
const MAX_SHORT_SUMMARY_CHARS: usize = 1600;
const COMPRESS_SENTENCE_LIMIT: usize = 200;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TurnEntry {
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub ts: f64, // milliseconds
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub current_goal: String,
    pub started_at_ms: f64,
    pub last_activity_ms: f64,
    pub turn_count: u32,
    pub short_summary: String,
    pub recent_turns: Vec<TurnEntry>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TouchResult {
    pub is_new: bool,
    pub session: SessionState,
    /// True if there was a timed-out session that should be reflected on
    pub had_expired: bool,
}

// ── Singleton ──────────────────────────────────────

lazy_static::lazy_static! {
    static ref CURRENT_SESSION: Mutex<Option<SessionState>> = Mutex::new(None);
}

// ── Session Lifecycle ──────────────────────────────

/// Start a new session. Returns the new session state.
#[napi]
pub fn session_start(session_id: String) -> SessionState {
    let now = now_ms_f64();
    let session = SessionState {
        session_id,
        current_goal: String::new(),
        started_at_ms: now,
        last_activity_ms: now,
        turn_count: 0,
        short_summary: String::new(),
        recent_turns: Vec::new(),
    };
    let mut current = CURRENT_SESSION.lock();
    *current = Some(session.clone());
    session
}

/// Get current session if not timed out.
#[napi]
pub fn session_get() -> Option<SessionState> {
    let current = CURRENT_SESSION.lock();
    let session = current.as_ref()?;

    let elapsed = now_ms_f64() - session.last_activity_ms;
    if elapsed > SESSION_TIMEOUT_MS {
        return None;
    }

    Some(session.clone())
}

/// Touch the session on each user message.
/// Returns whether it's a new session and the session state.
#[napi]
pub fn session_touch() -> TouchResult {
    let mut current = CURRENT_SESSION.lock();
    let now = now_ms_f64();

    if let Some(ref mut session) = *current {
        let elapsed = now - session.last_activity_ms;
        if elapsed <= SESSION_TIMEOUT_MS {
            session.last_activity_ms = now;
            session.turn_count += 1;
            return TouchResult {
                is_new: false,
                session: session.clone(),
                had_expired: false,
            };
        }
        // Timed out — will create new below
    }

    let had_expired = current.is_some();

    // Create new session (caller should provide proper ID via session_start)
    let session = SessionState {
        session_id: String::new(), // Caller should set via session_start
        current_goal: String::new(),
        started_at_ms: now,
        last_activity_ms: now,
        turn_count: 1,
        short_summary: String::new(),
        recent_turns: Vec::new(),
    };
    *current = Some(session.clone());

    TouchResult {
        is_new: true,
        session,
        had_expired,
    }
}

/// Restore a session from persisted state (loaded from SQLite by JS).
#[napi]
pub fn session_restore(session: SessionState) -> bool {
    let elapsed = now_ms_f64() - session.last_activity_ms;
    if elapsed > SESSION_TIMEOUT_MS {
        return false;
    }
    let mut current = CURRENT_SESSION.lock();
    *current = Some(session);
    true
}

/// Append a turn to the session buffer.
/// Compresses oldest turns when buffer exceeds limit.
#[napi]
pub fn session_append_turn(role: String, content: String) -> Option<SessionState> {
    let mut current = CURRENT_SESSION.lock();
    let session = current.as_mut()?;

    let truncated = if content.len() > 500 {
        format!("{}...", &content[..497])
    } else {
        content
    };

    session.recent_turns.push(TurnEntry {
        role,
        content: truncated,
        ts: now_ms_f64(),
    });

    // Compress when buffer exceeds limit
    if session.recent_turns.len() > MAX_RECENT_TURNS {
        compress_oldest_turns(session);
    }

    Some(session.clone())
}

/// Update session goal.
#[napi]
pub fn session_update_goal(goal: String) -> bool {
    let mut current = CURRENT_SESSION.lock();
    if let Some(ref mut session) = *current {
        session.current_goal = goal;
        return true;
    }
    false
}

/// End the current session.
#[napi]
pub fn session_end() -> Option<SessionState> {
    let mut current = CURRENT_SESSION.lock();
    current.take()
}

/// Check if session should trigger reflection (every 15 turns).
#[napi]
pub fn session_should_reflect() -> bool {
    let current = CURRENT_SESSION.lock();
    if let Some(ref session) = *current {
        return session.turn_count > 0 && session.turn_count % 15 == 0;
    }
    false
}

/// Get remaining minutes until session expires.
#[napi]
pub fn session_time_remaining() -> Option<f64> {
    let current = CURRENT_SESSION.lock();
    let session = current.as_ref()?;

    let elapsed = now_ms_f64() - session.last_activity_ms;
    let remaining = SESSION_TIMEOUT_MS - elapsed;

    if remaining > 0.0 {
        Some((remaining / 60000.0).floor())
    } else {
        Some(0.0)
    }
}

/// Check if we should warn about session expiry (5-8 minutes remaining).
#[napi]
pub fn session_should_warn_expiry() -> bool {
    if let Some(remaining) = session_time_remaining() {
        return remaining >= 5.0 && remaining <= 8.0;
    }
    false
}

// ── Short Summary / Context ────────────────────────

/// Get the rolling short summary for reflection input.
#[napi]
pub fn session_get_short_summary() -> String {
    let current = CURRENT_SESSION.lock();
    let session = match current.as_ref() {
        Some(s) => s,
        None => return String::new(),
    };

    let mut parts: Vec<String> = Vec::new();

    if !session.short_summary.is_empty() {
        parts.push(session.short_summary.clone());
    }

    if !session.recent_turns.is_empty() {
        let recent_text: Vec<String> = session
            .recent_turns
            .iter()
            .map(|t| {
                let role_label = if t.role == "user" { "User" } else { "AI" };
                let content_preview = if t.content.len() > 100 {
                    &t.content[..100]
                } else {
                    &t.content
                };
                format!("{}: {}", role_label, content_preview)
            })
            .collect();
        parts.push(recent_text.join("; "));
    }

    parts.join(" | ")
}

/// Get session summary for prompt injection.
#[napi]
pub fn session_get_summary() -> String {
    let current = CURRENT_SESSION.lock();
    let session = match current.as_ref() {
        Some(s) => s,
        None => return String::new(),
    };

    let now = now_ms_f64();
    let elapsed = now - session.last_activity_ms;
    if elapsed > SESSION_TIMEOUT_MS {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();

    if !session.current_goal.is_empty() {
        parts.push(format!("- Current goal: {}", session.current_goal));
    }

    if !session.short_summary.is_empty() {
        let summary_preview = if session.short_summary.len() > 300 {
            format!("...{}", &session.short_summary[session.short_summary.len() - 297..])
        } else {
            session.short_summary.clone()
        };
        parts.push(format!("- Session context: {}", summary_preview));
    }

    parts.push(format!("- Session turns: {}", session.turn_count));

    let elapsed_min = ((now - session.started_at_ms) / 60000.0).round() as u32;
    parts.push(format!("- Session duration: {} min", elapsed_min));

    if parts.is_empty() {
        return String::new();
    }

    format!("ACTIVE SESSION:\n{}", parts.join("\n"))
}

// ── Compression Logic ──────────────────────────────

fn compress_oldest_turns(session: &mut SessionState) {
    if session.recent_turns.len() <= 2 {
        return;
    }

    // Take the oldest 2 turns
    let oldest: Vec<TurnEntry> = session.recent_turns.drain(0..2).collect();
    let compressed: Vec<String> = oldest
        .iter()
        .map(|t| {
            let role_label = if t.role == "user" { "User" } else { "AI" };
            let content_preview = if t.content.len() > 100 {
                &t.content[..100]
            } else {
                &t.content
            };
            format!("{}: {}", role_label, content_preview)
        })
        .collect();
    let joined = compressed.join(" -> ");

    let sentence = heuristic_compress(&joined);

    if session.short_summary.is_empty() {
        session.short_summary = sentence;
    } else {
        session.short_summary = format!("{} {}", session.short_summary, sentence);
    }

    // Recompress if too long
    if session.short_summary.len() > MAX_SHORT_SUMMARY_CHARS {
        session.short_summary = recompress_summary(&session.short_summary);
    }
}

/// Heuristic compression: truncate and clean up text into ~50 tokens.
#[napi]
pub fn heuristic_compress_text(text: String) -> String {
    heuristic_compress(&text)
}

fn heuristic_compress(text: &str) -> String {
    let trimmed = if text.len() > COMPRESS_SENTENCE_LIMIT {
        &text[..COMPRESS_SENTENCE_LIMIT]
    } else {
        text
    };

    let last_period = trimmed.rfind('.');
    let last_question = trimmed.rfind('?');
    let last_break = match (last_period, last_question) {
        (Some(p), Some(q)) => Some(p.max(q)),
        (Some(p), None) => Some(p),
        (None, Some(q)) => Some(q),
        (None, None) => None,
    };

    let threshold = (COMPRESS_SENTENCE_LIMIT as f64 * 0.4) as usize;
    if let Some(brk) = last_break {
        if brk > threshold {
            return trimmed[..brk + 1].to_string();
        }
    }

    format!("{}.", trimmed.trim_end())
}

/// Recompress summary: keep last ~60% by sentences.
#[napi]
pub fn recompress_summary_text(summary: String) -> String {
    recompress_summary(&summary)
}

fn recompress_summary(summary: &str) -> String {
    let target = (MAX_SHORT_SUMMARY_CHARS as f64 * 0.6) as usize;

    // Split on sentence boundaries
    let sentences: Vec<&str> = summary
        .split_inclusive(|c: char| c == '.' || c == '!' || c == '?')
        .collect();

    let mut kept: Vec<&str> = Vec::new();
    let mut total_len: usize = 0;

    for sentence in sentences.iter().rev() {
        if total_len + sentence.len() > target {
            break;
        }
        kept.insert(0, sentence);
        total_len += sentence.len();
    }

    kept.join("").trim().to_string()
}

// ── Helpers ────────────────────────────────────────

fn now_ms_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
