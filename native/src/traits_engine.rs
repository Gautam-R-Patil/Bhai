// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Traits Engine — Full port of src/memory/traits.ts (scoring, injection, decay logic)
// SQLite I/O stays in JS; Rust handles all computation.

use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Constants ──────────────────────────────────────

const BASE_ALPHA: f64 = 0.12;
const K_EXPLICIT: f64 = 3.0;
const COOLDOWN_FACTOR: f64 = 0.5;
const LAMBDA: f64 = 0.02;
const MAX_DECAY_DAYS: f64 = 14.0;
const REMOVAL_THRESHOLD: f64 = 0.1;
const HIGH_CONFIDENCE: f64 = 0.7;
const MAX_SESSION_UPDATES: usize = 5;
const MAX_TRAITS_INJECTION: usize = 8;
const TOKEN_BUDGET_DEFAULT: usize = 600;
const STABILITY_BONUS_WEIGHT: f64 = 0.1;
const PREDICTIVE_CACHE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct BehavioralTrait {
    pub trait_key: String,
    pub value: String,
    pub confidence: f64,
    pub explicit: bool,
    pub topics: Vec<String>,
    pub reinforcement_count: u32,
    pub last_seen_ts: String,
    pub created_at: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ReinforcementResult {
    pub new_confidence: f64,
    pub action: String, // "reinforced" | "new" | "contradicted" | "capped"
    pub alpha: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TraitDecayAction {
    pub trait_key: String,
    pub action: String, // "delete" | "update"
    pub new_confidence: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ScoredTrait {
    pub trait_key: String,
    pub value: String,
    pub confidence: f64,
    pub priority: f64,
    pub line: String,
    pub line_tokens: u32,
}

// ── Conflict Map ───────────────────────────────────

lazy_static::lazy_static! {
    static ref CONFLICT_MAP: HashMap<&'static str, Vec<&'static str>> = {
        let mut m = HashMap::new();
        m.insert("likes_short_answers", vec!["likes_detailed_answers"]);
        m.insert("likes_detailed_answers", vec!["likes_short_answers"]);
        m.insert("risk_averse", vec!["risk_tolerant"]);
        m.insert("risk_tolerant", vec!["risk_averse"]);
        m.insert("prefers_formal", vec!["prefers_casual"]);
        m.insert("prefers_casual", vec!["prefers_formal"]);
        m.insert("prefers_brevity", vec!["prefers_verbose"]);
        m.insert("prefers_verbose", vec!["prefers_brevity"]);
        m
    };

    static ref STOPWORDS: HashSet<&'static str> = {
        let words = vec![
            "the", "a", "an", "is", "are", "was", "were", "do", "does", "did",
            "to", "of", "in", "for", "on", "with", "at", "by", "from", "it",
            "this", "that", "and", "or", "but", "not", "so", "if", "my", "your",
            "i", "me", "we", "you", "he", "she", "they", "what", "how", "can",
        ];
        words.into_iter().collect()
    };
}

// ── Session State (thread-safe) ────────────────────

struct TraitSessionState {
    session_trait_updates: HashSet<String>,
    session_update_count: usize,
    previous_session_traits: HashSet<String>,
}

impl TraitSessionState {
    fn new() -> Self {
        Self {
            session_trait_updates: HashSet::new(),
            session_update_count: 0,
            previous_session_traits: HashSet::new(),
        }
    }
}

lazy_static::lazy_static! {
    static ref SESSION_STATE: Mutex<TraitSessionState> = Mutex::new(TraitSessionState::new());
}

// ── Predictive Cache ───────────────────────────────

struct PredictiveCache {
    snippet: String,
    query_tokens: HashSet<String>,
    timestamp: f64,
}

lazy_static::lazy_static! {
    static ref PRED_CACHE: Mutex<Option<PredictiveCache>> = Mutex::new(None);
}

// ── Session Management ─────────────────────────────

/// Reset per-session trait caps. Call at session start.
#[napi]
pub fn traits_reset_session_caps() {
    let mut state = SESSION_STATE.lock();
    state.previous_session_traits = state.session_trait_updates.clone();
    state.session_trait_updates.clear();
    state.session_update_count = 0;
}

/// Get conflicting trait keys for a given trait.
#[napi]
pub fn traits_get_conflicts(trait_key: String) -> Vec<String> {
    CONFLICT_MAP
        .get(trait_key.as_str())
        .map(|v| v.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

// ── Reinforcement Computation ──────────────────────

/// Compute the new confidence after reinforcement.
/// Returns the result with action type and computed alpha.
#[napi]
pub fn traits_compute_reinforcement(
    existing_confidence: f64,
    existing_value: String,
    new_value: String,
    is_explicit: bool,
    reinforcement_count: u32,
    trait_key: String,
) -> ReinforcementResult {
    let mut state = SESSION_STATE.lock();

    // Per-session caps
    if state.session_update_count >= MAX_SESSION_UPDATES {
        return ReinforcementResult {
            new_confidence: existing_confidence,
            action: "capped".to_string(),
            alpha: 0.0,
        };
    }
    if state.session_trait_updates.contains(&trait_key) {
        return ReinforcementResult {
            new_confidence: existing_confidence,
            action: "capped".to_string(),
            alpha: 0.0,
        };
    }

    // Compute alpha
    let s = if is_explicit { 1.0 } else { 0.0 };
    let mut alpha = BASE_ALPHA * (1.0 + K_EXPLICIT * s);

    // Reinforcement count bonus
    if reinforcement_count > 0 {
        alpha *= 1.0 + (reinforcement_count as f64 + 1.0).log2() * 0.1;
    }

    // Cooldown
    if state.previous_session_traits.contains(&trait_key) {
        alpha *= COOLDOWN_FACTOR;
    }

    let action;
    let new_conf;

    if existing_value == new_value {
        // Same value -> reinforce
        new_conf = (existing_confidence + alpha * (1.0 - existing_confidence)).min(1.0);
        action = "reinforced".to_string();
    } else {
        // Different value -> contradiction
        let beta = 0.5;
        new_conf = if is_explicit {
            0.0
        } else {
            (existing_confidence * (1.0 - beta)).max(0.0)
        };
        action = "contradicted".to_string();
    }

    state.session_trait_updates.insert(trait_key);
    state.session_update_count += 1;

    ReinforcementResult {
        new_confidence: new_conf,
        action,
        alpha,
    }
}

/// Compute initial confidence for a new trait.
#[napi]
pub fn traits_initial_confidence(is_explicit: bool) -> f64 {
    if is_explicit {
        0.65
    } else {
        0.45
    }
}

/// Compute contradiction confidence.
#[napi]
pub fn traits_compute_contradiction(current_confidence: f64, is_explicit: bool) -> f64 {
    if is_explicit {
        0.0
    } else {
        (current_confidence * 0.5).max(0.0)
    }
}

// ── Decay Computation ──────────────────────────────

/// Compute decay actions for all traits.
/// Returns list of actions (delete/update) with new confidence values.
#[napi]
pub fn traits_compute_decay(
    traits: Vec<BehavioralTrait>,
) -> Vec<TraitDecayAction> {
    let now_ms = now_ms_f64();
    let mut actions: Vec<TraitDecayAction> = Vec::new();

    for t in &traits {
        let last_seen_ms = parse_ts_ms(&t.last_seen_ts);
        let days_inactive = ((now_ms - last_seen_ms) / (1000.0 * 60.0 * 60.0 * 24.0)).min(MAX_DECAY_DAYS);

        if days_inactive > 0.0 {
            let decay_factor = (-LAMBDA * days_inactive).exp();
            let new_conf = t.confidence.min(decay_factor);

            if new_conf < REMOVAL_THRESHOLD {
                actions.push(TraitDecayAction {
                    trait_key: t.trait_key.clone(),
                    action: "delete".to_string(),
                    new_confidence: new_conf,
                });
            } else if (new_conf - t.confidence).abs() > 0.001 {
                actions.push(TraitDecayAction {
                    trait_key: t.trait_key.clone(),
                    action: "update".to_string(),
                    new_confidence: new_conf,
                });
            }
        }
    }

    actions
}

// ── Token-Budgeted Trait Injection ─────────────────

/// Score and select traits for prompt injection within a token budget.
/// Returns the formatted injection string.
#[napi]
pub fn traits_get_injection(
    traits: Vec<BehavioralTrait>,
    query: String,
    token_budget: Option<u32>,
    correlation_json: Option<String>,
) -> String {
    if traits.is_empty() {
        return String::new();
    }

    let budget = token_budget.unwrap_or(TOKEN_BUDGET_DEFAULT as u32) as usize;
    let query_tokens = tokenize_for_relevance(&query);

    // Check predictive cache
    {
        let cache = PRED_CACHE.lock();
        if let Some(ref pc) = *cache {
            if !pc.snippet.is_empty()
                && (now_ms_f64() - pc.timestamp) < PREDICTIVE_CACHE_TTL_MS
            {
                let cache_sim = compute_query_similarity(&query_tokens, &pc.query_tokens);
                if cache_sim > 0.6 {
                    return pc.snippet.clone();
                }
            }
        }
    }

    // Load correlation map
    let correlation_map = if let Some(ref json) = correlation_json {
        load_correlation_map(json)
    } else {
        HashMap::new()
    };

    // Score each trait
    let mut scored: Vec<ScoredTrait> = traits
        .iter()
        .filter(|t| t.confidence >= 0.3)
        .map(|t| {
            let relevance = compute_relevance(&query_tokens, t);
            let recency_weight = compute_recency_weight(&t.last_seen_ts);
            let stability_bonus = ((t.reinforcement_count as f64) + 1.0).ln();
            let correlation_boost = correlation_map.get(&t.trait_key).copied().unwrap_or(0.0);
            let priority = t.confidence
                * relevance
                * recency_weight
                * (1.0 + STABILITY_BONUS_WEIGHT * stability_bonus)
                * (1.0 + 0.05 * correlation_boost);

            let line = format_trait_line(t);
            let line_tokens = estimate_tokens(&line);

            ScoredTrait {
                trait_key: t.trait_key.clone(),
                value: t.value.clone(),
                confidence: t.confidence,
                priority,
                line,
                line_tokens,
            }
        })
        .collect();

    scored.sort_by(|a, b| b.priority.partial_cmp(&a.priority).unwrap_or(std::cmp::Ordering::Equal));

    // Select within token budget
    let mut selected: Vec<&ScoredTrait> = Vec::new();
    let mut used_tokens: usize = 0;

    for s in &scored {
        if selected.len() >= MAX_TRAITS_INJECTION {
            break;
        }
        if used_tokens + s.line_tokens as usize > budget {
            break;
        }
        selected.push(s);
        used_tokens += s.line_tokens as usize;
    }

    if selected.is_empty() {
        return String::new();
    }

    let lines: Vec<&str> = selected.iter().map(|s| s.line.as_str()).collect();
    let snippet = format!("### USER BEHAVIORAL PROFILE\n{}", lines.join("\n"));

    // Update predictive cache
    {
        let mut cache = PRED_CACHE.lock();
        *cache = Some(PredictiveCache {
            snippet: snippet.clone(),
            query_tokens,
            timestamp: now_ms_f64(),
        });
    }

    snippet
}

// ── Co-occurrence Recording ────────────────────────

/// Get list of traits updated in the current session (for co-occurrence recording).
#[napi]
pub fn traits_get_session_updates() -> Vec<String> {
    let state = SESSION_STATE.lock();
    state.session_trait_updates.iter().cloned().collect()
}

/// Compute all co-occurrence pairs from session-updated traits.
/// Returns pairs of (trait_a, trait_b) in consistent order.
#[napi]
pub fn traits_compute_cooccurrence_pairs(traits: Vec<String>) -> Vec<Vec<String>> {
    let mut pairs: Vec<Vec<String>> = Vec::new();
    for i in 0..traits.len() {
        for j in (i + 1)..traits.len() {
            let (a, b) = if traits[i] < traits[j] {
                (traits[i].clone(), traits[j].clone())
            } else {
                (traits[j].clone(), traits[i].clone())
            };
            pairs.push(vec![a, b]);
        }
    }
    pairs
}

/// Compute query similarity between two token sets.
#[napi]
pub fn traits_query_similarity(tokens_a: Vec<String>, tokens_b: Vec<String>) -> f64 {
    let set_a: HashSet<String> = tokens_a.into_iter().collect();
    let set_b: HashSet<String> = tokens_b.into_iter().collect();
    compute_query_similarity(&set_a, &set_b)
}

// ── Internals ──────────────────────────────────────

fn tokenize_for_relevance(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.len() > 2 && !STOPWORDS.contains(w))
        .map(|w| basic_stem(w))
        .collect()
}

fn basic_stem(word: &str) -> String {
    let mut w = word.to_string();
    for suffix in &["ing", "tion", "ness", "ment", "able", "ful", "ly", "ed", "er", "es", "s"] {
        if w.len() > suffix.len() + 2 && w.ends_with(suffix) {
            w = w[..w.len() - suffix.len()].to_string();
            break;
        }
    }
    // Special case: "tion" -> "t"
    if word.ends_with("tion") && word.len() > 5 {
        return format!("{}t", &word[..word.len() - 4]);
    }
    w
}

fn compute_relevance(query_tokens: &HashSet<String>, trait_val: &BehavioralTrait) -> f64 {
    if query_tokens.is_empty() {
        return 0.5;
    }

    let trait_text = format!(
        "{} {} {}",
        trait_val.trait_key.replace('_', " "),
        trait_val.value,
        trait_val.topics.join(" ")
    );
    let trait_tokens = tokenize_for_relevance(&trait_text);
    if trait_tokens.is_empty() {
        return 0.3;
    }

    let overlap = query_tokens
        .iter()
        .filter(|t| trait_tokens.contains(*t))
        .count();
    let similarity =
        overlap as f64 / (query_tokens.len().min(trait_tokens.len()).max(1)) as f64;

    0.3 + 0.7 * similarity
}

fn compute_recency_weight(last_seen_ts: &str) -> f64 {
    let now_ms = now_ms_f64();
    let ts_ms = parse_ts_ms(last_seen_ts);
    let days_ago = (now_ms - ts_ms) / (1000.0 * 60.0 * 60.0 * 24.0);
    (-0.05 * days_ago).exp().max(0.5)
}

fn compute_query_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let overlap = a.iter().filter(|t| b.contains(*t)).count();
    overlap as f64 / a.len().max(b.len()) as f64
}

fn format_trait_line(t: &BehavioralTrait) -> String {
    let conf = (t.confidence * 100.0).round() as u32;
    let key_formatted = t
        .trait_key
        .replace('_', " ")
        .split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => {
                    let upper: String = f.to_uppercase().collect();
                    format!("{}{}", upper, c.as_str())
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("- {}: {} (confidence {}%)", key_formatted, t.value, conf)
}

fn estimate_tokens(text: &str) -> u32 {
    ((text.len() as f64) / 4.0).ceil() as u32
}

fn load_correlation_map(json: &str) -> HashMap<String, f64> {
    #[derive(Deserialize)]
    struct Edge {
        trait_a: String,
        trait_b: String,
        weight: f64,
    }

    let edges: Vec<Edge> = serde_json::from_str(json).unwrap_or_default();
    let mut map: HashMap<String, f64> = HashMap::new();

    for edge in &edges {
        if edge.weight > 0.2 {
            *map.entry(edge.trait_a.clone()).or_insert(0.0) += edge.weight;
            *map.entry(edge.trait_b.clone()).or_insert(0.0) += edge.weight;
        }
    }

    map
}

fn now_ms_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

fn parse_ts_ms(ts: &str) -> f64 {
    // Try as epoch seconds first
    if let Ok(secs) = ts.split('.').next().unwrap_or("0").parse::<f64>() {
        if secs > 1_000_000_000.0 {
            return secs * 1000.0;
        }
    }
    // Fallback: assume it's already ms or very old
    0.0
}
