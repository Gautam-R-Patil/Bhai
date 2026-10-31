// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Tool Router Analytics — Rust port via napi-rs
// Tracks tool usage patterns to improve future selections:
// - Co-occurrence matrix: which tools are used together
// - Tool success rates: which tools complete without errors
// - Common task chains: pre-defined + learned workflows

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ── Constants ────────────────────────────────

const MAX_RECENT_USAGE: usize = 100;
const SAVE_DEBOUNCE_MS: u64 = 5000;

// ── Types ────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUsageRecord {
    pub tools_used: Vec<String>,
    pub categories: Vec<String>,
    pub timestamp: f64,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessStats {
    pub success: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoOccurrenceData {
    /// tool -> other tools used in same session
    pub matrix: HashMap<String, HashMap<String, u32>>,
    /// How many times each tool has been used
    #[serde(rename = "toolCounts")]
    pub tool_counts: HashMap<String, u32>,
    /// Success rate per tool
    #[serde(rename = "toolSuccess")]
    pub tool_success: HashMap<String, SuccessStats>,
    /// Last 100 usage records for analysis
    #[serde(rename = "recentUsage")]
    pub recent_usage: Vec<ToolUsageRecord>,
    /// Version for future migrations
    pub version: u32,
}

impl Default for CoOccurrenceData {
    fn default() -> Self {
        Self {
            matrix: HashMap::new(),
            tool_counts: HashMap::new(),
            tool_success: HashMap::new(),
            recent_usage: Vec::new(),
            version: 1,
        }
    }
}

// ── Result types for NAPI ────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ToolCount {
    pub tool: String,
    pub count: u32,
}

// ── State ────────────────────────────────────

#[derive(Default)]
struct AnalyticsState {
    data: CoOccurrenceData,
    initialized: bool,
    last_save: Option<Instant>,
    last_decay: Option<Instant>,
    dirty: bool,
}

// Decay co-occurrence counts daily (0.95x multiplier).
// Prevents stale tool habits from dominating recommendations.
const DECAY_INTERVAL_MS: u128 = 86_400_000; // 24 hours
const DECAY_FACTOR: f64 = 0.95;

fn maybe_decay_cooccurrence(state: &mut AnalyticsState) {
    let should_decay = match state.last_decay {
        Some(last) => last.elapsed().as_millis() >= DECAY_INTERVAL_MS,
        None => true,
    };
    if !should_decay {
        return;
    }

    // Decay all co-occurrence counts
    for row in state.data.matrix.values_mut() {
        for count in row.values_mut() {
            let decayed = (*count as f64 * DECAY_FACTOR).round() as u32;
            *count = decayed;
        }
        // Remove zero entries
        row.retain(|_, v| *v > 0);
    }
    // Remove empty rows
    state.data.matrix.retain(|_, v| !v.is_empty());

    // Also decay tool counts (slower — 0.98x)
    for count in state.data.tool_counts.values_mut() {
        let decayed = (*count as f64 * 0.98).round() as u32;
        *count = decayed;
    }
    state.data.tool_counts.retain(|_, v| *v > 0);

    state.last_decay = Some(Instant::now());
    state.dirty = true;
}

lazy_static! {
    static ref STATE: Mutex<AnalyticsState> = Mutex::new(AnalyticsState::default());

    static ref COMMON_TASK_CHAINS: HashMap<&'static str, Vec<&'static str>> = {
        let mut m = HashMap::new();
        // Research flows
        m.insert("web_research", vec!["web_search", "browser", "file_system"]);
        m.insert("deep_investigation", vec!["web_search", "browser", "research", "file_system"]);
        // Coding flows
        m.insert("code_project", vec!["shell", "file_system", "browser"]);
        m.insert("build_website", vec!["shell", "file_system", "browser", "long_tasks"]);
        m.insert("fix_bug", vec!["shell", "file_system"]);
        // Media flows
        m.insert("create_content", vec!["browser", "media", "file_system"]);
        m.insert("music_session", vec!["media", "web_search"]);
        // Automation flows
        m.insert("system_automation", vec!["os_control", "shell", "app_management"]);
        m.insert("scheduled_task", vec!["scheduling", "shell", "communication"]);
        // Communication flows
        m.insert("email_workflow", vec!["google_api", "communication", "file_system"]);
        m.insert("meeting_prep", vec!["google_api", "scheduling", "web_search"]);
        // Multi-URL browser tasks
        m.insert("multi_url_task", vec!["browser", "web_search"]);
        m.insert("download_task", vec!["browser", "file_system", "shell"]);
        m.insert("code_review", vec!["shell", "file_system", "github"]);
        m.insert("desktop_automation", vec!["os_control", "app_management", "shell"]);
        m
    };
}

