// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Proactive Intent — Rust-side validator for the ProactiveIntent shape.
// Called from TypeScript to validate intents before enqueue; returns
// a structured result that the TS layer can reflect into debug logs.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RustProactiveIntent {
    pub id: String,
    pub source: String,
    pub mode: String,
    pub urgency: String,
    pub channel_preference: String,
    pub topic: String,
    pub topic_embedding: Vec<f64>,
    pub payload_kind: String,
    pub has_suggested_action: bool,
    pub created_at: f64,
    pub expires_at: f64,
}

#[napi(object)]
pub struct RustValidationResult {
    pub ok: bool,
    pub error: Option<String>,
}

const VALID_SOURCES: &[&str] = &[
    "latent_topic_monitor",
    "memory_anticipation",
    "calendar_fact_check",
    "calendar_fusion",
    "stale_todo",
    "meeting_followup",
    "habit_anomaly",
    "env_context",
    "long_task_status",
    "convex_notification",
];
const VALID_MODES: &[&str] = &["fyi", "question", "review"];
const VALID_URGENCIES: &[&str] = &["urgent", "normal", "ambient"];

#[napi]
pub fn validate_intent_rust(intent: RustProactiveIntent) -> RustValidationResult {
    if intent.id.is_empty() {
        return RustValidationResult {
            ok: false,
            error: Some("id missing".into()),
        };
    }
    if !VALID_SOURCES.contains(&intent.source.as_str()) {
        return RustValidationResult {
            ok: false,
            error: Some(format!("bad source: {}", intent.source)),
        };
    }
    if !VALID_MODES.contains(&intent.mode.as_str()) {
        return RustValidationResult {
            ok: false,
            error: Some(format!("bad mode: {}", intent.mode)),
        };
    }
    if !VALID_URGENCIES.contains(&intent.urgency.as_str()) {
        return RustValidationResult {
            ok: false,
            error: Some(format!("bad urgency: {}", intent.urgency)),
        };
    }
    if intent.topic_embedding.len() != 384 {
        return RustValidationResult {
            ok: false,
            error: Some(format!(
                "embedding must be length 384, got {}",
                intent.topic_embedding.len()
            )),
        };
    }
    if intent.payload_kind.is_empty() {
        return RustValidationResult {
            ok: false,
            error: Some("payload.kind missing".into()),
        };
    }
    if intent.expires_at <= intent.created_at {
        return RustValidationResult {
            ok: false,
            error: Some("expiresAt <= createdAt".into()),
        };
    }
    if intent.mode == "review" && !intent.has_suggested_action {
        return RustValidationResult {
            ok: false,
            error: Some("review mode requires suggestedAction".into()),
        };
    }
    RustValidationResult {
        ok: true,
        error: None,
    }
}
