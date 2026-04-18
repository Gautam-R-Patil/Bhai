// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Model Router — Rust port via napi-rs
// Multi-strategy routing engine that selects the optimal LLM model
// based on task type, message analysis, conversation context, and
// adaptive performance tracking.

use std::collections::HashMap;
use std::time::Instant;

use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

// ── Model Registry ───────────────────────────

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Speed {
    Slow,
    Medium,
    Fast,
    VeryFast,
    UltraFast,
}

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provider {
    Anthropic,
    Google,
    Openai,
    Amazon,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub input_cost_per_1m: f64,
    pub output_cost_per_1m: f64,
    pub tier: u32,
    pub speed: Speed,
    pub strengths: Vec<String>,
    pub max_tokens: u32,
    pub supports_tools: bool,
    pub supports_parallel_tools: bool,
    pub supports_vision: bool,
    pub provider: Provider,
}

fn build_model_registry() -> HashMap<String, ModelInfo> {
    let mut m = HashMap::new();

    // ── Tier 0: Premium (complex reasoning, deep emotions) ──
    m.insert("anthropic/claude-opus-4.6".into(), ModelInfo {
        id: "anthropic/claude-opus-4.6".into(),
        display_name: "Opus 4.6".into(),
        input_cost_per_1m: 5.00,
        output_cost_per_1m: 25.00,
        tier: 0,
        speed: Speed::Slow,
        strengths: vec!["creative".into(), "emotional".into(), "nuanced".into(), "complex_reasoning".into(), "error_recovery".into()],
        max_tokens: 16384,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Anthropic,
    });

    // ── Tier 2: User-facing mid (emotional conversations) ──
    m.insert("anthropic/claude-sonnet-4.6".into(), ModelInfo {
        id: "anthropic/claude-sonnet-4.6".into(),
        display_name: "Sonnet 4.6".into(),
        input_cost_per_1m: 3.00,
        output_cost_per_1m: 15.00,
        tier: 2,
        speed: Speed::Medium,
        strengths: vec!["conversational".into(), "balanced".into(), "personality".into(), "writing".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Anthropic,
    });

    m.insert("anthropic/claude-sonnet-4.5".into(), ModelInfo {
        id: "anthropic/claude-sonnet-4.5".into(),
        display_name: "Sonnet 4.5".into(),
        input_cost_per_1m: 3.00,
        output_cost_per_1m: 15.00,
        tier: 2,
        speed: Speed::Medium,
        strengths: vec!["agentic".into(), "conversational".into(), "tool_use".into(), "personality".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Anthropic,
    });

    // ── Tier 3: Mid-tier (research, complex tools) ──
    m.insert("google/gemini-3.1-pro-preview-customtools".into(), ModelInfo {
        id: "google/gemini-3.1-pro-preview-customtools".into(),
        display_name: "Gemini 3.1 Pro".into(),
        input_cost_per_1m: 2.00,
        output_cost_per_1m: 12.00,
        tier: 3,
        speed: Speed::Fast,
        strengths: vec!["tool_use".into(), "multimodal".into(), "long_context".into(), "agentic".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: false,
        supports_vision: true,
        provider: Provider::Google,
    });

    // ── Tier 4: Background mid (tool loops, sub-agents) ──
    m.insert("amazon/nova-pro-v1".into(), ModelInfo {
        id: "amazon/nova-pro-v1".into(),
        display_name: "Nova Pro".into(),
        input_cost_per_1m: 0.80,
        output_cost_per_1m: 3.20,
        tier: 4,
        speed: Speed::Fast,
        strengths: vec!["tool_use".into(), "balanced".into(), "agentic".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Amazon,
    });

    // ── Tier 5: User-facing light / background capable ──
    m.insert("anthropic/claude-haiku-4.5".into(), ModelInfo {
        id: "anthropic/claude-haiku-4.5".into(),
        display_name: "Haiku 4.5".into(),
        input_cost_per_1m: 1.00,
        output_cost_per_1m: 5.00,
        tier: 5,
        speed: Speed::Fast,
        strengths: vec!["classification".into(), "simple_qa".into(), "fast_response".into(), "ack".into(), "conversational".into()],
        max_tokens: 4096,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Anthropic,
    });

    m.insert("google/gemini-2.5-flash".into(), ModelInfo {
        id: "google/gemini-2.5-flash".into(),
        display_name: "Gemini 2.5 Flash".into(),
        input_cost_per_1m: 0.30,
        output_cost_per_1m: 2.50,
        tier: 5,
        speed: Speed::Fast,
        strengths: vec!["agentic".into(), "tool_use".into(), "reasoning".into(), "balanced".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Google,
    });

    // ── Tier 6: Cheap background (synthesis, bulk) ──
    m.insert("google/gemini-3-flash-preview".into(), ModelInfo {
        id: "google/gemini-3-flash-preview".into(),
        display_name: "Gemini 3 Flash".into(),
        input_cost_per_1m: 0.50,
        output_cost_per_1m: 3.00,
        tier: 6,
        speed: Speed::VeryFast,
        strengths: vec!["synthesis".into(), "bulk_processing".into(), "data_extraction".into(), "summarization".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Google,
    });

    // ── Tier 7: Ultra-cheap background ──
    m.insert("google/gemini-3.1-flash-lite-preview".into(), ModelInfo {
        id: "google/gemini-3.1-flash-lite-preview".into(),
        display_name: "Flash Lite".into(),
        input_cost_per_1m: 0.25,
        output_cost_per_1m: 1.50,
        tier: 7,
        speed: Speed::UltraFast,
        strengths: vec!["audio_analysis".into(), "video_analysis".into(), "transcription".into()],
        max_tokens: 2048,
        supports_tools: false,
        supports_parallel_tools: false,
        supports_vision: true,
        provider: Provider::Google,
    });

    m.insert("google/gemini-2.0-flash-001".into(), ModelInfo {
        id: "google/gemini-2.0-flash-001".into(),
        display_name: "Gemini 2.0 Flash".into(),
        input_cost_per_1m: 0.10,
        output_cost_per_1m: 0.40,
        tier: 7,
        speed: Speed::Fast,
        strengths: vec!["fast_response".into(), "tool_use".into(), "classification".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Google,
    });

    m.insert("google/gemini-2.5-flash-lite".into(), ModelInfo {
        id: "google/gemini-2.5-flash-lite".into(),
        display_name: "Gemini 2.5 Flash Lite".into(),
        input_cost_per_1m: 0.10,
        output_cost_per_1m: 0.40,
        tier: 7,
        speed: Speed::Fast,
        strengths: vec!["bulk_processing".into(), "fast_response".into(), "cheap_tools".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Google,
    });

    // ── Tier 8-9: Cheapest background agents ──
    m.insert("amazon/nova-lite-v1".into(), ModelInfo {
        id: "amazon/nova-lite-v1".into(),
        display_name: "Nova Lite".into(),
        input_cost_per_1m: 0.06,
        output_cost_per_1m: 0.24,
        tier: 8,
        speed: Speed::VeryFast,
        strengths: vec!["bulk_processing".into(), "fast_response".into(), "classification".into(), "simple_tools".into()],
        max_tokens: 8192,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: true,
        provider: Provider::Amazon,
    });

    m.insert("amazon/nova-micro-v1".into(), ModelInfo {
        id: "amazon/nova-micro-v1".into(),
        display_name: "Nova Micro".into(),
        input_cost_per_1m: 0.04,
        output_cost_per_1m: 0.14,
        tier: 9,
        speed: Speed::UltraFast,
        strengths: vec!["classification".into(), "fast_response".into(), "cheapest".into()],
        max_tokens: 4096,
        supports_tools: true,
        supports_parallel_tools: true,
        supports_vision: false,
        provider: Provider::Amazon,
    });

    m
}

lazy_static! {
    static ref MODEL_REGISTRY: HashMap<String, ModelInfo> = build_model_registry();
}

// ── Signals Cache ────────────────────────────
// Cache signal extraction results to avoid redundant regex analysis.
// Keyed by (message_hash, iteration, error_count, has_media).
struct SignalsCacheEntry {
    signals: Signals,
    timestamp: Instant,
}

const SIGNALS_CACHE_TTL_MS: u128 = 300_000; // 5 minutes
const SIGNALS_CACHE_MAX: usize = 50;

lazy_static! {
    static ref SIGNALS_CACHE: Mutex<HashMap<u64, SignalsCacheEntry>> = Mutex::new(HashMap::new());
}

fn signals_cache_key(message: &str, iteration: i32, error_count: i32, has_media: bool) -> u64 {
    // FNV-1a hash
    let mut h: u64 = 0xcbf29ce484222325;
    for b in message.bytes().take(300) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^= iteration as u64;
    h = h.wrapping_mul(0x100000001b3);
    h ^= error_count as u64;
    h = h.wrapping_mul(0x100000001b3);
    if has_media { h ^= 0xff; }
    h
}

/// Get model info from the registry by model ID
#[napi]
pub fn get_model_info(model_id: String) -> Option<ModelInfo> {
    MODEL_REGISTRY.get(&model_id).cloned()
}

/// Get all model IDs in the registry
#[napi]
pub fn get_all_model_ids() -> Vec<String> {
    MODEL_REGISTRY.keys().cloned().collect()
}

// ── Task Types ───────────────────────────────

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskType {
    Classify,
    SimpleChat,
    ComplexChat,
    ToolLoop,
    Coding,
    Planning,
    Synthesis,
    FinalAnswer,
    Research,
    SubAgent,
    AudioAnalysis,
    Vision,
    FirstIteration,
    ErrorRecovery,
}

fn task_type_to_str(t: &TaskType) -> &'static str {
    match *t {
        TaskType::Classify => "classify",
        TaskType::SimpleChat => "simple_chat",
        TaskType::ComplexChat => "complex_chat",
        TaskType::ToolLoop => "tool_loop",
        TaskType::Coding => "coding",
        TaskType::Planning => "planning",
        TaskType::Synthesis => "synthesis",
        TaskType::FinalAnswer => "final_answer",
        TaskType::Research => "research",
        TaskType::SubAgent => "sub_agent",
        TaskType::AudioAnalysis => "audio_analysis",
        TaskType::Vision => "vision",
        TaskType::FirstIteration => "first_iteration",
        TaskType::ErrorRecovery => "error_recovery",
    }
}

// ── Thinking Level ──────────────────────────

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThinkingLevel {
    Off,
    Low,
    Medium,
    High,
    Max,
}

// ── Mood ─────────────────────────────────────

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mood {
    Casual,
    Focused,
    Emotional,
    Urgent,
}

// ── Conversation Context ─────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationContext {
    pub recent_scores: Vec<i32>,
    pub current_mood: Mood,
    pub escalated_this_session: bool,
    pub dominant_task_type: Option<TaskType>,
    pub tool_calls_this_session: i32,
    pub turns_this_session: i32,
    pub last_model_used: Option<String>,
    pub session_cost_usd: f64,
    pub tool_error_count: i32,
    pub last_tool_success_rate: f64,
}

impl Default for ConversationContext {
    fn default() -> Self {
        Self {
            recent_scores: Vec::new(),
            current_mood: Mood::Casual,
            escalated_this_session: false,
            dominant_task_type: None,
            tool_calls_this_session: 0,
            turns_this_session: 0,
            last_model_used: None,
            session_cost_usd: 0.0,
            tool_error_count: 0,
            last_tool_success_rate: 1.0,
        }
    }
}

lazy_static! {
    static ref CONVERSATION_CTX: Mutex<ConversationContext> = Mutex::new(ConversationContext::default());
}

#[napi]
pub fn get_conversation_context() -> ConversationContext {
    CONVERSATION_CTX.lock().clone()
}

#[napi]
pub fn update_conversation_context(updates_json: String) -> napi::Result<()> {
    let updates: serde_json::Value = serde_json::from_str(&updates_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, format!("Invalid JSON: {}", e)))?;
    let mut ctx = CONVERSATION_CTX.lock();
    if let Some(obj) = updates.as_object() {
        if let Some(v) = obj.get("recent_scores") {
            if let Ok(scores) = serde_json::from_value::<Vec<i32>>(v.clone()) {
                ctx.recent_scores = scores;
            }
        }
        if let Some(v) = obj.get("current_mood") {
            if let Ok(mood) = serde_json::from_value::<Mood>(v.clone()) {
                ctx.current_mood = mood;
            }
        }
        if let Some(v) = obj.get("escalated_this_session") {
            if let Some(b) = v.as_bool() {
                ctx.escalated_this_session = b;
            }
        }
        if let Some(v) = obj.get("dominant_task_type") {
            if v.is_null() {
                ctx.dominant_task_type = None;
            } else if let Ok(tt) = serde_json::from_value::<TaskType>(v.clone()) {
                ctx.dominant_task_type = Some(tt);
            }
        }
        if let Some(v) = obj.get("tool_calls_this_session") {
            if let Some(n) = v.as_i64() {
                ctx.tool_calls_this_session = n as i32;
            }
        }
        if let Some(v) = obj.get("turns_this_session") {
            if let Some(n) = v.as_i64() {
                ctx.turns_this_session = n as i32;
            }
        }
        if let Some(v) = obj.get("last_model_used") {
            if v.is_null() {
                ctx.last_model_used = None;
            } else if let Some(s) = v.as_str() {
                ctx.last_model_used = Some(s.to_string());
            }
        }
        if let Some(v) = obj.get("session_cost_usd") {
            if let Some(n) = v.as_f64() {
                ctx.session_cost_usd = n;
            }
        }
        if let Some(v) = obj.get("tool_error_count") {
            if let Some(n) = v.as_i64() {
                ctx.tool_error_count = n as i32;
            }
        }
        if let Some(v) = obj.get("last_tool_success_rate") {
            if let Some(n) = v.as_f64() {
                ctx.last_tool_success_rate = n;
            }
        }
    }
    Ok(())
}

#[napi]
pub fn reset_conversation_context() {
    let mut ctx = CONVERSATION_CTX.lock();
    *ctx = ConversationContext::default();
}

// ── Adaptive Performance Tracking ────────────

const CIRCUIT_BREAKER_THRESHOLD: u32 = 3;
// Staggered cooldowns per provider to prevent ALL models from being blocked simultaneously
// during brief network outages. Shorter cooldowns for primary providers.
const CIRCUIT_BREAKER_COOLDOWN_MS_DEFAULT: u64 = 120 * 1000; // 2 minutes default
const CIRCUIT_BREAKER_COOLDOWN_ANTHROPIC: u64 = 60 * 1000;   // 60 seconds for Anthropic
const CIRCUIT_BREAKER_COOLDOWN_GOOGLE: u64 = 90 * 1000;      // 90 seconds for Google
const CIRCUIT_BREAKER_COOLDOWN_AMAZON: u64 = 120 * 1000;     // 120 seconds for Amazon

fn get_circuit_breaker_cooldown(model_id: &str) -> u64 {
    if model_id.starts_with("anthropic/") {
        CIRCUIT_BREAKER_COOLDOWN_ANTHROPIC
    } else if model_id.starts_with("google/") {
        CIRCUIT_BREAKER_COOLDOWN_GOOGLE
    } else if model_id.starts_with("amazon/") {
        CIRCUIT_BREAKER_COOLDOWN_AMAZON
    } else {
        CIRCUIT_BREAKER_COOLDOWN_MS_DEFAULT
    }
}

#[derive(Debug, Clone, Default)]
struct TaskTypeStats {
    calls: u64,
    latency_ms: u64,
    errors: u64,
    tool_attempts: u64,
    tool_successes: u64,
    cascade_escalations: u64,
}

#[derive(Debug, Clone, Default)]
struct FailureStats {
    server_errors: u32,      // 500s
    rate_limits: u32,        // 429s
    context_overflow: u32,   // context window exceeded
    content_filter: u32,     // content policy violations
    timeouts: u32,           // 408s / network timeouts
}

#[derive(Debug, Clone, Default)]
struct ModelStats {
    total_calls: u64,
    total_latency_ms: u64,
    error_count: u64,
    rate_limit_count: u64,
    estimated_cost_usd: f64,
    tool_calls_attempted: u64,
    tool_calls_succeeded: u64,
    // Circuit breaker state
    consecutive_failures: u32,
    circuit_open_since: Option<u64>,  // epoch ms when breaker tripped, None = closed
    // Per-task-type tracking (Phase 3)
    per_task: HashMap<String, TaskTypeStats>,
    // Typed failure tracking (Phase 7)
    failures: FailureStats,
}

lazy_static! {
    static ref MODEL_STATS: Mutex<HashMap<String, ModelStats>> = Mutex::new(HashMap::new());
    static ref SESSION_START: Mutex<Instant> = Mutex::new(Instant::now());
}

#[napi]
pub fn update_model_stats(
    model_id: String,
    latency_ms: f64,
    success: bool,
    input_tokens_est: f64,
    output_tokens_est: f64,
    http_status: Option<i32>,
) {
    let mut stats_map = MODEL_STATS.lock();
    let stats = stats_map.entry(model_id.clone()).or_default();
    stats.total_calls += 1;
    stats.total_latency_ms += latency_ms as u64;
    if !success {
        stats.error_count += 1;
        stats.consecutive_failures += 1;
        // Classify failure type (Phase 7)
        match http_status {
            Some(429) => { stats.rate_limit_count += 1; stats.failures.rate_limits += 1; }
            Some(408) => { stats.failures.timeouts += 1; }
            Some(413) => { stats.failures.context_overflow += 1; }
            Some(451) | Some(403) => { stats.failures.content_filter += 1; }
            Some(s) if s >= 500 => { stats.failures.server_errors += 1; }
            _ => {}
        }
        // Trip circuit breaker after threshold consecutive failures
        if stats.consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD && stats.circuit_open_since.is_none() {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            stats.circuit_open_since = Some(now_ms);
            let cooldown_ms = get_circuit_breaker_cooldown(&model_id);
            let display = MODEL_REGISTRY.get(&model_id)
                .map(|m| m.display_name.clone())
                .unwrap_or_else(|| model_id.clone());
            eprintln!("  ⚡ Circuit breaker OPEN for {} — skipping for {}s after {} consecutive failures",
                display, cooldown_ms / 1000, stats.consecutive_failures);
        }
    } else {
        // Success resets consecutive failures and closes circuit breaker
        stats.consecutive_failures = 0;
        stats.circuit_open_since = None;
    }

    if let Some(model) = MODEL_REGISTRY.get(&model_id) {
        let call_cost = (input_tokens_est / 1_000_000.0) * model.input_cost_per_1m
            + (output_tokens_est / 1_000_000.0) * model.output_cost_per_1m;
        stats.estimated_cost_usd += call_cost;

        // Update session cost in conversation context
        let mut ctx = CONVERSATION_CTX.lock();
        ctx.session_cost_usd += call_cost;
    }
}

fn is_circuit_open(model_id: &str) -> bool {
    let mut stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get_mut(model_id) {
        if let Some(tripped_at) = stats.circuit_open_since {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let cooldown_ms = get_circuit_breaker_cooldown(model_id);
            if now_ms - tripped_at >= cooldown_ms {
                // Cooldown elapsed — half-open: reset and allow retry
                stats.consecutive_failures = 0;
                stats.circuit_open_since = None;
                return false;
            }
            return true;
        }
    }
    false
}

#[napi]
pub fn is_circuit_open_napi(model_id: String) -> bool {
    is_circuit_open(&model_id)
}

fn is_rate_limited(model_id: &str) -> bool {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        if stats.total_calls == 0 { return false; }
        stats.rate_limit_count >= 2
    } else {
        false
    }
}

fn get_error_rate(model_id: &str) -> f64 {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        if stats.total_calls == 0 { return 0.0; }
        stats.error_count as f64 / stats.total_calls as f64
    } else {
        0.0
    }
}

fn get_avg_latency(model_id: &str) -> f64 {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        if stats.total_calls == 0 { return 0.0; }
        stats.total_latency_ms as f64 / stats.total_calls as f64
    } else {
        0.0
    }
}

#[napi]
pub fn get_error_rate_napi(model_id: String) -> f64 {
    get_error_rate(&model_id)
}

#[napi]
pub fn get_avg_latency_napi(model_id: String) -> f64 {
    get_avg_latency(&model_id)
}

#[napi]
pub fn is_rate_limited_napi(model_id: String) -> bool {
    is_rate_limited(&model_id)
}

#[napi]
pub fn update_tool_stats(model_id: String, success: bool, task_type: Option<String>) {
    let mut stats_map = MODEL_STATS.lock();
    let stats = stats_map.entry(model_id).or_default();
    stats.tool_calls_attempted += 1;
    if success {
        stats.tool_calls_succeeded += 1;
    }
    // Per-task-type tracking
    if let Some(tt) = task_type {
        let task_stats = stats.per_task.entry(tt).or_default();
        task_stats.tool_attempts += 1;
        if success { task_stats.tool_successes += 1; }
    }
}

fn get_tool_success_rate(model_id: &str) -> f64 {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        if stats.tool_calls_attempted == 0 { return 1.0; }
        stats.tool_calls_succeeded as f64 / stats.tool_calls_attempted as f64
    } else {
        1.0
    }
}

fn get_tool_success_rate_for_task(model_id: &str, task_type: &str) -> Option<f64> {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        if let Some(task_stats) = stats.per_task.get(task_type) {
            if task_stats.tool_attempts == 0 { return None; }
            return Some(task_stats.tool_successes as f64 / task_stats.tool_attempts as f64);
        }
    }
    None
}