// ── Helpers ──────────────────────────────────

fn analytics_file_path() -> PathBuf {
    bhai_home().join("data").join("tool-analytics.json")
}

/// Same rule as getBhaiHome() in src/config/paths.ts: $BHAI_HOME, else ~/.bhai,
/// else the pre-rename ~/.atlas when only that exists (the copy to ~/.bhai failed).
fn bhai_home() -> PathBuf {
    resolve_bhai_home(
        std::env::var_os("BHAI_HOME"),
        dirs_next().unwrap_or_else(|| PathBuf::from(".")),
    )
}

fn resolve_bhai_home(env_home: Option<std::ffi::OsString>, home: PathBuf) -> PathBuf {
    if let Some(dir) = env_home.filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    let (current, legacy) = (home.join(".bhai"), home.join(".atlas"));
    if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    }
}

fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

fn ensure_init(state: &mut AnalyticsState) {
    if state.initialized {
        return;
    }
    do_init(state);
}

fn do_init(state: &mut AnalyticsState) {
    let path = analytics_file_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<CoOccurrenceData>(&raw) {
                Ok(loaded) => {
                    let count = loaded.matrix.len();
                    state.data = loaded;
                    eprintln!("📊 Tool Analytics: Loaded {} tool patterns", count);
                }
                Err(e) => {
                    eprintln!("📊 Tool Analytics: Failed to parse, starting fresh: {}", e);
                }
            },
            Err(e) => {
                eprintln!("📊 Tool Analytics: Failed to load, starting fresh: {}", e);
            }
        }
    } else {
        eprintln!("📊 Tool Analytics: Starting fresh");
    }

    state.initialized = true;
}

/// Debounced save: only writes if dirty and at least SAVE_DEBOUNCE_MS since last save.
fn maybe_save(state: &mut AnalyticsState) {
    if !state.dirty {
        return;
    }

    let should_save = match state.last_save {
        None => true,
        Some(last) => last.elapsed() >= Duration::from_millis(SAVE_DEBOUNCE_MS),
    };

    if should_save {
        do_save(state);
    }
    // If not enough time has elapsed, the next recordToolUsage or
    // explicit flush will trigger the save.
}

fn do_save(state: &mut AnalyticsState) {
    let path = analytics_file_path();
    match serde_json::to_string_pretty(&state.data) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("📊 Tool Analytics: Failed to save: {}", e);
            }
        }
        Err(e) => {
            eprintln!("📊 Tool Analytics: Failed to serialize: {}", e);
        }
    }
    state.last_save = Some(Instant::now());
    state.dirty = false;
}

// ── Exported Functions ───────────────────────

/// Initialize the analytics system, loading data from disk.
#[napi]
pub fn init_analytics() {
    let mut state = STATE.lock();
    if state.initialized {
        return;
    }
    do_init(&mut state);
}

/// Record tool usage for a session.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RecordToolUsageOpts {
    pub tools_used: Vec<String>,
    pub categories: Vec<String>,
    pub success: Option<bool>,
}

