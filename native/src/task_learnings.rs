// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Task Learnings — Full port of src/memory/task-learnings.ts

use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ── Constants ──────────────────────────────────────

const MAX_STORE_SIZE: usize = 200;
const MAX_LIST_SIZE: usize = 10;
const MAX_CLICK_STRATEGIES: usize = 30;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ClickStrategy {
    pub app_name: String,
    pub element_label: String,
    pub success_offset_x: f64,
    pub success_offset_y: f64,
    pub attempts_taken: u32,
    pub last_success_at: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskLearning {
    pub id: String,
    pub category: String, // "browser" | "os" | "app"
    pub task_pattern: String,
    pub context: String,
    pub what_worked: Vec<String>,
    pub what_failed: Vec<String>,
    pub tips: Vec<String>,
    pub success_score: f64,
    pub times_reinforced: u32,
    pub last_seen: String,
    pub click_strategies: Vec<ClickStrategy>,
}

// ── Store ──────────────────────────────────────────

struct LearningsStore {
    learnings: Vec<TaskLearning>,
    counter: u32,
}

impl LearningsStore {
    fn new() -> Self {
        Self {
            learnings: Vec::new(),
            counter: 0,
        }
    }
}

lazy_static::lazy_static! {
    static ref STORE: Mutex<LearningsStore> = Mutex::new(LearningsStore::new());
}

// ── Init / Load / Save ─────────────────────────────

/// Load learnings from JSON string (called from JS with file contents)
#[napi]
pub fn task_learnings_load(json: String) -> u32 {
    let mut store = STORE.lock();
    if let Ok(parsed) = serde_json::from_str::<StoreSerialized>(&json) {
        store.learnings = parsed.learnings;
        store.counter = store.learnings.len() as u32;
        return store.counter;
    }
    0
}

/// Export learnings as JSON string (for persistence to disk)
#[napi]
pub fn task_learnings_save() -> String {
    let store = STORE.lock();
    let serialized = StoreSerialized {
        learnings: store.learnings.clone(),
    };
    serde_json::to_string_pretty(&serialized).unwrap_or_default()
}

#[derive(Serialize, Deserialize)]
struct StoreSerialized {
    learnings: Vec<TaskLearning>,
}

// ── Upsert ─────────────────────────────────────────

/// Upsert a learning entry. Merges into existing if same task+context found.
#[napi]
pub fn task_learnings_upsert(
    category: String,
    task_pattern: String,
    context: String,
    what_worked: Vec<String>,
    what_failed: Vec<String>,
    tips: Vec<String>,
    success_score: f64,
) -> TaskLearning {
    let mut store = STORE.lock();
    let pattern_lower = task_pattern.to_lowercase();
    let context_lower = context.to_lowercase();

    // Try to find existing
    if let Some(existing) = store.learnings.iter_mut().find(|l| {
        l.category == category
            && l.task_pattern.to_lowercase() == pattern_lower
            && l.context.to_lowercase() == context_lower
    }) {
        // Merge
        existing.what_worked = merge_string_lists(&existing.what_worked, &what_worked);
        existing.what_failed = merge_string_lists(&existing.what_failed, &what_failed);
        existing.tips = merge_string_lists(&existing.tips, &tips);
        existing.success_score = (existing.success_score * existing.times_reinforced as f64
            + success_score)
            / (existing.times_reinforced as f64 + 1.0);
        existing.times_reinforced += 1;
        existing.last_seen = now_iso();
        return existing.clone();
    }

    // New entry
    store.counter += 1;
    let entry = TaskLearning {
        id: format!("learn_{}", store.counter),
        category,
        task_pattern,
        context,
        what_worked: what_worked.into_iter().take(MAX_LIST_SIZE).collect(),
        what_failed: what_failed.into_iter().take(MAX_LIST_SIZE).collect(),
        tips: tips.into_iter().take(MAX_LIST_SIZE).collect(),
        success_score,
        times_reinforced: 1,
        last_seen: now_iso(),
        click_strategies: Vec::new(),
    };

    store.learnings.push(entry.clone());

    // Keep store bounded
    if store.learnings.len() > MAX_STORE_SIZE {
        store
            .learnings
            .sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        store.learnings.truncate(MAX_STORE_SIZE);
    }

    entry
}

// ── Recall ─────────────────────────────────────────

/// Recall learnings matching a task description.
/// Returns top 3 scored matches.
#[napi]
pub fn task_learnings_recall(task: String, category: Option<String>) -> Vec<TaskLearning> {
    let store = STORE.lock();
    let task_lower = task.to_lowercase();
    let keywords: Vec<String> = task_lower
        .split_whitespace()
        .filter(|w| w.len() > 3)
        .map(|w| w.to_string())
        .collect();

    let mut scored: Vec<(usize, f64)> = Vec::new();
    let now_ms = now_ms_f64();

    for (i, entry) in store.learnings.iter().enumerate() {
        if let Some(ref cat) = category {
            if entry.category != *cat {
                continue;
            }
        }

        let mut score: f64 = 0.0;
        let pattern_lower = entry.task_pattern.to_lowercase();
        let context_lower = entry.context.to_lowercase();

        for kw in &keywords {
            if pattern_lower.contains(kw.as_str()) {
                score += 2.0;
            }
            if context_lower.contains(kw.as_str()) {
                score += 1.0;
            }
            let first_ctx_word = context_lower.split_whitespace().next().unwrap_or("");
            if task_lower.contains(first_ctx_word) && !first_ctx_word.is_empty() {
                score += 1.0;
            }
        }

        // Recency bonus (parse ISO date)
        let days_since = days_since_iso(&entry.last_seen, now_ms);
        if days_since < 7.0 {
            score += 2.0;
        }

        // Reinforcement bonus (capped at 5)
        score += (entry.times_reinforced as f64).min(5.0);

        // Success score bonus
        score += entry.success_score * 2.0;

        if score > 2.0 {
            scored.push((i, score));
        }
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    scored
        .into_iter()
        .take(3)
        .map(|(i, _)| store.learnings[i].clone())
        .collect()
}

/// Generate context snippet for agent prompt injection.
#[napi]
pub fn task_learnings_context(task: String, category: Option<String>) -> String {
    let matches = task_learnings_recall(task, category);
    if matches.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("PAST LEARNINGS for similar tasks:".to_string());

    for m in &matches {
        lines.push(format!(
            "\n[{}] \"{}\" ({}) -- success: {:.0}%, used {}x",
            m.category.to_uppercase(),
            m.task_pattern,
            m.context,
            m.success_score * 100.0,
            m.times_reinforced
        ));
        if !m.what_worked.is_empty() {
            lines.push(format!("  Worked: {}", m.what_worked.join(" | ")));
        }
        if !m.what_failed.is_empty() {
            lines.push(format!("  Failed: {}", m.what_failed.join(" | ")));
        }
        if !m.tips.is_empty() {
            lines.push(format!("  Tips: {}", m.tips.join(" | ")));
        }
    }

    lines.join("\n")
}

// ── Click Strategy Learning ────────────────────────

/// Record a click strategy for an app element.
#[napi]
pub fn task_learnings_record_click(
    app_name: String,
    element_label: String,
    offset_x: f64,
    offset_y: f64,
    attempts_taken: u32,
) {
    let mut store = STORE.lock();
    let app_lower = app_name.to_lowercase();
    let label_lower = element_label.to_lowercase();

    // Find or create OS learning entry for this app
    let entry = if let Some(existing) = store
        .learnings
        .iter_mut()
        .find(|l| l.category == "os" && l.context.to_lowercase() == app_lower)
    {
        existing
    } else {
        store.counter += 1;
        let new_entry = TaskLearning {
            id: format!("learn_{}", store.counter),
            category: "os".to_string(),
            task_pattern: format!("interact with {}", app_name),
            context: app_name.clone(),
            what_worked: Vec::new(),
            what_failed: Vec::new(),
            tips: Vec::new(),
            success_score: 1.0,
            times_reinforced: 1,
            last_seen: now_iso(),
            click_strategies: Vec::new(),
        };
        store.learnings.push(new_entry);
        store.learnings.last_mut().unwrap()
    };

    // Update existing strategy or add new
    if let Some(existing_strat) = entry
        .click_strategies
        .iter_mut()
        .find(|s| s.element_label.to_lowercase() == label_lower)
    {
        // Running average of offsets
        existing_strat.success_offset_x =
            ((existing_strat.success_offset_x + offset_x) / 2.0).round();
        existing_strat.success_offset_y =
            ((existing_strat.success_offset_y + offset_y) / 2.0).round();
        existing_strat.attempts_taken =
            ((existing_strat.attempts_taken as f64 + attempts_taken as f64) / 2.0).round() as u32;
        existing_strat.last_success_at = now_iso();
    } else {
        entry.click_strategies.push(ClickStrategy {
            app_name: app_name.clone(),
            element_label: element_label.clone(),
            success_offset_x: offset_x,
            success_offset_y: offset_y,
            attempts_taken,
            last_success_at: now_iso(),
        });

        // Cap at MAX_CLICK_STRATEGIES
        if entry.click_strategies.len() > MAX_CLICK_STRATEGIES {
            entry
                .click_strategies
                .sort_by(|a, b| b.last_success_at.cmp(&a.last_success_at));
            entry.click_strategies.truncate(MAX_CLICK_STRATEGIES);
        }
    }

    entry.last_seen = now_iso();
    entry.times_reinforced += 1;
}

/// Get click strategies context for an app.
#[napi]
pub fn task_learnings_click_context(app_name: String) -> String {
    let store = STORE.lock();
    let app_lower = app_name.to_lowercase();

    let entry = store
        .learnings
        .iter()
        .find(|l| l.category == "os" && l.context.to_lowercase() == app_lower);

    let entry = match entry {
        Some(e) if !e.click_strategies.is_empty() => e,
        _ => return String::new(),
    };

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("LEARNED CLICK OFFSETS for {}:", app_name));

    let now_ms = now_ms_f64();
    for s in entry.click_strategies.iter().take(10) {
        let days_ago = days_since_iso(&s.last_success_at, now_ms);
        let time_label = if days_ago < 1.0 {
            "today".to_string()
        } else {
            format!("{:.0}d ago", days_ago)
        };
        lines.push(format!(
            "  \"{}\" -> offset({}, {}) -- took {} attempt(s), {}",
            s.element_label, s.success_offset_x, s.success_offset_y, s.attempts_taken, time_label
        ));
    }

    lines.join("\n")
}

/// Get all learnings (for introspection)
#[napi]
pub fn task_learnings_get_all() -> Vec<TaskLearning> {
    let store = STORE.lock();
    store.learnings.clone()
}

// ── Helpers ────────────────────────────────────────

fn merge_string_lists(old: &[String], incoming: &[String]) -> Vec<String> {
    let mut combined = old.to_vec();
    let existing: HashSet<String> = combined.iter().map(|s| s.to_lowercase()).collect();

    for item in incoming {
        if !existing.contains(&item.to_lowercase()) {
            combined.push(item.clone());
        }
    }

    // Cap at 10
    if combined.len() > MAX_LIST_SIZE {
        combined = combined[combined.len() - MAX_LIST_SIZE..].to_vec();
    }
    combined
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Simple ISO format
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    format!("{}.{:03}", secs, ms)
}

fn now_ms_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

fn days_since_iso(iso: &str, now_ms: f64) -> f64 {
    // Try to parse as epoch seconds
    if let Ok(secs) = iso.split('.').next().unwrap_or("0").parse::<f64>() {
        let ts_ms = secs * 1000.0;
        return (now_ms - ts_ms) / 86_400_000.0;
    }
    365.0 // fallback: old
}