fn get_quality_score(model_id: &str, task_type: &str) -> f64 {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        if let Some(task_stats) = stats.per_task.get(task_type) {
            if task_stats.calls == 0 { return 1.0; }
            // Quality = 1 - (escalation rate)
            1.0 - (task_stats.cascade_escalations as f64 / task_stats.calls as f64)
        } else {
            1.0
        }
    } else {
        1.0
    }
}

#[napi]
pub fn record_quality_failure(model_id: String, task_type: String, _reason: String) {
    let mut stats_map = MODEL_STATS.lock();
    let stats = stats_map.entry(model_id).or_default();
    let task_stats = stats.per_task.entry(task_type).or_default();
    task_stats.cascade_escalations += 1;
}

fn get_dominant_failure_type(model_id: &str) -> String {
    let stats_map = MODEL_STATS.lock();
    if let Some(stats) = stats_map.get(model_id) {
        let f = &stats.failures;
        let max = f.rate_limits
            .max(f.server_errors)
            .max(f.context_overflow)
            .max(f.content_filter)
            .max(f.timeouts);
        if max == 0 { return "server_error".to_string(); }
        if max == f.rate_limits { return "rate_limit".to_string(); }
        if max == f.context_overflow { return "context_overflow".to_string(); }
        if max == f.content_filter { return "content_filter".to_string(); }
        if max == f.timeouts { return "timeout".to_string(); }
    }
    "server_error".to_string()
}