#[napi]
pub fn record_tool_usage(opts: RecordToolUsageOpts) {
    let mut state = STATE.lock();
    ensure_init(&mut state);
    maybe_decay_cooccurrence(&mut state);

    let tools_used = opts.tools_used;
    let categories = opts.categories;
    let success = opts.success.unwrap_or(true);

    if tools_used.is_empty() {
        return;
    }

    // Update co-occurrence matrix
    for tool in &tools_used {
        let counts_entry = state.data.tool_counts.entry(tool.clone()).or_insert(0);
        *counts_entry += 1;

        let success_entry = state
            .data
            .tool_success
            .entry(tool.clone())
            .or_insert(SuccessStats {
                success: 0,
                total: 0,
            });
        success_entry.total += 1;
        if success {
            success_entry.success += 1;
        }

        let matrix_row = state.data.matrix.entry(tool.clone()).or_default();
        for other_tool in &tools_used {
            if other_tool != tool {
                let count = matrix_row.entry(other_tool.clone()).or_insert(0);
                *count += 1;
            }
        }
    }

    // Add to recent usage
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;

    state.data.recent_usage.push(ToolUsageRecord {
        tools_used,
        categories,
        timestamp: now,
        success,
    });

    // Trim to max size
    let len = state.data.recent_usage.len();
    if len > MAX_RECENT_USAGE {
        let drain_count = len - MAX_RECENT_USAGE;
        state.data.recent_usage.drain(..drain_count);
    }

    state.dirty = true;
    maybe_save(&mut state);
}

/// Get tools that co-occur with the given tool.
#[napi]
pub fn get_co_occurring_tools(tool: String, min_count: Option<u32>) -> Vec<String> {
    let mut state = STATE.lock();
    ensure_init(&mut state);

    let min_count = min_count.unwrap_or(3);

    let row = match state.data.matrix.get(&tool) {
        Some(r) => r,
        None => return Vec::new(),
    };

    let mut entries: Vec<(&String, &u32)> = row
        .iter()
        .filter(|(_, count)| **count >= min_count)
        .collect();
    entries.sort_by(|a, b| b.1.cmp(a.1));

    entries.into_iter().map(|(t, _)| t.clone()).collect()
}

/// Get categories that are likely needed based on selected categories.
#[napi]
pub fn get_likely_categories(selected_categories: Vec<String>) -> Vec<String> {
    let mut state = STATE.lock();
    ensure_init(&mut state);

    // Check pre-defined chains first
    for (_chain_name, chain_categories) in COMMON_TASK_CHAINS.iter() {
        let overlap: Vec<&String> = selected_categories
            .iter()
            .filter(|c| chain_categories.contains(&c.as_str()))
            .collect();

        if overlap.len() >= 2 {
            let missing: Vec<String> = chain_categories
                .iter()
                .filter(|c| !selected_categories.contains(&c.to_string()))
                .map(|c| c.to_string())
                .collect();

            if !missing.is_empty() {
                return missing;
            }
        }
    }

    // Analyze recent usage patterns
    let recent_with_same: Vec<&ToolUsageRecord> = state
        .data
        .recent_usage
        .iter()
        .filter(|record| {
            record
                .categories
                .iter()
                .any(|c| selected_categories.contains(c))
        })
        .collect();

    if recent_with_same.len() < 3 {
        return Vec::new();
    }

    // Find categories that frequently appear with selected ones
    let mut category_counts: HashMap<String, usize> = HashMap::new();
    for record in &recent_with_same {
        for cat in &record.categories {
            if !selected_categories.contains(cat) {
                *category_counts.entry(cat.clone()).or_insert(0) += 1;
            }
        }
    }

    // Return categories that appear in >30% of matching sessions
    let threshold = (recent_with_same.len() as f64 * 0.3) as usize;
    let mut results: Vec<(String, usize)> = category_counts
        .into_iter()
        .filter(|(_, count)| *count >= threshold)
        .collect();
    results.sort_by(|a, b| b.1.cmp(&a.1));
    results.truncate(2); // Max 2 preloaded categories

    results.into_iter().map(|(cat, _)| cat).collect()
}

/// Get the success rate for a given tool (0.0 to 1.0).
#[napi]
pub fn get_tool_success_rate(tool: String) -> f64 {
    let mut state = STATE.lock();
    ensure_init(&mut state);

    match state.data.tool_success.get(&tool) {
        Some(stats) if stats.total > 0 => stats.success as f64 / stats.total as f64,
        _ => 1.0, // Assume good until proven otherwise
    }
}

/// Get the most used tools, sorted by usage count.
#[napi]
pub fn get_most_used_tools(limit: Option<u32>) -> Vec<ToolCount> {
    let mut state = STATE.lock();
    ensure_init(&mut state);

    let limit = limit.unwrap_or(10) as usize;

    let mut entries: Vec<(&String, &u32)> = state.data.tool_counts.iter().collect();
    entries.sort_by(|a, b| b.1.cmp(a.1));
    entries.truncate(limit);

    entries
        .into_iter()
        .map(|(tool, count)| ToolCount {
            tool: tool.clone(),
            count: *count,
        })
        .collect()
}

/// Detect a task chain from a message using pattern matching.
/// Returns the chain name or null.
#[napi]
pub fn detect_task_chain(message: String) -> Option<String> {
    let lower = message.to_lowercase();

    if lower.contains("research")
        && (lower.contains("deep") || lower.contains("investigate") || lower.contains("thorough"))
    {
        return Some("deep_investigation".to_string());
    }
    if lower.contains("search")
        && (lower.contains("web") || lower.contains("google") || lower.contains("look up"))
    {
        return Some("web_research".to_string());
    }
    if lower.contains("build")
        && (lower.contains("website") || lower.contains("site") || lower.contains("app"))
    {
        return Some("build_website".to_string());
    }
    if lower.contains("code") || lower.contains("program") || lower.contains("develop") {
        return Some("code_project".to_string());
    }
    if lower.contains("fix")
        && (lower.contains("bug") || lower.contains("error") || lower.contains("issue"))
    {
        return Some("fix_bug".to_string());
    }
    if lower.contains("music") || lower.contains("spotify") || lower.contains("play") {
        return Some("music_session".to_string());
    }
    if lower.contains("email") || lower.contains("gmail") {
        return Some("email_workflow".to_string());
    }
    if lower.contains("meeting") || lower.contains("calendar") {
        return Some("meeting_prep".to_string());
    }
    if lower.contains("automate") || lower.contains("script") || lower.contains("shortcut") {
        return Some("system_automation".to_string());
    }
    // Multi-URL tasks: 3+ URLs in the message
    let url_count = lower.matches("http").count();
    if url_count >= 3 {
        return Some("multi_url_task".to_string());
    }
    if lower.contains("download") {
        return Some("download_task".to_string());
    }
    if lower.contains("review")
        && (lower.contains("pr") || lower.contains("pull request") || lower.contains("code"))
    {
        return Some("code_review".to_string());
    }
    if lower.contains("click") || lower.contains("open app") || lower.contains("desktop") {
        return Some("desktop_automation".to_string());
    }

    None
}

/// Get the categories for a given task chain name.
#[napi]
pub fn get_categories_for_chain(chain_name: String) -> Vec<String> {
    COMMON_TASK_CHAINS
        .get(chain_name.as_str())
        .map(|cats| cats.iter().map(|c| c.to_string()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod home_tests {
    use super::resolve_bhai_home;
    use std::fs;

    #[test]
    fn bhai_home_prefers_env_then_bhai_then_old_atlas() {
        let tmp = std::env::temp_dir().join(format!("bhai-home-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        assert_eq!(
            resolve_bhai_home(Some("/x".into()), tmp.clone()),
            std::path::PathBuf::from("/x")
        );
        assert_eq!(resolve_bhai_home(None, tmp.clone()), tmp.join(".bhai"));
        fs::create_dir(tmp.join(".atlas")).unwrap();
        assert_eq!(resolve_bhai_home(None, tmp.clone()), tmp.join(".atlas"));
        fs::create_dir(tmp.join(".bhai")).unwrap();
        assert_eq!(resolve_bhai_home(None, tmp.clone()), tmp.join(".bhai"));
        let _ = fs::remove_dir_all(&tmp);
    }
}