/// Horizontal failover: switch to same-tier different-provider model
#[napi]
pub fn get_horizontal_failover(model_id: String) -> Option<String> {
    let model = MODEL_REGISTRY.get(&model_id)?;

    let mut candidates: Vec<&ModelInfo> = MODEL_REGISTRY.values()
        .filter(|m| {
            m.id != model_id
                && m.provider != model.provider
                && m.supports_tools
                && (m.tier as i32 - model.tier as i32).unsigned_abs() <= 2
        })
        .collect();

    candidates.sort_by_key(|m| (m.tier as i32 - model.tier as i32).unsigned_abs());

    candidates.first().map(|m| m.id.clone())
}

#[napi]
pub fn get_session_cost_summary() -> String {
    let stats_map = MODEL_STATS.lock();
    let session_start = SESSION_START.lock();
    let duration_min = session_start.elapsed().as_secs_f64() / 60.0;
    let mut total_cost = 0.0_f64;
    let mut lines = vec![format!("Model Usage (session: {:.1}min)", duration_min)];

    for (model_id, stats) in stats_map.iter() {
        let name = MODEL_REGISTRY.get(model_id)
            .map(|m| m.display_name.clone())
            .unwrap_or_else(|| model_id.split('/').next_back().unwrap_or(model_id).to_string());
        let avg_ms = if stats.total_calls > 0 {
            (stats.total_latency_ms as f64 / stats.total_calls as f64).round() as u64
        } else {
            0
        };
        let err_pct = if stats.total_calls > 0 {
            format!("{:.1}", (stats.error_count as f64 / stats.total_calls as f64) * 100.0)
        } else {
            "0".to_string()
        };
        lines.push(format!(
            "  {}: {} calls, avg {}ms, {}% err, ${:.4}",
            name, stats.total_calls, avg_ms, err_pct, stats.estimated_cost_usd
        ));
        total_cost += stats.estimated_cost_usd;
    }
    lines.push(format!("  Total estimated cost: ${:.4}", total_cost));
    lines.join("\n")
}

#[napi]
pub fn reset_session_stats() {
    let mut stats_map = MODEL_STATS.lock();
    stats_map.clear();
    let mut session_start = SESSION_START.lock();
    *session_start = Instant::now();
}

// ── Signal Extraction ────────────────────────
// Dynamic structural analysis — NO hardcoded keyword lists.

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signals {
    pub message_length: i32,
    pub question_complexity: i32,
    pub action_intent: i32,
    pub emotional_intensity: i32,
    pub technical_density: i32,
    pub conversation_depth: i32,
    pub media_attached: i32,
    pub urgency_signal: i32,
    pub iteration_factor: i32,
    pub error_history: i32,
}

// ── Compiled regex patterns ──────────────────

lazy_static! {
    // Question structure
    static ref RE_QUESTION_MARK: Regex = Regex::new(r"\?").unwrap();
    static ref RE_CLAUSE_SPLIT: Regex = Regex::new(r"(?i)[,;]|( and | or | but | versus | vs | while | whereas | although )").unwrap();
    static ref RE_CONDITIONAL: Regex = Regex::new(r"(?i)\bif\b.{5,}\b(then|would|could|should|will)\b").unwrap();
    static ref RE_VERSUS: Regex = Regex::new(r"(?i)\bvs\.?\b|\bversus\b").unwrap();
    static ref RE_COMPARATIVE: Regex = Regex::new(r"(?i)\b(between|comparing|compared)\b.{3,}\b(and|with)\b").unwrap();
    static ref RE_WHICH_BETTER: Regex = Regex::new(r"(?i)\bwhich\b.{3,}\b(better|best|worse|faster|cheaper)\b").unwrap();
    static ref RE_WHY_DEEP: Regex = Regex::new(r"(?i)\bwhy\b.{5,}\b(does|did|would|is|are|was|were|do)\b").unwrap();
    static ref RE_HOW_AFFECT: Regex = Regex::new(r"(?i)\bhow\b.{5,}\b(does|would|could|can|should)\b.{5,}\b(affect|impact|change|work|influence)\b").unwrap();
    static ref RE_MULTI_SCENARIO: Regex = Regex::new(r"(?i)\b(now|but|then).{0,10}\bif\b").unwrap();
    static ref RE_ACTION_SEQUENCE: Regex = Regex::new(r"(?i)\b(turn|put|place|move|flip|take|pick|drop|set)\b").unwrap();

    // Action intent
    static ref RE_URL: Regex = Regex::new(r"(?i)https?://\S+").unwrap();
    static ref RE_FILE_PATH: Regex = Regex::new(r"(?i)(?:/[\w.\-]+){2,}|[A-Z]:\\[\w\\.\-]+").unwrap();
    static ref RE_MULTI_STEP_FIRST: Regex = Regex::new(r"(?i)\b(first|step\s*1|1\.\s+\S)").unwrap();
    static ref RE_MULTI_STEP_THEN: Regex = Regex::new(r"(?i)\b(then|next|step\s*2|2\.\s+\S|after\s+that)").unwrap();
    static ref RE_REQUEST_PATTERN: Regex = Regex::new(r"(?i)\b(can|could|would)\s+you\b|\bplease\b|\bi\s+(need|want|wish|require)\b").unwrap();
    static ref RE_BACKTICK: Regex = Regex::new(r"`[^`]+`").unwrap();
    static ref RE_QUOTED: Regex = Regex::new(r#""[^"]{3,}""#).unwrap();
    static ref RE_NOT_VERB: Regex = Regex::new(r"^(i|the|a|an|my|we|it|its|this|that|these|those|is|was|are|were|he|she|they|who|what|when|where|why|how|but|and|or|so|if|not|no|yes|yeah|ok|okay|hi|hey|hello|do|does|did|can|could|will|would|should|may|might|have|has|had)$").unwrap();

    // Emotional intensity
    static ref RE_EXCLAMATION: Regex = Regex::new(r"!").unwrap();
    static ref RE_EMPHATIC: Regex = Regex::new(r"[!?]{2,}").unwrap();
    static ref RE_EMOJI: Regex = Regex::new(r"[\x{1F300}-\x{1F9FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}\x{FE00}-\x{FEFF}\x{1FA00}-\x{1FA6F}\x{1FA70}-\x{1FAFF}]").unwrap();
    static ref RE_ELLIPSIS_DASH: Regex = Regex::new(r"\.{3,}|\x{2014}|\x{2013}").unwrap();
    // Backreferences not supported in Rust regex; handled by has_repeated_chars()
    static ref RE_CODE_BLOCK_CHECK: Regex = Regex::new(r"```").unwrap();

    // Technical density
    static ref RE_FENCED_CODE: Regex = Regex::new(r"```[\s\S]*?```").unwrap();
    static ref RE_INDENTED_CODE: Regex = Regex::new(r"(?m)^( {4}|\t)\S").unwrap();
    static ref RE_INLINE_CODE: Regex = Regex::new(r"`[^`]+`").unwrap();
    static ref RE_FILE_EXT: Regex = Regex::new(r"\.\w{1,5}\b").unwrap();
    static ref RE_FILE_EXT_VALID: Regex = Regex::new(r"(?i)^\.[a-z]{1,5}$").unwrap();
    static ref RE_CAMEL_CASE: Regex = Regex::new(r"\b[a-z]+[A-Z][a-zA-Z]*").unwrap();
    static ref RE_SNAKE_CASE: Regex = Regex::new(r"\b[a-z]+_[a-z]+").unwrap();
    static ref RE_IMPORT_EXPORT: Regex = Regex::new(r"(?m)^(import|export|from|require)\s").unwrap();
    static ref RE_FUNC_CLASS: Regex = Regex::new(r"(?i)\b(function|class|const|let|var|def|fn)\s+\w+").unwrap();
    static ref RE_SYNTAX_CHARS: Regex = Regex::new(r"[{}()\[\]=>|&<>]").unwrap();
    static ref RE_ERROR_MESSAGES: Regex = Regex::new(r"\b(Error|Exception|TypeError|SyntaxError|ReferenceError|at\s+\w+\s+\(|line\s+\d+|column\s+\d+)\b").unwrap();
    static ref RE_JSON_STRUCTURE_START: Regex = Regex::new(r#"^\s*[{\["]"#).unwrap();
    static ref RE_JSON_STRUCTURE_END: Regex = Regex::new(r"[}\]]\s*$").unwrap();

    // Urgency
    static ref RE_TRIPLE_PUNCT: Regex = Regex::new(r"[!?]{3,}").unwrap();
    static ref RE_TIME_PATTERN: Regex = Regex::new(r"(?i)\b\d+\s*(min|minute|hour|hr|sec|second|pm|am)\b").unwrap();

    // Sentence splitting
    static ref RE_SENTENCE_SPLIT: Regex = Regex::new(r"[.!?\n]+").unwrap();
}

/// Check if a string contains any character repeated 3+ times consecutively
fn has_repeated_chars(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 3 { return false; }
    let mut count = 1u32;
    for i in 1..chars.len() {
        if chars[i] == chars[i - 1] {
            count += 1;
            if count >= 3 { return true; }
        } else {
            count = 1;
        }
    }
    false
}

fn count_matches(re: &Regex, text: &str) -> usize {
    re.find_iter(text).count()
}

fn analyze_question_structure(message: &str) -> i32 {
    let lower = message.to_lowercase();
    let sentences: Vec<&str> = RE_SENTENCE_SPLIT.split(message)
        .filter(|s| s.trim().len() > 3)
        .collect();
    let mut score: i32 = 0;

    // Has question marks
    let question_count = count_matches(&RE_QUESTION_MARK, message);
    if question_count > 0 { score += 3; }
    if question_count > 2 { score += 2; }

    // Multi-clause questions
    let question_sentences: Vec<&&str> = sentences.iter()
        .filter(|s| s.contains('?'))
        .collect();
    for q in &question_sentences {
        let clauses = RE_CLAUSE_SPLIT.split(q).count();
        if clauses >= 3 { score += 4; }
        else if clauses >= 2 { score += 2; }
    }

    // Conditional/hypothetical
    if RE_CONDITIONAL.is_match(&lower) { score += 3; }

    // Comparative
    if RE_VERSUS.is_match(&lower) { score += 3; }
    if RE_COMPARATIVE.is_match(&lower) { score += 3; }
    if RE_WHICH_BETTER.is_match(&lower) { score += 2; }

    // Deep reasoning
    if RE_WHY_DEEP.is_match(&lower) { score += 2; }
    if RE_HOW_AFFECT.is_match(&lower) { score += 3; }

    // Multi-scenario reasoning
    if question_count >= 2 && RE_MULTI_SCENARIO.is_match(&lower) {
        score += 5;
    }
    // Multiple sequential actions
    let action_seq = count_matches(&RE_ACTION_SEQUENCE, &lower);
    if action_seq >= 3 { score += 3; }

    // Long question
    if question_count > 0 && message.split_whitespace().count() > 30 {
        score += 2;
    }

    score.min(20)
}

fn analyze_action_intent(message: &str) -> i32 {
    let lower = message.to_lowercase();
    let trimmed = lower.trim();
    let sentences: Vec<&str> = RE_SENTENCE_SPLIT.split(message)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let mut score: i32 = 0;

    // Imperative sentence structure
    for sent in &sentences {
        let first_word = sent.split_whitespace().next().map(|w| w.to_lowercase());
        if let Some(ref fw) = first_word {
            if fw.len() > 1 && fw.len() < 12 && !RE_NOT_VERB.is_match(fw) {
                score += 3;
            }
        }
    }

    // URLs
    if RE_URL.is_match(message) { score += 4; }

    // File paths
    if RE_FILE_PATH.is_match(message) { score += 3; }

    // Multi-step phrasing
    if RE_MULTI_STEP_FIRST.is_match(trimmed) && RE_MULTI_STEP_THEN.is_match(trimmed) {
        score += 4;
    }

    // Request pattern
    if RE_REQUEST_PATTERN.is_match(&lower) { score += 2; }

    // Quoted text / backtick refs
    if RE_BACKTICK.is_match(message) || RE_QUOTED.is_match(message) { score += 1; }

    // Multiple sentences
    if sentences.len() >= 3 { score += 2; }

    score.min(20)
}

fn analyze_emotional_intensity(message: &str) -> i32 {
    let words: Vec<&str> = message.split_whitespace().filter(|w| !w.is_empty()).collect();
    let word_count = words.len();
    let mut score: i32 = 0;

    // Exclamation density
    let exclamations = count_matches(&RE_EXCLAMATION, message);
    if exclamations >= 3 { score += 3; }
    else if exclamations >= 1 { score += 1; }

    // Consecutive punctuation
    let emphatic = count_matches(&RE_EMPHATIC, message);
    score += (emphatic as i32 * 2).min(3);

    // ALL CAPS ratio
    if word_count > 3 {
        let caps_words = words.iter()
            .filter(|w| w.len() > 1 && *w == &w.to_uppercase() && w.chars().any(|c| c.is_ascii_uppercase()))
            .count();
        let caps_ratio = caps_words as f64 / word_count as f64;
        if caps_ratio > 0.5 { score += 4; }
        else if caps_ratio > 0.3 { score += 2; }
    }

    // Emoji density
    let emoji_count = count_matches(&RE_EMOJI, message);
    if emoji_count >= 3 { score += 3; }
    else if emoji_count >= 1 { score += 1; }

    // Ellipsis, dashes
    if RE_ELLIPSIS_DASH.is_match(message) { score += 1; }

    // Repeated characters (not in code blocks)
    if has_repeated_chars(message) && !RE_CODE_BLOCK_CHECK.is_match(message) { score += 1; }

    // Very short + intense
    if word_count <= 3 && (exclamations >= 2 || emphatic > 0) { score += 2; }

    score.min(10)
}

fn analyze_technical_density(message: &str) -> i32 {
    let mut score: i32 = 0;

    // Code blocks
    if RE_FENCED_CODE.is_match(message) { score += 5; }
    if RE_INDENTED_CODE.is_match(message) { score += 2; }

    // Inline code
    let inline_code = count_matches(&RE_INLINE_CODE, message);
    score += (inline_code as i32).min(3);

    // File extensions
    let file_exts: Vec<_> = RE_FILE_EXT.find_iter(message)
        .filter(|m| RE_FILE_EXT_VALID.is_match(m.as_str()))
        .collect();
    if file_exts.len() >= 2 { score += 3; }
    else if file_exts.len() == 1 { score += 1; }

    // camelCase or snake_case
    let camel = count_matches(&RE_CAMEL_CASE, message);
    let snake = count_matches(&RE_SNAKE_CASE, message);
    if camel + snake >= 3 { score += 3; }
    else if camel + snake >= 1 { score += 1; }

    // Import/export syntax
    if RE_IMPORT_EXPORT.is_match(message) { score += 2; }
    if RE_FUNC_CLASS.is_match(message) { score += 2; }

    // Syntax chars density
    let syntax_chars = count_matches(&RE_SYNTAX_CHARS, message);
    let syntax_ratio = if !message.is_empty() { syntax_chars as f64 / message.len() as f64 } else { 0.0 };
    if syntax_ratio > 0.05 { score += 2; }

    // Error messages
    if RE_ERROR_MESSAGES.is_match(message) { score += 3; }

    // JSON structure
    let trimmed = message.trim();
    if RE_JSON_STRUCTURE_START.is_match(trimmed) && RE_JSON_STRUCTURE_END.is_match(trimmed) {
        score += 2;
    }

    score.min(10)
}

fn analyze_urgency(message: &str) -> i32 {
    let mut score: i32 = 0;
    let word_count = message.split_whitespace().filter(|w| !w.is_empty()).count();

    // Very short messages
    if word_count <= 3 && word_count > 0 { score += 1; }

    // Triple+ punctuation
    if RE_TRIPLE_PUNCT.is_match(message) { score += 2; }

    // ALL CAPS short message
    if word_count <= 8 && message == message.to_uppercase() && message.chars().any(|c| c.is_ascii_uppercase()) {
        score += 2;
    }

    // Time patterns
    if RE_TIME_PATTERN.is_match(message) { score += 1; }

    // Short imperative
    if word_count <= 5 { score += 1; }

    score.min(5)
}

fn extract_signals(
    message: &str,
    iteration: i32,
    error_count: i32,
    has_media: bool,
) -> Signals {
    // Check cache first — avoids redundant regex analysis on repeated/similar messages
    let cache_key = signals_cache_key(message, iteration, error_count, has_media);
    {
        let cache = SIGNALS_CACHE.lock();
        if let Some(entry) = cache.get(&cache_key) {
            if entry.timestamp.elapsed().as_millis() < SIGNALS_CACHE_TTL_MS {
                return entry.signals.clone();
            }
        }
    }

    let word_count = message.split_whitespace().filter(|w| !w.is_empty()).count();

    // Truncate for regex-heavy analysis — diminishing returns past 300 chars
    let sample = if message.len() > 300 { &message[..300] } else { message };

    // 1. Message length (0-10)
    let message_length = match word_count {
        0..=3 => 0,
        4..=10 => 2,
        11..=30 => 4,
        31..=80 => 6,
        81..=200 => 8,
        _ => 10,
    };

    // 2. Question complexity (0-20)
    let question_complexity = analyze_question_structure(sample);

    // 3. Action intent (0-20)
    let action_intent = analyze_action_intent(sample);

    // 4. Emotional intensity (0-10)
    let emotional_intensity = analyze_emotional_intensity(sample);

    // 5. Technical density (0-10)
    let technical_density = analyze_technical_density(sample);

    // 6. Conversation depth (0-10)
    let depth = {
        let ctx = CONVERSATION_CTX.lock();
        ctx.turns_this_session
    };
    let conversation_depth = (depth / 3 * 2).min(10);

    // 7. Media attached (0-5)
    let media_attached = if has_media { 5 } else { 0 };

    // 8. Urgency (0-5)
    let urgency_signal = analyze_urgency(sample);

    // 9. Iteration factor (0-10)
    let mut iteration_factor = match iteration {
        i if i <= 1 => 10,
        i if i <= 3 => 6,
        i if i <= 8 => 3,
        _ => 1,
    };

    // Dampen iteration factor for trivially simple messages
    if iteration <= 1 && word_count <= 5 && action_intent < 3 && technical_density < 2 && question_complexity < 3 {
        iteration_factor = 4;
    }

    // 10. Error history (0-5)
    let error_history = (error_count * 2).min(5);

    let signals = Signals {
        message_length,
        question_complexity,
        action_intent,
        emotional_intensity,
        technical_density,
        conversation_depth,
        media_attached,
        urgency_signal,
        iteration_factor,
        error_history,
    };

    // Store in cache
    {
        let mut cache = SIGNALS_CACHE.lock();
        // Evict stale entries if cache is full
        if cache.len() >= SIGNALS_CACHE_MAX {
            let now = Instant::now();
            cache.retain(|_, v| now.duration_since(v.timestamp).as_millis() < SIGNALS_CACHE_TTL_MS);
        }
        cache.insert(cache_key, SignalsCacheEntry {
            signals: signals.clone(),
            timestamp: Instant::now(),
        });
    }

    signals
}

#[napi]
pub fn compute_complexity_score(signals: Signals) -> i32 {
    let raw = signals.message_length
        + signals.question_complexity
        + signals.action_intent
        + signals.emotional_intensity
        + signals.technical_density
        + signals.conversation_depth
        + signals.media_attached
        + signals.urgency_signal
        + signals.iteration_factor
        + signals.error_history;
    raw.clamp(0, 100)
}

fn compute_complexity_score_ref(signals: &Signals) -> i32 {
    let raw = signals.message_length
        + signals.question_complexity
        + signals.action_intent
        + signals.emotional_intensity
        + signals.technical_density
        + signals.conversation_depth
        + signals.media_attached
        + signals.urgency_signal
        + signals.iteration_factor
        + signals.error_history;
    raw.clamp(0, 100)
}

// ── Task Model / Thinking Maps ───────────────

fn task_model_map(task: &TaskType) -> &'static str {
    match *task {
        TaskType::Classify => "amazon/nova-micro-v1",
        TaskType::SimpleChat => "anthropic/claude-haiku-4.5",
        TaskType::ComplexChat => "anthropic/claude-opus-4.6",
        TaskType::ToolLoop => "google/gemini-2.5-flash",
        TaskType::Coding => "anthropic/claude-sonnet-4.6",
        TaskType::Planning => "anthropic/claude-sonnet-4.6",
        TaskType::Synthesis => "google/gemini-2.5-flash",
        TaskType::FinalAnswer => "anthropic/claude-haiku-4.5",
        TaskType::Research => "google/gemini-2.5-flash",
        TaskType::SubAgent => "google/gemini-2.5-flash",
        TaskType::AudioAnalysis => "google/gemini-3.1-flash-lite-preview",
        TaskType::Vision => "anthropic/claude-sonnet-4.6",
        TaskType::FirstIteration => "anthropic/claude-haiku-4.5",
        TaskType::ErrorRecovery => "anthropic/claude-opus-4.6",
    }
}

fn task_thinking_map(task: &TaskType, score: i32) -> ThinkingLevel {
    match *task {
        TaskType::Classify => ThinkingLevel::Off,
        TaskType::SimpleChat => ThinkingLevel::Off,
        TaskType::ComplexChat => {
            if score > 85 { ThinkingLevel::Max }
            else if score > 70 { ThinkingLevel::High }
            else { ThinkingLevel::Medium }
        },
        TaskType::ToolLoop => {
            if score > 80 { ThinkingLevel::High }
            else if score > 60 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::Coding => {
            if score > 80 { ThinkingLevel::High }
            else if score > 55 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::Planning => {
            if score > 75 { ThinkingLevel::High }
            else if score > 50 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::Synthesis => {
            if score > 70 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::FinalAnswer => {
            if score > 70 { ThinkingLevel::High }
            else if score > 40 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::Research => {
            if score > 80 { ThinkingLevel::High }
            else if score > 50 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::SubAgent => {
            if score > 70 { ThinkingLevel::High }
            else if score > 40 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::AudioAnalysis => ThinkingLevel::Off,
        TaskType::Vision => {
            if score > 70 { ThinkingLevel::High }
            else if score > 40 { ThinkingLevel::Medium }
            else { ThinkingLevel::Low }
        },
        TaskType::FirstIteration => ThinkingLevel::Off, // handled by score_to_thinking_ref
        TaskType::ErrorRecovery => ThinkingLevel::Max,
    }
}

fn is_user_facing_task(task: &TaskType) -> bool {
    matches!(*task,
        TaskType::SimpleChat
        | TaskType::ComplexChat
        | TaskType::FirstIteration
        | TaskType::FinalAnswer
        | TaskType::ErrorRecovery
    )
}

// ── Personality Need ─────────────────────────

const PURE_ACKS: &[&str] = &[
    "ok", "okay", "k", "yes", "yep", "yeah", "yup", "sure", "cool", "great", "nice",
    "got it", "noted", "done", "thanks", "ty", "thx", "np", "no problem", "alright",
    "fine", "good", "understood",
];

// Emoji acks checked separately: single-char emoji matches
const EMOJI_ACKS: &[&str] = &["\u{1F44D}", "\u{2705}", "\u{1FAE1}", "\u{1F44C}"];

const GREETINGS: &[&str] = &[
    "hi", "hey", "hello", "hii", "yo", "sup", "hola", "heya", "hiya",
    "good morning", "good afternoon", "good evening", "good night", "gm", "gn",
    "how are you", "what's up", "whats up", "how's it going", "howdy",
];

fn starts_with_any(msg: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| {
        msg == *p
            || msg.starts_with(&format!("{} ", p))
            || msg.starts_with(&format!("{}!", p))
            || msg.starts_with(&format!("{},", p))
    })
}

fn compute_personality_need(signals: &Signals, task_type: &TaskType, message: &str) -> i32 {
    let lower_msg = message.to_lowercase();
    let trimmed = lower_msg.trim();
    let word_count = trimmed.split_whitespace().count();

    // Detect pure acks
    let is_pure_ack = word_count <= 3
        && (PURE_ACKS.iter().any(|ack| trimmed == *ack || trimmed.starts_with(&format!("{} ", ack)))
            || EMOJI_ACKS.contains(&trimmed));

    // Detect greetings
    let is_greeting = starts_with_any(trimmed, GREETINGS);

    // Pure acks: minimal personality
    if is_pure_ack && !is_greeting {
        return 0;
    }

    // Greetings: need warmth
    if is_greeting {
        let mut need = 3.0_f64;
        need += signals.emotional_intensity as f64 * 0.3;
        return (need.round() as i32).clamp(2, 10);
    }

    // Standard personality calculation
    let mut need = 0.0_f64;

    // BASE: user-facing tasks
    if *task_type == TaskType::FirstIteration || *task_type == TaskType::FinalAnswer { need += 2.0; }
    if *task_type == TaskType::ComplexChat { need += 4.0; }
    if *task_type == TaskType::SimpleChat { need += 2.0; }

    // Emotional messages
    need += signals.emotional_intensity as f64 * 0.7;

    // Longer messages
    if signals.message_length >= 6 { need += 2.0; }
    else if signals.message_length >= 4 { need += 1.0; }

    // Complex questions
    if signals.question_complexity >= 8 { need += 2.0; }
    else if signals.question_complexity >= 4 { need += 1.0; }

    // Conversation depth
    if signals.conversation_depth >= 4 { need += 1.0; }

    // Short non-greeting/ack
    if word_count <= 3 { need -= 1.0; }

    // Action-heavy
    if signals.action_intent >= 12 { need -= 1.0; }

    // Background tasks
    if !is_user_facing_task(task_type) { need -= 5.0; }

    // Escalation stickiness
    {
        let ctx = CONVERSATION_CTX.lock();
        if ctx.escalated_this_session { need += 1.0; }
        if ctx.current_mood == Mood::Emotional { need += 2.0; }
    }

    (need.round() as i32).clamp(0, 10)
}

// ── Dynamic Model Selection ──────────────────

fn select_dynamic_model(score: i32, personality_need: i32, task_type: &TaskType) -> &'static str {
    // Background tasks: cost-optimized with cheap models
    if !is_user_facing_task(task_type) {
        if score <= 15 { return "amazon/nova-micro-v1"; }
        if score <= 25 { return "amazon/nova-lite-v1"; }
        if score <= 40 { return "google/gemini-2.5-flash"; }
        if score <= 55 { return "google/gemini-2.5-flash"; }
        if score <= 70 { return "google/gemini-3.1-pro-preview-customtools"; }
        if score <= 85 { return "google/gemini-3-flash-preview"; }
        return "anthropic/claude-sonnet-4.6";
    }

    // User-facing: Claude family — Haiku primary, Sonnet for deeper, Opus for complex
    if personality_need <= 4 {
        return "anthropic/claude-haiku-4.5";
    }
    if personality_need <= 6 {
        return "anthropic/claude-sonnet-4.6";
    }
    if personality_need <= 8 {
        if score <= 60 { return "anthropic/claude-sonnet-4.6"; }
        return "anthropic/claude-opus-4.6";
    }
    // 9-10: deep emotions / complex reasoning
    if score <= 50 { return "anthropic/claude-sonnet-4.6"; }
    "anthropic/claude-opus-4.6"
}

fn score_to_thinking_ref(score: i32, task_type: &TaskType) -> ThinkingLevel {
    // For user-facing first-iteration / simple chat: full 5-level dynamic
    if *task_type == TaskType::FirstIteration || *task_type == TaskType::SimpleChat {
        if score <= 25 { return ThinkingLevel::Off; }
        if score <= 40 { return ThinkingLevel::Low; }
        if score <= 60 { return ThinkingLevel::Medium; }
        if score <= 80 { return ThinkingLevel::High; }
        return ThinkingLevel::Max;
    }

    // Other task types: score-aware map (already uses 5 levels)
    let task_thinking = task_thinking_map(task_type, score);
    if task_thinking != ThinkingLevel::Off || matches!(*task_type,
        TaskType::Classify | TaskType::SimpleChat | TaskType::AudioAnalysis
    ) {
        return task_thinking;
    }

    // Fallback: 5-level score mapping
    if score <= 20 { ThinkingLevel::Off }
    else if score <= 40 { ThinkingLevel::Low }
    else if score <= 60 { ThinkingLevel::Medium }
    else if score <= 85 { ThinkingLevel::High }
    else { ThinkingLevel::Max }
}

#[napi]
pub fn score_to_thinking(score: i32, task_type: TaskType) -> ThinkingLevel {
    score_to_thinking_ref(score, &task_type)
}

fn infer_task_type(message: &str, signals: &Signals, opts: &SelectModelOptions) -> TaskType {
    let word_count = message.split_whitespace().count();

    // Explicit task type
    if let Some(tt) = opts.task_type {
        return tt;
    }

    // Error recovery
    if opts.error_count.unwrap_or(0) >= 2 {
        return TaskType::ErrorRecovery;
    }

    // Later iterations
    if opts.iteration.unwrap_or(1) > 1 {
        return TaskType::ToolLoop;
    }

    // Code-heavy
    if signals.technical_density >= 6 {
        return TaskType::Coding;
    }

    // Strong action intent
    if signals.action_intent >= 10 {
        return TaskType::FirstIteration;
    }

    // Short, low-complexity
    if word_count <= 5 && signals.action_intent < 3 && signals.technical_density < 2 && signals.question_complexity < 5 {
        return TaskType::SimpleChat;
    }

    // Emotional
    if signals.emotional_intensity >= 6 {
        return TaskType::ComplexChat;
    }

    // Complex questions
    if signals.question_complexity >= 8 {
        return TaskType::ComplexChat;
    }

    // Model hint
    if let Some(ref hint) = opts.model_hint {
        match hint.as_str() {
            "simple" => return TaskType::SimpleChat,
            "complex" => return TaskType::FirstIteration,
            _ => {}
        }
    }

    // Medium-length, low signals
    if word_count <= 20 && signals.action_intent < 5 && signals.technical_density < 3 {
        return TaskType::SimpleChat;
    }

    TaskType::FirstIteration
}

// ── Select Model Options ─────────────────────

#[napi(object)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolCallRef {
    pub name: String,
}

#[napi(object)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SelectModelOptions {
    pub task_type: Option<TaskType>,
    pub message: Option<String>,
    pub iteration: Option<i32>,
    pub error_count: Option<i32>,
    pub has_media: Option<bool>,
    pub model_hint: Option<String>,
    pub last_tool_calls: Option<Vec<ToolCallRef>>,
    pub urgency: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSelection {
    pub model_id: String,
    pub display_name: String,
    pub thinking_level: ThinkingLevel,
    pub reason: String,
    pub complexity_score: i32,
    pub task_type: TaskType,
    pub estimated_cost_per_call: f64,
}

/// Structural ack detection — no hardcoded word list.
/// An "ack" is any short, low-signal message that doesn't ask, request, or convey
/// technical/emotional content. This catches "ok", "nothing", "lol 😂", slang,
/// foreign-language acks, emoji-only messages, etc. without maintaining a list.
fn is_low_signal_ack(msg: &str) -> bool {
    // Strip channel tags like [SOURCE: ...] that get appended to user messages
    let trimmed = msg.split("\n\n[").next().unwrap_or(msg).trim();
    if trimmed.is_empty() { return false; }

    let word_count = trimmed.split_whitespace().count();
    // Must be short (≤ 3 words)
    if word_count > 3 { return false; }

    // Must not contain a question
    if trimmed.contains('?') { return false; }

    // Must not contain URLs, file paths, or backtick code
    if trimmed.contains("://") || trimmed.contains('/') || trimmed.contains('`') { return false; }

    // Must not contain action-request patterns ("can you", "please", "I need")
    let lower = trimmed.to_lowercase();
    if lower.contains("can you") || lower.contains("please") || lower.contains("i need")
        || lower.contains("i want") || lower.contains("could you") || lower.contains("do this")
        || lower.contains("tell me") || lower.contains("show me") || lower.contains("find")
        || lower.contains("search") || lower.contains("open") || lower.contains("send")
        || lower.contains("create") || lower.contains("make") || lower.contains("write")
        || lower.contains("run") || lower.contains("install") || lower.contains("delete")
        || lower.contains("fix") || lower.contains("build") || lower.contains("update")
        || lower.contains("check") || lower.contains("download") {
        return false;
    }

    // Must not contain technical syntax (braces, brackets, operators, code)
    if trimmed.contains('{') || trimmed.contains('}') || trimmed.contains('[')
        || trimmed.contains(']') || trimmed.contains('=') || trimmed.contains(';') {
        return false;
    }

    // If it's 1 word and > 20 chars, it's probably a URL or path, not an ack
    if word_count == 1 && trimmed.len() > 20 { return false; }

    true
}

fn estimate_tokens(message: &str, task_type: &TaskType) -> (f64, f64) {
    let input_base = (message.len() as f64 / 4.0).max(100.0);
    let output_mult = match *task_type {
        TaskType::SimpleChat => 0.3,
        TaskType::Classify => 0.05,
        TaskType::Coding => 3.0,
        TaskType::Research => 2.5,
        TaskType::ToolLoop => 0.5,
        TaskType::FinalAnswer => 1.5,
        TaskType::ComplexChat => 1.0,
        _ => 1.0,
    };
    (input_base.min(4000.0), (input_base * output_mult).min(4000.0))
}

#[napi]
pub fn select_model(opts: SelectModelOptions) -> ModelSelection {
    let message = opts.message.as_deref().unwrap_or("");
    let iteration = opts.iteration.unwrap_or(1);
    let error_count = opts.error_count.unwrap_or(0);
    let has_media = opts.has_media.unwrap_or(false);

    // Ultra-fast path: low-signal acks skip all analysis
    // Uses structural detection (short + no questions + no actions + no code)
    // instead of a hardcoded word list — catches any language, slang, emoji, etc.
    if iteration <= 1 && !has_media && is_low_signal_ack(message) {
        return ModelSelection {
            model_id: "anthropic/claude-haiku-4.5".to_string(),
            display_name: "Haiku 4.5".to_string(),
            thinking_level: ThinkingLevel::Off,
            reason: "fast_path:ack".to_string(),
            complexity_score: 0,
            task_type: TaskType::SimpleChat,
            estimated_cost_per_call: 0.001,
        };
    }

    // Extract signals
    let signals = extract_signals(message, iteration, error_count, has_media);
    let score = compute_complexity_score_ref(&signals);

    // Infer task type
    let task_type = infer_task_type(message, &signals, &opts);

    // ── Context-Aware Adjustments ──
    let mut adjusted_score = score;

    {
        let ctx = CONVERSATION_CTX.lock();

        // Mood stickiness
        if ctx.current_mood == Mood::Emotional && task_type == TaskType::SimpleChat {
            adjusted_score = adjusted_score.max(50);
        }

        // Escalation memory
        if ctx.escalated_this_session && adjusted_score < 40 {
            adjusted_score = adjusted_score.max(40);
        }

        // Topic stickiness
        if ctx.recent_scores.len() >= 3 {
            let last_3 = &ctx.recent_scores[ctx.recent_scores.len() - 3..];
            let avg_recent: f64 = last_3.iter().sum::<i32>() as f64 / 3.0;
            if avg_recent > 60.0 && adjusted_score < 40 {
                adjusted_score = adjusted_score.max(40);
            }
        }
    }

    // ── Model Selection ──
    let mut model_id: String;
    let mut reason: String;

    // Explicit task types with known-optimal models
    if task_type == TaskType::Vision {
        if has_media && adjusted_score > 50 {
            model_id = "anthropic/claude-sonnet-4.6".to_string();
            reason = format!("vision_complex:score{}", adjusted_score);
        } else {
            model_id = "anthropic/claude-haiku-4.5".to_string();
            reason = format!("vision_standard:score{}", adjusted_score);
        }
    } else if task_type == TaskType::Research {
        // Research is inherently complex — use capable models.
        // Escalate: Gemini 2.5 Flash → Gemini 3.1 Pro → Sonnet → Opus (never get stuck)
        if adjusted_score <= 40 {
            model_id = "google/gemini-2.5-flash".to_string();
            reason = format!("research_standard:score{}", adjusted_score);
        } else if adjusted_score <= 60 {
            model_id = "google/gemini-3.1-pro-preview-customtools".to_string();
            reason = format!("research_deep:score{}", adjusted_score);
        } else if adjusted_score <= 80 {
            model_id = "anthropic/claude-sonnet-4.6".to_string();
            reason = format!("research_complex:score{}", adjusted_score);
        } else {
            model_id = "anthropic/claude-opus-4.6".to_string();
            reason = format!("research_critical:score{}", adjusted_score);
        }
    } else if task_type == TaskType::SubAgent {
        // Sub-agents do real work — escalate to Opus if needed.
        // Gemini 2.5 Flash → Gemini 3.1 Pro → Sonnet → Opus (never get stuck)
        if adjusted_score <= 40 {
            model_id = "google/gemini-2.5-flash".to_string();
            reason = format!("subagent_standard:score{}", adjusted_score);
        } else if adjusted_score <= 60 {
            model_id = "google/gemini-3.1-pro-preview-customtools".to_string();
            reason = format!("subagent_capable:score{}", adjusted_score);
        } else if adjusted_score <= 80 {
            model_id = "anthropic/claude-sonnet-4.6".to_string();
            reason = format!("subagent_heavy:score{}", adjusted_score);
        } else {
            model_id = "anthropic/claude-opus-4.6".to_string();
            reason = format!("subagent_critical:score{}", adjusted_score);
        }
    } else if opts.task_type.is_some() && !matches!(task_type, TaskType::ToolLoop | TaskType::ErrorRecovery | TaskType::Coding) {
        model_id = task_model_map(&task_type).to_string();
        reason = format!("explicit:{}", task_type_to_str(&task_type));
    } else if task_type == TaskType::ToolLoop {
        model_id = task_model_map(&TaskType::ToolLoop).to_string();
        reason = format!("tool_loop:iter{}", iteration);
    } else if task_type == TaskType::ErrorRecovery {
        // Tiered error recovery: simple errors → Sonnet, complex → Opus
        if error_count <= 2 && adjusted_score <= 50 {
            model_id = "anthropic/claude-sonnet-4.6".to_string();
            reason = format!("error_recovery_simple:{}errors/score{}", error_count, adjusted_score);
        } else {
            model_id = "anthropic/claude-opus-4.6".to_string();
            reason = format!("error_recovery_complex:{}errors/score{}", error_count, adjusted_score);
        }
    } else if task_type == TaskType::Coding {
        // Tiered coding: simple → Gemini 2.5 Flash, medium → Sonnet, complex → Opus
        if adjusted_score <= 35 {
            model_id = "google/gemini-2.5-flash".to_string();
            reason = format!("coding_simple:score{}", adjusted_score);
        } else if adjusted_score <= 65 {
            model_id = "anthropic/claude-sonnet-4.6".to_string();
            reason = format!("coding_medium:score{}", adjusted_score);
        } else {
            model_id = "anthropic/claude-opus-4.6".to_string();
            reason = format!("coding_complex:score{}", adjusted_score);
        }
    } else {
        // Dynamic model selection
        let personality_need = compute_personality_need(&signals, &task_type, message);
        model_id = select_dynamic_model(adjusted_score, personality_need, &task_type).to_string();
        reason = format!("dynamic:score{}/pn{}", adjusted_score, personality_need);
    }

    // ── Creative / UI-UX detection ──
    let msg_lower = message.to_lowercase();
    let is_creative_task = msg_lower.contains("design") || msg_lower.contains("ui/ux")
        || msg_lower.contains("ui ux") || msg_lower.contains("layout")
        || msg_lower.contains("mockup") || msg_lower.contains("wireframe")
        || msg_lower.contains("prototype") || msg_lower.contains("figma")
        || msg_lower.contains("aesthetic") || msg_lower.contains("redesign")
        || msg_lower.contains("visual") || msg_lower.contains("css")
        || msg_lower.contains("styling") || msg_lower.contains("animation")
        || msg_lower.contains("responsive") || msg_lower.contains("tailwind")
        || msg_lower.contains("color scheme") || msg_lower.contains("typography");

    if is_creative_task && (task_type == TaskType::Coding || task_type == TaskType::ToolLoop || task_type == TaskType::FirstIteration) {
        model_id = "google/gemini-3.1-pro-preview-customtools".to_string();
        reason = format!("creative_uiux:score{}", adjusted_score);
    }

    // ── Browser/OS tool detection ──
    let browser_os_prefixes = ["browser_", "os_"];
    let has_browser_os_tools = opts.last_tool_calls
        .as_ref()
        .map(|calls| calls.iter().any(|tc|
            browser_os_prefixes.iter().any(|prefix| tc.name.starts_with(prefix))
        ))
        .unwrap_or(false);

    if has_browser_os_tools && task_type == TaskType::ToolLoop {
        // Prefer Sonnet 4.5 for browser/OS automation (agentic + vision), respect circuit breaker
        let preferred = "anthropic/claude-sonnet-4.6";
        if !is_circuit_open(preferred) {
            model_id = preferred.to_string();
            reason.push_str(":browser_os_sonnet46");
        } else {
            // Fallback through vision-capable models
            let vision_fallbacks = [
                "anthropic/claude-sonnet-4.6",
                "anthropic/claude-opus-4.6",
                "google/gemini-3.1-pro-preview-customtools",
            ];
            for fb in &vision_fallbacks {
                if !is_circuit_open(fb) {
                    model_id = fb.to_string();
                    let short_name = fb.split('/').last().unwrap_or(fb);
                    reason.push_str(&format!(":browser_os_fallback_{}", short_name));
                    break;
                }
            }
        }
    }

    // ── Tool success rate: deprioritize models that fail tool calls (uses per-task stats when available) ──
    let task_type_str = task_type_to_str(&task_type);
    if task_type == TaskType::ToolLoop {
        let tool_rate = get_tool_success_rate_for_task(&model_id, task_type_str)
            .unwrap_or_else(|| get_tool_success_rate(&model_id));
        if tool_rate < 0.70 {
            // Try horizontal failover to a model with better tool success
            if let Some(failover) = get_horizontal_failover(model_id.clone()) {
                let failover_rate = get_tool_success_rate_for_task(&failover, task_type_str)
                    .unwrap_or_else(|| get_tool_success_rate(&failover));
                if failover_rate > tool_rate {
                    reason.push_str(&format!(":tool_failover({}%→{}%)", (tool_rate*100.0) as i32, (failover_rate*100.0) as i32));
                    model_id = failover;
                }
            }
        }
    }

    // ── Quality feedback: deprioritize models with high cascade escalation rates (Phase 4) ──
    let quality = get_quality_score(&model_id, task_type_str);
    let user_facing = is_user_facing_task(&task_type);
    if quality < 0.80 && model_id != "anthropic/claude-opus-4.6" {
        // Model has >20% cascade escalation rate for this task type → try upgrade
        if let Some(next) = get_cascade_next_internal(&model_id, &task_type) {
            if !is_circuit_open(&next) && get_quality_score(&next, task_type_str) > quality {
                reason.push_str(&format!(":quality_upgrade({}%)", (quality * 100.0) as i32));
                model_id = next;
            }
        }
    }

    // ── Latency-aware tiebreaking (Phase 5): only within same tier ──
    let current_tier = MODEL_REGISTRY.get(&model_id).map(|m| m.tier).unwrap_or(3);
    let avg_latency = get_avg_latency(&model_id);
    if avg_latency > 0.0 {
        let mut candidates: Vec<&ModelInfo> = MODEL_REGISTRY.values()
            .filter(|m| {
                m.tier == current_tier
                    && m.id != model_id
                    && m.supports_tools
                    && !is_circuit_open(&m.id)
            })
            .collect();
        candidates.sort_by(|a, b| {
            let la = get_avg_latency(&a.id);
            let lb = get_avg_latency(&b.id);
            la.partial_cmp(&lb).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(alt) = candidates.first() {
            let alt_latency = get_avg_latency(&alt.id);
            // Only swap if alternative is >2x faster AND has low error rate
            if alt_latency > 0.0 && alt_latency < avg_latency * 0.5 && get_error_rate(&alt.id) < 0.05 {
                reason.push_str(":latency_tiebreak");
                model_id = alt.id.clone();
            }
        }
    }

    // ── Background mode: cap to cheap models ──
    let urgency = opts.urgency.as_deref().unwrap_or("");
    if urgency == "background" {
        let current_tier = MODEL_REGISTRY.get(&model_id).map(|m| m.tier).unwrap_or(3);
        if current_tier < 5 {
            // Find cheapest model with tool support, tier >= 5
            let cheap_model = MODEL_REGISTRY.values()
                .filter(|m| m.tier >= 5 && m.supports_tools)
                .max_by_key(|m| m.tier); // Cheapest = highest tier number
            if let Some(cm) = cheap_model {
                let old_name = MODEL_REGISTRY.get(&model_id)
                    .map(|m| m.display_name.clone())
                    .unwrap_or_default();
                reason.push_str(&format!(":bg_downgrade_from_{}", old_name));
                model_id = cm.id.clone();
            }
        }
    }

    // ── Typed failure routing (Phase 7): route based on failure type ──
    let err_rate = get_error_rate(&model_id);
    if err_rate > 0.15 && model_id != "anthropic/claude-opus-4.6" {
        let failure_type = get_dominant_failure_type(&model_id);
        let old_name = MODEL_REGISTRY.get(&model_id)
            .map(|m| m.display_name.clone())
            .unwrap_or_default();
        let current_tier = MODEL_REGISTRY.get(&model_id).map(|m| m.tier).unwrap_or(3);

        match failure_type.as_str() {
            "rate_limit" => {
                // 429 → Horizontal failover (same tier, different provider)
                if let Some(failover) = get_horizontal_failover(model_id.clone()) {
                    if !is_circuit_open(&failover) {
                        reason.push_str(&format!(":429_failover_from_{}", old_name));
                        model_id = failover;
                    }
                }
            }
            "context_overflow" => {
                // Context too large → model with larger max_tokens at same tier or higher
                let bigger_model = MODEL_REGISTRY.values()
                    .filter(|m| m.id != model_id && m.max_tokens > 8192 && m.supports_tools && !is_circuit_open(&m.id))
                    .min_by_key(|m| m.tier);
                if let Some(bm) = bigger_model {
                    reason.push_str(&format!(":context_overflow_from_{}", old_name));
                    model_id = bm.id.clone();
                }
            }
            "content_filter" => {
                // Content policy → different provider
                if let Some(failover) = get_horizontal_failover(model_id.clone()) {
                    if !is_circuit_open(&failover) {
                        reason.push_str(&format!(":content_filter_from_{}", old_name));
                        model_id = failover;
                    }
                }
            }
            "timeout" => {
                // Timeout → faster model at same quality tier
                let faster_model = MODEL_REGISTRY.values()
                    .filter(|m| {
                        m.id != model_id
                            && m.supports_tools
                            && !is_circuit_open(&m.id)
                            && (m.tier as i32 - current_tier as i32).unsigned_abs() <= 1
                            && matches!(m.speed, Speed::Fast | Speed::VeryFast)
                    })
                    .min_by_key(|m| m.tier);
                if let Some(fm) = faster_model {
                    reason.push_str(&format!(":timeout_swap_from_{}", old_name));
                    model_id = fm.id.clone();
                }
            }
            _ => {
                // Generic server error (500) → Vertical escalation to better tier
                // For user-facing tasks, only escalate within Claude family
                let better_model = MODEL_REGISTRY.values()
                    .filter(|m| {
                        m.tier < current_tier
                            && m.supports_tools
                            && !is_circuit_open(&m.id)
                    })
                    .max_by_key(|m| m.tier);
                if let Some(bm) = better_model {
                    reason.push_str(&format!(":escalated_from_{}(err={}%)", old_name, (err_rate * 100.0) as i32));
                    model_id = bm.id.clone();
                }
            }
        }
    }

    // ── Circuit breaker final check ──
    // If the selected model's circuit breaker is open, reroute to a healthy alternative
    if is_circuit_open(&model_id) {
        let old_name = MODEL_REGISTRY.get(&model_id)
            .map(|m| m.display_name.clone())
            .unwrap_or_else(|| model_id.clone());

        // Try horizontal failover first (same tier, different provider)
        // For user-facing tasks, only failover within Claude family
        let mut rerouted = false;
        if let Some(failover) = get_horizontal_failover(model_id.clone()) {
            if !is_circuit_open(&failover) {
                reason.push_str(&format!(":circuit_breaker_reroute_from_{}", old_name));
                model_id = failover;
                rerouted = true;
            }
        }
        // If horizontal failover also tripped, try cascade chain
        if !rerouted {
            if let Some(next) = get_cascade_next_internal(&model_id, &task_type) {
                if !is_circuit_open(&next) {
                    reason.push_str(&format!(":circuit_breaker_cascade_from_{}", old_name));
                    model_id = next;
                }
            }
        }
    }

    // NOTE: Session budget auto-downgrade was removed — it caused mid-task failures
    // by swapping to models that returned 400 errors. Credit deduction on the server
    // side already prevents runaway costs. The model router should optimize for
    // task success, not penny-pinch during active workflows.

    // ── Thinking level ──
    // Sparse thinking: disable reasoning for repetitive OS tool loops (iteration 4+)
    let is_repetitive_os = opts.last_tool_calls
        .as_ref()
        .map(|calls| !calls.is_empty() && calls.iter().all(|tc|
            tc.name.starts_with("os_") || tc.name == "app_manager"
        ))
        .unwrap_or(false);

    let mut thinking_level = if urgency == "background" {
        ThinkingLevel::Off
    } else if is_repetitive_os && iteration > 3 && task_type == TaskType::ToolLoop {
        ThinkingLevel::Off
    } else {
        score_to_thinking_ref(adjusted_score, &task_type)
    };

    // ── Cost-aware thinking (Phase 6): apply session cost pressure ──
    // Only reduces thinking, never model quality — personality must not suffer
    {
        let ctx = CONVERSATION_CTX.lock();
        let session_cost = ctx.session_cost_usd;
        if session_cost > 0.50
            && thinking_level == ThinkingLevel::Max
            && task_type != TaskType::ErrorRecovery
        {
            thinking_level = ThinkingLevel::High;
            reason.push_str(":cost_pressure_max_to_high");
        }
        if session_cost > 1.00
            && thinking_level == ThinkingLevel::High
            && task_type != TaskType::ErrorRecovery
        {
            thinking_level = ThinkingLevel::Medium;
            reason.push_str(":cost_pressure_thinking");
        }
        if session_cost > 2.00
            && thinking_level == ThinkingLevel::Medium
            && !is_user_facing_task(&task_type)
        {
            thinking_level = ThinkingLevel::Low;
            reason.push_str(":cost_pressure_thinking_bg");
        }
    }

    // ── Latency-aware thinking downgrade (Phase 5B): if model is slow, reduce thinking for responsiveness ──
    if is_user_facing_task(&task_type) {
        let model_latency = get_avg_latency(&model_id);
        if model_latency > 8000.0 {
            if thinking_level == ThinkingLevel::Max {
                thinking_level = ThinkingLevel::High;
                reason.push_str(":thinking_downgrade_slow_max");
            } else if thinking_level == ThinkingLevel::High {
                thinking_level = ThinkingLevel::Medium;
                reason.push_str(":thinking_downgrade_slow");
            }
        }
    }

    // ── Cost estimate (smart token estimation with thinking multiplier) ──
    let thinking_cost_mult = match thinking_level {
        ThinkingLevel::Off => 1.0,
        ThinkingLevel::Low => 1.3,
        ThinkingLevel::Medium => 1.8,
        ThinkingLevel::High => 2.5,
        ThinkingLevel::Max => 4.0,
    };
    let (est_input, est_output) = estimate_tokens(message, &task_type);
    let model_info = MODEL_REGISTRY.get(&model_id);
    let estimated_cost_per_call = model_info
        .map(|m| {
            let base = (est_input / 1_000_000.0) * m.input_cost_per_1m
                + (est_output / 1_000_000.0) * m.output_cost_per_1m;
            base * thinking_cost_mult
        })
        .unwrap_or(0.0);

    // ── Update conversation context ──
    {
        let mut ctx = CONVERSATION_CTX.lock();
        ctx.recent_scores.push(adjusted_score);
        if ctx.recent_scores.len() > 5 {
            ctx.recent_scores.remove(0);
        }
        ctx.turns_this_session += 1;
        ctx.last_model_used = Some(model_id.clone());

        if adjusted_score >= 80 {
            ctx.escalated_this_session = true;
        }

        // Mood detection
        if signals.emotional_intensity >= 5 {
            ctx.current_mood = Mood::Emotional;
        } else if signals.urgency_signal >= 3 {
            ctx.current_mood = Mood::Urgent;
        } else if signals.action_intent >= 10 || signals.technical_density >= 5 {
            ctx.current_mood = Mood::Focused;
        } else if adjusted_score <= 30 {
            ctx.current_mood = Mood::Casual;
        }

        // Track dominant task type for cascade chain
        if matches!(task_type, TaskType::ToolLoop | TaskType::Coding | TaskType::Research) {
            ctx.dominant_task_type = Some(task_type);
        }
    }

    let display_name = model_info
        .map(|m| m.display_name.clone())
        .unwrap_or_else(|| model_id.split('/').next_back().unwrap_or(&model_id).to_string());

    ModelSelection {
        model_id,
        display_name,
        thinking_level,
        reason,
        complexity_score: adjusted_score,
        task_type,
        estimated_cost_per_call,
    }
}

// ── Cascade Quality Gate ─────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CascadeResult {
    pub should_escalate: bool,
    pub reason: String,
}

#[napi]
pub fn should_cascade_escalate(
    response: String,
    original_message: String,
    _current_model_id: String,
) -> CascadeResult {
    let lower = response.to_lowercase();
    let orig_lower = original_message.to_lowercase();
    let orig_word_count = original_message.split_whitespace().count();

    // 1. Response too short for a substantive question
    if orig_word_count > 10 && response.len() < 50 {
        return CascadeResult {
            should_escalate: true,
            reason: "response_too_short".into(),
        };
    }

    // 2. Generic refusal when not expected
    let refusal = lower.contains("i can't")
        || lower.contains("i cannot")
        || lower.contains("i'm not able")
        || lower.contains("i apologize")
        || lower.contains("as an ai");
    if refusal && !orig_lower.contains("can you") {
        return CascadeResult {
            should_escalate: true,
            reason: "unexpected_refusal".into(),
        };
    }

    // 3. Excessive repetition
    let sentences: Vec<String> = RE_SENTENCE_SPLIT.split(&response)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let unique_count = {
        let mut set = std::collections::HashSet::new();
        for s in &sentences { set.insert(s.clone()); }
        set.len()
    };
    if sentences.len() >= 4 && unique_count < sentences.len() / 2 {
        return CascadeResult {
            should_escalate: true,
            reason: "excessive_repetition".into(),
        };
    }

    // 4. Tone mismatch
    let casual_markers = ["bro", "dude", "man", "lol", "haha", "yo", "bruh", "nah", "yeah", "gonna", "wanna"];
    let formal_markers = ["furthermore", "nevertheless", "consequently", "henceforth", "it is imperative"];
    let is_casual_input = casual_markers.iter().any(|m| orig_lower.contains(m));
    let is_formal_response = formal_markers.iter().any(|m| lower.contains(m));
    if is_casual_input && is_formal_response {
        return CascadeResult {
            should_escalate: true,
            reason: "tone_mismatch".into(),
        };
    }

    // 5. Empty
    if response.trim().is_empty() {
        return CascadeResult {
            should_escalate: true,
            reason: "empty_response".into(),
        };
    }

    CascadeResult {
        should_escalate: false,
        reason: "quality_pass".into(),
    }
}

// ── Cascade Model Chain ──────────────────────

fn get_cascade_next_internal(current_model_id: &str, task_type: &TaskType) -> Option<String> {
    // Task-specific chains
    if *task_type == TaskType::Coding {
        return match current_model_id {
            "google/gemini-2.5-flash" => Some("anthropic/claude-sonnet-4.6".to_string()),
            "anthropic/claude-sonnet-4.6" => Some("anthropic/claude-opus-4.6".to_string()),
            _ => Some("anthropic/claude-sonnet-4.6".to_string()),
        };
    }
    if *task_type == TaskType::ToolLoop {
        return match current_model_id {
            "amazon/nova-lite-v1" => Some("google/gemini-2.5-flash".to_string()),
            "google/gemini-2.5-flash-lite" => Some("google/gemini-2.5-flash".to_string()),
            "google/gemini-2.5-flash" => Some("google/gemini-3-flash-preview".to_string()),
            "google/gemini-3-flash-preview" => Some("anthropic/claude-sonnet-4.6".to_string()),
            "google/gemini-3.1-pro-preview-customtools" => Some("anthropic/claude-sonnet-4.6".to_string()),
            "anthropic/claude-sonnet-4.6" => Some("anthropic/claude-opus-4.6".to_string()),
            _ => Some("google/gemini-2.5-flash".to_string()),
        };
    }

    // Default chain (cheapest to most capable — Opus is always final)
    let chain = [
        "amazon/nova-micro-v1",
        "amazon/nova-lite-v1",
        "google/gemini-2.5-flash-lite",
        "google/gemini-2.0-flash-001",
        "google/gemini-2.5-flash",
        "google/gemini-3-flash-preview",
        "anthropic/claude-haiku-4.5",
        "google/gemini-3.1-pro-preview-customtools",
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-opus-4.6",
    ];
    let current_idx = chain.iter().position(|&id| id == current_model_id);
    match current_idx {
        Some(idx) if idx < chain.len() - 1 => Some(chain[idx + 1].to_string()),
        _ => None,
    }
}

#[napi]
pub fn get_cascade_next(current_model_id: String) -> Option<String> {
    let ctx = CONVERSATION_CTX.lock();
    let task = ctx.dominant_task_type.unwrap_or(TaskType::FirstIteration);
    get_cascade_next_internal(&current_model_id, &task)
}

// ── Provider Routing ─────────────────────────

#[napi]
pub fn get_provider_order(model_id: String) -> Option<Vec<String>> {
    let model = MODEL_REGISTRY.get(&model_id)?;
    if model.provider == Provider::Anthropic {
        Some(vec!["Google Vertex".to_string()])
    } else {
        None
    }
}

// ── Shortcut Functions ───────────────────────

#[napi]
pub fn select_for_classify() -> ModelSelection {
    select_model(SelectModelOptions {
        task_type: Some(TaskType::Classify),
        ..Default::default()
    })
}

#[napi]
pub fn select_for_agent(
    message: String,
    iteration: i32,
    error_count: i32,
    model_hint: Option<String>,
    last_tool_calls: Option<Vec<ToolCallRef>>,
    has_media: Option<bool>,
) -> ModelSelection {
    let mut task_type: Option<TaskType> = None;
    if has_media.unwrap_or(false) {
        task_type = Some(TaskType::Vision);
    } else if iteration > 1 && last_tool_calls.as_ref().map(|c| !c.is_empty()).unwrap_or(false) {
        task_type = Some(TaskType::ToolLoop);
    }

    select_model(SelectModelOptions {
        task_type,
        message: Some(message),
        iteration: Some(iteration),
        error_count: Some(error_count),
        has_media,
        model_hint,
        last_tool_calls,
        ..Default::default()
    })
}

#[napi]
pub fn select_for_final_answer(task_type: Option<TaskType>) -> ModelSelection {
    if task_type == Some(TaskType::SimpleChat) {
        return select_model(SelectModelOptions {
            task_type: Some(TaskType::SimpleChat),
            ..Default::default()
        });
    }
    select_model(SelectModelOptions {
        task_type: Some(TaskType::FinalAnswer),
        ..Default::default()
    })
}

#[napi]
pub fn select_for_synthesis() -> ModelSelection {
    select_model(SelectModelOptions {
        task_type: Some(TaskType::Synthesis),
        ..Default::default()
    })
}

#[napi]
pub fn select_for_planning() -> ModelSelection {
    select_model(SelectModelOptions {
        task_type: Some(TaskType::Planning),
        ..Default::default()
    })
}

#[napi]
pub fn select_for_sub_agent() -> ModelSelection {
    select_model(SelectModelOptions {
        task_type: Some(TaskType::SubAgent),
        ..Default::default()
    })
}

#[napi]
pub fn select_for_research() -> ModelSelection {
    select_model(SelectModelOptions {
        task_type: Some(TaskType::Research),
        ..Default::default()
    })
}
