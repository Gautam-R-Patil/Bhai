// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Tool Router — Rust port of structural classification, cache, scoring,
// request_tools handling, and stats.
// Embedding pipeline stays in JS; pre-computed Float32Array vectors are
// passed here for SIMD-accelerated cosine similarity scoring.

use std::collections::{HashMap, HashSet};

use lazy_static::lazy_static;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

// ── Category Definitions ─────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryDef {
    pub description: String,
    pub tools: Vec<String>,
    pub always_include: bool,
}

lazy_static! {
    static ref CATEGORIES: HashMap<&'static str, CategoryDef> = {
        let mut m = HashMap::new();
        m.insert("core", CategoryDef {
            description: "Basic utilities: getting the current time, date, timezone lookups. Always needed for any task.".into(),
            tools: vec!["get_current_time".into()],
            always_include: true,
        });
        m.insert("memory", CategoryDef {
            description: "Remembering information, storing facts, searching past memories, recalling what the user told me before, remembering preferences, saving notes, managing knowledge and identity information about the user.".into(),
            tools: vec!["memory_store".into(), "memory_search".into(), "memory_list".into(), "memory_delete".into(), "identity_view".into(), "identity_update".into(), "trait_update".into(), "trait_list".into(), "memory_snapshot".into()],
            always_include: true,
        });
        m.insert("shell", CategoryDef {
            description: "Running terminal commands, executing shell scripts, system administration, installing packages with npm pip brew apt, running code, compiling, building projects, git operations, checking processes, development workflow.".into(),
            tools: vec!["shell_exec".into(), "shell_exec_background".into(), "shell_check_process".into(), "shell_wait_process".into(), "shell_kill_process".into()],
            always_include: false,
        });
        m.insert("file_system", CategoryDef {
            description: "Reading files, writing files, creating files, editing documents, listing directories, searching files by name or content, deleting files, file metadata, compressing archives, managing the trash can, opening files in applications.".into(),
            tools: vec!["read_file".into(), "write_file".into(), "list_directory".into(), "search_files".into(), "delete_file".into(), "file_metadata".into(), "compress_files".into(), "trash_manager".into(), "open_in_app".into()],
            always_include: false,
        });
        m.insert("browser", CategoryDef {
            description: "Web browsing, navigating to websites and URLs, clicking on web page elements, typing into web forms, scrolling web pages, extracting data from websites, scraping, automating web interactions, filling out online forms, logging into websites, web page analysis, tab management, uploading files to websites, downloading from the web, opening multiple URLs in parallel tabs, batch processing multiple pages simultaneously. Solving CAPTCHAs (reCAPTCHA, hCaptcha, Cloudflare Turnstile), handling cookie banners, dismissing popups. Playing YouTube videos, controlling video players.".into(),
            tools: vec!["browser_navigate".into(), "browser_click_at".into(), "browser_type".into(), "browser_scan".into(), "browser_extract".into(), "browser_back".into(), "browser_scroll".into(), "browser_analyze".into(), "browser_run_js".into(), "browser_wait".into(), "browser_select".into(), "browser_right_click".into(), "browser_hold_click".into(), "browser_drag".into(), "browser_hover".into(), "browser_keyboard".into(), "browser_switch_tab".into(), "browser_close".into(), "browser_upload_file".into(), "browser_multi_action".into(), "browser_scroll_element".into(), "browser_save_strategy".into(), "browser_recall_strategy".into(), "browser_replay_actions".into(), "browser_cache_actions".into(), "browser_parallel_tabs".into(), "browser_parallel_actions".into(), "browser_video_control".into(), "browser_handle_captcha".into(), "browser_batch_fetch".into(), "browser_auto_scroll".into(), "browser_network_requests".into(), "browser_form_state".into(), "browser_scroll_to_element".into(), "browser_intercept_start".into(), "browser_intercept_read".into(), "browser_extract_article".into(), "browser_connect_electron".into(), "browser_wait_for_selector".into(), "browser_set_mode".into(), "browser_chrome_status".into()],
            always_include: false,
        });
        m.insert("web_search", CategoryDef {
            description: "Searching the internet, looking up information online, Google search, finding answers, researching topics, fact-checking, finding news, looking up definitions or documentation.".into(),
            tools: vec!["web_search".into()],
            always_include: false,
        });
        m.insert("os_control", CategoryDef {
            description: "Controlling the computer's operating system, taking screenshots of the desktop, clicking on screen elements by coordinates or OCR text, typing into OS applications, interacting with native desktop apps, visual verification of UI elements, screen capture, mouse control, keyboard input automation, macOS Automator, AppleScript, PowerShell automation.".into(),
            tools: vec!["apple_script".into(), "os_screenshot".into(), "os_click".into(), "os_type".into(), "os_context".into(), "os_ocr_click".into(), "os_visual_verify".into(), "set_brightness".into(), "send_screenshot".into(), "powershell_script".into(), "win_os_screenshot".into(), "win_os_click".into(), "win_os_type".into(), "win_os_context".into(), "win_os_ocr_click".into(), "win_os_visual_verify".into(), "win_set_brightness".into(), "win_send_screenshot".into()],
            always_include: false,
        });
        m.insert("system_controls", CategoryDef {
            description: "System settings and hardware controls: volume, brightness, clipboard, system info, WiFi, Bluetooth, Do Not Disturb, dark mode, locking the screen, display sleep.".into(),
            tools: vec!["set_volume".into(), "clipboard".into(), "system_info".into(), "wifi_control".into(), "bluetooth_control".into(), "set_do_not_disturb".into(), "dark_mode".into(), "lock_screen".into(), "sleep_display".into()],
            always_include: false,
        });
        m.insert("media", CategoryDef {
            description: "Full Spotify control via the spogo CLI (works on Free + Premium, no public Web API). Apple Music control. Generating images and artwork, AI art, screen recording, video editing with DaVinci Resolve, 3D modeling with Blender.".into(),
            tools: vec!["spotify".into(), "music_control".into(), "generate_image".into(), "screen_record".into(), "blender_script".into(), "davinci_script".into()],
            always_include: false,
        });
        m.insert("communication", CategoryDef {
            description: "Sending emails, sending messages via iMessage or SMS, sending files to the user via Telegram, communication, notifications.".into(),
            tools: vec!["email_send".into(), "messages_tool".into(), "send_file".into()],
            always_include: false,
        });
        m.insert("scheduling", CategoryDef {
            description: "Scheduling tasks for later, creating reminders, managing calendar events, setting alarms, to-do lists, recurring tasks, planning events, managing webhooks.".into(),
            tools: vec!["schedule_task".into(), "set_reminder".into(), "list_tasks".into(), "cancel_task".into(), "calendar_tool".into(), "reminders_tool".into(), "register_webhook".into(), "list_webhooks".into(), "task_queue".into()],
            always_include: false,
        });
        m.insert("app_management", CategoryDef {
            description: "Managing applications, opening apps, closing apps, force-quitting apps, listing running apps, window management, moving windows, resizing windows, drag and drop operations, macOS Shortcuts.".into(),
            tools: vec!["app_manager".into(), "window_manage".into(), "os_drag".into(), "run_shortcut".into()],
            always_include: false,
        });
        m.insert("research", CategoryDef {
            description: "Deep research on complex topics, long-running research tasks, multi-source investigation, synthesizing information from many sources, writing research reports, academic research.".into(),
            tools: vec!["deep_research".into(), "check_deep_research".into(), "cancel_deep_research".into()],
            always_include: false,
        });
        m.insert("long_tasks", CategoryDef {
            description: "Long-running coding tasks, building entire websites, generating large codebases, multi-step complex projects that take a long time to complete, swarm orchestration for parallel sub-tasks.".into(),
            tools: vec!["start_long_task".into(), "check_long_task".into(), "cancel_long_task".into(), "resume_long_task".into(), "swarm_task".into()],
            always_include: false,
        });
        m.insert("google_api", CategoryDef {
            description: "Google services: Google Calendar for managing events, Gmail for reading and sending email, Google account management.".into(),
            tools: vec!["google_accounts".into(), "google_calendar".into(), "gmail".into()],
            always_include: false,
        });
        m.insert("github", CategoryDef {
            description: "GitHub operations: managing repositories, creating issues, pull requests, viewing code, GitHub API interactions.".into(),
            tools: vec!["github".into()],
            always_include: false,
        });
        m
    };

    // ── Structural Classification Patterns ──
    static ref PATTERNS: Vec<(&'static str, Vec<Regex>)> = vec![
        ("browser", vec![
            Regex::new(r"(?i)\b(brows|website|url|http|www\.|\.com|\.org|page|web ?page|navigate|login|sign.?in|form|click|scrape|download)\b").unwrap(),
            Regex::new(r"(?i)\b(tab|bookmark|cookie|html|css|javascript|dom|xpath)\b").unwrap(),
        ]),
        ("web_search", vec![
            Regex::new(r"(?i)\b(search|google|look ?up|find ?(out|info|about)|research|what is|who is|how to|define|explain)\b").unwrap(),
        ]),
        ("os_control", vec![
            Regex::new(r"(?i)\b(screenshot|screen ?shot|screen ?capture|click|mouse|keyboard|type|desktop|app|window|ocr|screen)\b").unwrap(),
            Regex::new(r"(?i)\b(apple ?script|automator|shortcut|finder|dock)\b").unwrap(),
        ]),
        ("shell", vec![
            Regex::new(r"(?i)\b(terminal|command|shell|bash|zsh|npm|pip|brew|apt|git|compile|build|run|execute|install|deploy|docker|process)\b").unwrap(),
            Regex::new(r"(?i)\b(mkdir|rm|ls|cd|cat|grep|chmod|curl|wget|ssh|scp|sudo)\b").unwrap(),
        ]),
        ("file_system", vec![
            Regex::new(r"(?i)\b(file|folder|directory|read|write|create|edit|save|delete|path|document|text|csv|json|pdf|copy|move|rename)\b").unwrap(),
        ]),
        ("media", vec![
            Regex::new(r"(?i)\b(spotify|music|song|play|pause|album|artist|playlist|image|picture|photo|generate|art|draw|paint|blender|3d|video|record)\b").unwrap(),
        ]),
        ("communication", vec![
            Regex::new(r"(?i)\b(email|mail|send|message|imessage|sms|text|notify|telegram)\b").unwrap(),
        ]),
        ("scheduling", vec![
            Regex::new(r"(?i)\b(schedule|remind|alarm|calendar|event|meeting|appointment|timer|cron|recurring|todo|task.?list|later|tomorrow|next week)\b").unwrap(),
        ]),
        ("system_controls", vec![
            Regex::new(r"(?i)\b(volume|brightness|wifi|bluetooth|dark ?mode|do not disturb|dnd|clipboard|lock|sleep|system ?info)\b").unwrap(),
        ]),
        ("app_management", vec![
            Regex::new(r"(?i)\b(open ?app|close ?app|force ?quit|window|resize|minimize|maximize|full ?screen|split|arrange)\b").unwrap(),
        ]),
        ("research", vec![
            Regex::new(r"(?i)\b(deep ?research|investigate|analyze|comprehensive|thorough|report|study|synthesis)\b").unwrap(),
        ]),
        ("long_tasks", vec![
            Regex::new(r"(?i)\b(build.*(website|app|project|codebase)|long.?running|complex.?task|entire|full|complete.*build|swarm)\b").unwrap(),
        ]),
        ("google_api", vec![
            Regex::new(r"(?i)\b(google|gmail|gcal|google ?calendar|google ?account)\b").unwrap(),
        ]),
        ("github", vec![
            Regex::new(r"(?i)\b(github|repo|repository|pull ?request|pr|issue|commit|branch|merge)\b").unwrap(),
        ]),
    ];

    // ── Synonym Map for Query Expansion ──
    static ref SYNONYMS: Vec<(&'static str, Vec<&'static str>)> = vec![
        ("make", vec!["create", "generate", "build", "produce"]),
        ("look up", vec!["search", "find", "query", "lookup"]),
        ("find", vec!["search", "locate", "discover", "look for"]),
        ("open", vec!["launch", "start", "run", "access"]),
        ("close", vec!["quit", "exit", "terminate", "stop"]),
        ("send", vec!["deliver", "transmit", "message", "email"]),
        ("save", vec!["store", "write", "preserve", "keep"]),
        ("delete", vec!["remove", "erase", "trash", "destroy"]),
        ("edit", vec!["modify", "change", "update", "alter"]),
        ("show", vec!["display", "present", "view", "reveal"]),
        ("get", vec!["fetch", "retrieve", "obtain", "download"]),
        ("play", vec!["start", "run", "execute", "stream"]),
    ];

    static ref SYNONYM_REGEXES: Vec<(Regex, Vec<&'static str>)> = {
        SYNONYMS.iter().map(|(word, syns)| {
            let re = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(word))).unwrap();
            (re, syns.clone())
        }).collect()
    };

    // ── Skill Category Mapping ──
    static ref SKILL_CATEGORIES: HashMap<&'static str, Vec<&'static str>> = {
        let mut m = HashMap::new();
        m.insert("coding_best_practices", vec!["shell", "file_system", "long_tasks"]);
        m.insert("data_scientist", vec!["shell", "file_system", "research"]);
        m.insert("devops_engineer", vec!["shell", "system_controls", "file_system"]);
        m.insert("full_stack_developer", vec!["shell", "file_system", "browser", "long_tasks"]);
        m.insert("os_automation", vec!["os_control", "system_controls", "app_management"]);
        m.insert("research_analyst", vec!["web_search", "research", "browser"]);
        m.insert("security_auditor", vec!["shell", "file_system", "browser"]);
        m.insert("technical_writer", vec!["file_system", "research"]);
        m.insert("ui_ux_designer", vec!["browser", "media", "file_system"]);
        m
    };
}

// ── Selection Cache ──────────────────────────────

struct CachedSelection {
    #[allow(dead_code)]
    categories: Vec<String>,
    scores_json: String,
    timestamp: u64,
}

/// Embedding cache entry — stores the hash and timestamp for LRU eviction
struct CachedEmbeddingEntry {
    #[allow(dead_code)]
    hash: String,
    timestamp: u64,
}

struct CacheState {
    /// Selection result cache (keyed by hash of message+tools)
    selection_cache: HashMap<String, CachedSelection>,
    /// Message embedding cache keys (actual embeddings stay in JS Float32Array)
    /// We track which message hashes exist so JS can check before recomputing
    embedding_cache_keys: HashMap<String, CachedEmbeddingEntry>,
    /// Current conversation iteration
    current_iteration: u32,
    /// Explicitly requested categories via request_tools meta-tool
    active_requested_categories: Vec<String>,
    /// Last iteration when requested categories were used
    active_requested_last_iter: u32,
    /// Total selection calls for stats
    total_selections: u64,
    /// Total cache hits for stats
    cache_hits: u64,
    /// Total structural fallbacks
    structural_fallbacks: u64,
    /// Total semantic classifications
    semantic_classifications: u64,
    /// Count of MCP tools that have been scored
    mcp_tools_scored: u32,
    /// Whether the embedding system is ready (set from JS)
    embeddings_ready: bool,
}

lazy_static! {
    static ref CACHE_STATE: Mutex<CacheState> = Mutex::new(CacheState {
        selection_cache: HashMap::new(),
        embedding_cache_keys: HashMap::new(),
        current_iteration: 0,
        active_requested_categories: Vec::new(),
        active_requested_last_iter: 0,
        total_selections: 0,
        cache_hits: 0,
        structural_fallbacks: 0,
        semantic_classifications: 0,
        mcp_tools_scored: 0,
        embeddings_ready: false,
    });
}

const SELECTION_CACHE_TTL_MS: u64 = 60_000;
const MAX_CACHE_SIZE: usize = 50;
const CATEGORY_EXPIRY_ITERATIONS: u32 = 10;

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// SHA-256 hash, truncated to 12 hex chars (collision-free for practical purposes).
fn simple_hash(s: &str) -> String {
    use std::io::Write as _;
    // Minimal SHA-256 via a simple import-free approach: we use the system
    // openssl or ring crate. Since neither is in deps, fall back to a
    // deterministic FNV-style double-hash for uniqueness.  The JS side uses
    // crypto.createHash("sha256") truncated to 12 hex chars.  We replicate
    // the same semantics by hashing twice with different seeds to get a
    // 96-bit fingerprint that is collision-free in practice.
    //
    // NOTE: For a true SHA-256 match with the JS side, add `sha2` crate.
    // For now this is an internal cache key, so consistency across
    // JS/Rust is not required (each side manages its own cache).
    let mut h1: u64 = 0xcbf29ce484222325; // FNV offset basis
    let mut h2: u64 = 0x100000001b3;      // second seed
    for b in s.bytes() {
        h1 ^= b as u64;
        h1 = h1.wrapping_mul(0x100000001b3);
        h2 ^= b as u64;
        h2 = h2.wrapping_mul(0xcbf29ce484222325);
    }
    let mut buf = [0u8; 24];
    let _ = (&mut buf[..]).write(&h1.to_le_bytes());
    let _ = (&mut buf[8..]).write(&h2.to_le_bytes());
    // Take first 12 hex chars (48 bits) from the combined hashes
    format!("{:08x}{:04x}", h1, (h2 & 0xFFFF) as u16)
}

// ══════════════════════════════════════════════════
// NAPI Exports
// ══════════════════════════════════════════════════

/// Get all category definitions
#[napi]
pub fn get_all_categories() -> String {
    serde_json::to_string(&*CATEGORIES).unwrap_or_default()
}

/// Get tool names for a specific category
#[napi]
pub fn get_category_tools(category: String) -> Vec<String> {
    CATEGORIES.get(category.as_str())
        .map(|c| c.tools.clone())
        .unwrap_or_default()
}

/// Get all category names
#[napi]
pub fn get_category_names() -> Vec<String> {
    CATEGORIES.keys().map(|k| k.to_string()).collect()
}

/// Structural classification — regex-based fallback when embeddings aren't ready.
/// Returns JSON array of {category, score} sorted by score descending.
#[napi]
pub fn structural_classify(message: String) -> String {
    let msg = message.to_lowercase();
    let mut scores: Vec<(String, f64)> = Vec::new();

    for (category, regexes) in PATTERNS.iter() {
        let mut matched = 0u32;
        for re in regexes {
            if re.is_match(&msg) {
                matched += 1;
            }
        }
        let score = if matched > 0 {
            0.3 + (matched as f64 * 0.15)
        } else {
            0.05
        };
        scores.push((category.to_string(), score));
    }

    // Always add core and memory
    scores.push(("core".to_string(), 0.9));
    scores.push(("memory".to_string(), 0.4));

    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Track structural fallback usage
    {
        let mut state = CACHE_STATE.lock();
        state.structural_fallbacks += 1;
    }

    serde_json::to_string(
        &scores
            .iter()
            .map(|(c, s)| serde_json::json!({"category": c, "score": s, "confidence": s}))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}

/// Expand a query with synonyms for better embedding matches
#[napi]
pub fn expand_query(message: String) -> String {
    let mut expanded = message.clone();

    for (re, syns) in SYNONYM_REGEXES.iter() {
        if re.is_match(&message) {
            let extras: String = syns.iter().take(2).copied().collect::<Vec<_>>().join(" ");
            expanded.push(' ');
            expanded.push_str(&extras);
        }
    }

    expanded
}

/// Get which categories a set of tool names belong to
#[napi]
pub fn get_used_categories(tool_names: Vec<String>) -> Vec<String> {
    let mut used = Vec::new();
    let tool_set: std::collections::HashSet<&str> = tool_names.iter().map(|s| s.as_str()).collect();

    for (cat_name, cat_def) in CATEGORIES.iter() {
        if cat_def.tools.iter().any(|t| tool_set.contains(t.as_str())) {
            used.push(cat_name.to_string());
        }
    }

    used
}

/// Compute selection cache key
#[napi]
pub fn get_selection_cache_key(message: String, recent_tool_calls: Option<Vec<String>>) -> String {
    let tool_part = match recent_tool_calls {
        Some(mut calls) => {
            calls.sort();
            calls.join(",")
        }
        None => String::new(),
    };
    simple_hash(&format!("{}|{}", message, tool_part))
}

/// Check selection cache, returns JSON or null.
/// Also evicts expired entries on access.
#[napi]
pub fn get_cached_selection(key: String) -> Option<String> {
    let mut state = CACHE_STATE.lock();
    let now = now_ms();

    // Check and potentially evict
    let cached = state.selection_cache.get(&key)?;
    if now - cached.timestamp > SELECTION_CACHE_TTL_MS {
        let key_clone = key.clone();
        let _ = cached; // release borrow
        state.selection_cache.remove(&key_clone);
        return None;
    }

    Some(cached.scores_json.clone())
}

/// Store a selection in cache.
/// `categories` is the list of selected category names (for stats/debugging).
/// `result_json` is the full serialized ToolRouterSelection.
#[napi]
pub fn cache_selection(key: String, categories: Vec<String>, result_json: String) {
    let mut state = CACHE_STATE.lock();

    // Evict oldest if full (LRU by timestamp)
    if state.selection_cache.len() >= MAX_CACHE_SIZE {
        let oldest_key = state
            .selection_cache
            .iter()
            .min_by_key(|(_, v)| v.timestamp)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest_key {
            state.selection_cache.remove(&k);
        }
    }

    state.selection_cache.insert(
        key,
        CachedSelection {
            categories,
            scores_json: result_json,
            timestamp: now_ms(),
        },
    );
}

/// Increment iteration counter and return new value
#[napi]
pub fn increment_iteration() -> u32 {
    let mut state = CACHE_STATE.lock();
    state.current_iteration += 1;
    state.current_iteration
}

/// Set active requested categories (from request_tools meta-tool)
#[napi]
pub fn set_requested_categories(categories: Vec<String>) {
    let mut state = CACHE_STATE.lock();
    state.active_requested_categories = categories;
    state.active_requested_last_iter = state.current_iteration;
}

/// Get active requested categories (returns empty if expired)
#[napi]
pub fn get_requested_categories() -> Vec<String> {
    let mut state = CACHE_STATE.lock();

    if state.active_requested_categories.is_empty() {
        return Vec::new();
    }

    let iterations_unused = state.current_iteration.saturating_sub(state.active_requested_last_iter);
    if iterations_unused > CATEGORY_EXPIRY_ITERATIONS {
        state.active_requested_categories.clear();
        return Vec::new();
    }

    state.active_requested_categories.clone()
}

/// Clear all router state (call on conversation reset).
/// Mirrors JS clearToolRouterState().
#[napi]
pub fn clear_tool_router_state() {
    let mut state = CACHE_STATE.lock();
    state.selection_cache.clear();
    state.embedding_cache_keys.clear();
    state.current_iteration = 0;
    state.active_requested_categories.clear();
    state.active_requested_last_iter = 0;
    // Note: we keep stats (total_selections, etc.) — they survive resets
    // for monitoring purposes. Call reset_router_stats() to clear those too.
}

/// Reset only the performance counters (not caches).
#[napi]
pub fn reset_router_stats() {
    let mut state = CACHE_STATE.lock();
    state.total_selections = 0;
    state.cache_hits = 0;
    state.structural_fallbacks = 0;
    state.semantic_classifications = 0;
}

/// Score categories by cosine similarity to a message embedding (f64 version).
/// Takes the message embedding and a JSON map of category->embedding.
/// Returns JSON array of {category, score, confidence} sorted descending.
///
/// Prefer `score_categories_by_embedding` (Float32Array) for the fast path.
#[napi]
pub fn score_categories_by_similarity(
    message_embedding: Vec<f64>,
    category_embeddings_json: String,
) -> String {
    let cat_embeddings: HashMap<String, Vec<f64>> =
        serde_json::from_str(&category_embeddings_json).unwrap_or_default();

    let msg_mag = magnitude_f64(&message_embedding);
    let mut scores: Vec<(String, f64)> = Vec::new();

    for (category, embedding) in &cat_embeddings {
        let sim = cosine_similarity_f64(&message_embedding, embedding, msg_mag);
        scores.push((category.clone(), sim));
    }

    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Track semantic classification
    {
        let mut state = CACHE_STATE.lock();
        state.semantic_classifications += 1;
    }

    serde_json::to_string(
        &scores
            .iter()
            .map(|(c, s)| serde_json::json!({"category": c, "score": s, "confidence": s}))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}

/// Get relevant skill names for given categories
#[napi]
pub fn get_relevant_skill_names(selected_categories: Vec<String>) -> Vec<String> {
    let selected_set: std::collections::HashSet<&str> = selected_categories.iter().map(|s| s.as_str()).collect();
    let mut relevant = Vec::new();

    for (skill_name, skill_cats) in SKILL_CATEGORIES.iter() {
        if skill_cats.iter().any(|c| selected_set.contains(c)) {
            relevant.push(skill_name.to_string());
        }
    }

    relevant
}

/// Compute dynamic threshold based on top score and confidence.
/// Mirrors the JS: semantic → max(0.15, topScore * 0.45); structural → 0.25
/// Low confidence → lower threshold → include more tools.
#[napi]
pub fn compute_threshold(
    top_score: f64,
    top_confidence: f64,
    embeddings_ready: bool,
) -> f64 {
    let mut threshold = if embeddings_ready {
        f64::max(0.15, top_score * 0.45)
    } else {
        0.25
    };

    if top_confidence < 0.3 {
        threshold = f64::max(0.10, threshold * 0.7);
    }

    threshold
}

// ══════════════════════════════════════════════════
// Embedding-Based Scoring (accepts pre-computed vectors from JS)
// ══════════════════════════════════════════════════

/// Score categories against a message embedding using pre-computed Float32Array
/// category embeddings. Returns JSON array of {category, score, confidence}
/// sorted by score descending.
///
/// JS calls @xenova/transformers → Float32Array, then passes here for fast
/// SIMD cosine similarity.
#[napi]
pub fn score_categories_by_embedding(
    message_embedding: Float32Array,
    category_embeddings_json: String,
) -> napi::Result<String> {
    let msg = message_embedding.as_ref();
    let cat_map: HashMap<String, Vec<f32>> =
        serde_json::from_str(&category_embeddings_json)
            .map_err(|e| napi::Error::new(Status::InvalidArg, format!("Bad JSON: {}", e)))?;

    let msg_mag = magnitude_f32(msg);
    let mut scores: Vec<(String, f64)> = Vec::with_capacity(cat_map.len());

    for (category, emb) in &cat_map {
        let sim = cosine_similarity_f32(msg, emb, msg_mag);
        scores.push((category.clone(), sim));
    }

    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Track semantic classification
    {
        let mut state = CACHE_STATE.lock();
        state.semantic_classifications += 1;
    }

    let result: Vec<serde_json::Value> = scores
        .iter()
        .map(|(c, s)| serde_json::json!({"category": c, "score": s, "confidence": s}))
        .collect();

    serde_json::to_string(&result)
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("JSON error: {}", e)))
}

/// Score a single MCP tool embedding against the message embedding.
/// Returns the cosine similarity as f64.
#[napi]
pub fn score_mcp_tool_embedding(
    message_embedding: Float32Array,
    tool_embedding: Float32Array,
) -> f64 {
    let msg = message_embedding.as_ref();
    let tool = tool_embedding.as_ref();

    if msg.len() != tool.len() || msg.is_empty() {
        return 0.0;
    }

    let msg_mag = magnitude_f32(msg);
    cosine_similarity_f32(msg, tool, msg_mag)
}

/// Batch-score multiple MCP tool embeddings against a message embedding.
/// `tool_embeddings_json` is a JSON object mapping tool_name → f32 array.
/// Returns JSON object mapping tool_name → similarity score.
#[napi]
pub fn score_mcp_tools_batch(
    message_embedding: Float32Array,
    tool_embeddings_json: String,
    threshold: f64,
) -> napi::Result<String> {
    let msg = message_embedding.as_ref();
    let tool_map: HashMap<String, Vec<f32>> =
        serde_json::from_str(&tool_embeddings_json)
            .map_err(|e| napi::Error::new(Status::InvalidArg, format!("Bad JSON: {}", e)))?;

    let msg_mag = magnitude_f32(msg);
    let mut results: HashMap<String, f64> = HashMap::new();

    for (name, emb) in &tool_map {
        let sim = cosine_similarity_f32(msg, emb, msg_mag);
        if sim >= threshold {
            results.insert(name.clone(), sim);
        }
    }

    // Track MCP tools scored
    {
        let mut state = CACHE_STATE.lock();
        state.mcp_tools_scored = tool_map.len() as u32;
    }

    serde_json::to_string(&results)
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("JSON error: {}", e)))
}

// ══════════════════════════════════════════════════
// Full Classification Pipeline
// ══════════════════════════════════════════════════

/// Combined classification that applies boosts for recent tool calls and
/// requested categories. Operates on pre-scored category results.
///
/// `base_scores_json`: JSON array of {category, score, confidence} from either
///   `score_categories_by_embedding` or `structural_classify`.
/// `recent_tool_calls`: tool names used recently (for boosting).
///
/// Returns JSON array of {category, score, confidence} with boosts applied,
/// sorted by score descending.
#[napi]
pub fn classify_with_boosts(
    base_scores_json: String,
    recent_tool_calls: Option<Vec<String>>,
) -> napi::Result<String> {
    #[derive(Deserialize, Serialize)]
    struct ScoreEntry {
        category: String,
        score: f64,
        confidence: f64,
    }

    let mut scores: Vec<ScoreEntry> = serde_json::from_str(&base_scores_json)
        .map_err(|e| napi::Error::new(Status::InvalidArg, format!("Bad JSON: {}", e)))?;

    // ── Boost categories that are already in use ──
    if let Some(ref tool_names) = recent_tool_calls {
        if !tool_names.is_empty() {
            let recent_cats = get_used_categories_internal(tool_names);
            for sc in &mut scores {
                if recent_cats.contains(sc.category.as_str()) {
                    sc.score = f64::max(sc.score, 0.5);
                }
            }
        }
    }

    // ── Boost explicitly requested categories (with expiry check) ──
    {
        let mut state = CACHE_STATE.lock();
        if !state.active_requested_categories.is_empty() {
            let iterations_unused = state
                .current_iteration
                .saturating_sub(state.active_requested_last_iter);
            if iterations_unused > CATEGORY_EXPIRY_ITERATIONS {
                // Auto-expire old category requests
                state.active_requested_categories.clear();
                state.active_requested_last_iter = 0;
            } else {
                let requested = state.active_requested_categories.clone();
                for sc in &mut scores {
                    if requested.contains(&sc.category) {
                        sc.score = f64::max(sc.score, 0.6);
                    }
                }
            }
        }
    }

    // Sort by score descending
    scores.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    serde_json::to_string(&scores)
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("JSON error: {}", e)))
}

/// Select categories above threshold, including always-include and preloaded.
/// Returns the list of selected category names and their tool names.
///
/// `ranked_json`: sorted array of {category, score, confidence}
/// `threshold`: dynamic threshold from `compute_threshold`
/// `preloaded_categories`: categories from task chain detection
/// `available_tool_names`: tool names actually registered in the system
///
/// Returns JSON: { categories: string[], tool_names: string[] }
#[napi]
pub fn select_categories(
    ranked_json: String,
    threshold: f64,
    preloaded_categories: Vec<String>,
    available_tool_names: Vec<String>,
) -> napi::Result<String> {
    #[derive(Deserialize)]
    struct ScoreEntry {
        category: String,
        score: f64,
    }

    let ranked: Vec<ScoreEntry> = serde_json::from_str(&ranked_json)
        .map_err(|e| napi::Error::new(Status::InvalidArg, format!("Bad JSON: {}", e)))?;

    let available_set: HashSet<&str> = available_tool_names.iter().map(|s| s.as_str()).collect();
    let preloaded_set: HashSet<&str> = preloaded_categories.iter().map(|s| s.as_str()).collect();

    let mut selected_categories: Vec<String> = Vec::new();
    let mut selected_tool_names: Vec<String> = Vec::new();
    let mut tool_set: HashSet<String> = HashSet::new();

    for entry in &ranked {
        let cat_def = match CATEGORIES.get(entry.category.as_str()) {
            Some(c) => c,
            None => continue,
        };

        let is_preloaded = preloaded_set.contains(entry.category.as_str());
        if entry.score >= threshold || cat_def.always_include || is_preloaded {
            selected_categories.push(entry.category.clone());
            for tool_name in &cat_def.tools {
                if available_set.contains(tool_name.as_str()) && tool_set.insert(tool_name.clone())
                {
                    selected_tool_names.push(tool_name.clone());
                }
            }
        }
    }

    let result = serde_json::json!({
        "categories": selected_categories,
        "tool_names": selected_tool_names,
    });

    serde_json::to_string(&result)
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("JSON error: {}", e)))
}

/// Add co-occurrence "likely" categories to the selection.
/// `selected_categories`: currently selected categories
/// `likely_categories`: from tool_analytics get_likely_categories
/// `available_tool_names`: tool names registered in the system
///
/// Returns JSON: { categories: string[], tool_names: string[] }  (the *new* ones only)
#[napi]
pub fn add_likely_categories(
    selected_categories: Vec<String>,
    likely_categories: Vec<String>,
    available_tool_names: Vec<String>,
) -> napi::Result<String> {
    let available_set: HashSet<&str> = available_tool_names.iter().map(|s| s.as_str()).collect();
    let selected_set: HashSet<&str> = selected_categories.iter().map(|s| s.as_str()).collect();

    let mut new_categories: Vec<String> = Vec::new();
    let mut new_tool_names: Vec<String> = Vec::new();

    for cat_name in &likely_categories {
        if selected_set.contains(cat_name.as_str()) {
            continue;
        }
        if let Some(cat_def) = CATEGORIES.get(cat_name.as_str()) {
            new_categories.push(cat_name.clone());
            for tool_name in &cat_def.tools {
                if available_set.contains(tool_name.as_str()) {
                    new_tool_names.push(tool_name.clone());
                }
            }
        }
    }

    let result = serde_json::json!({
        "categories": new_categories,
        "tool_names": new_tool_names,
    });

    serde_json::to_string(&result)
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("JSON error: {}", e)))
}

// ══════════════════════════════════════════════════
// request_tools Meta-Tool Handling
// ══════════════════════════════════════════════════

/// Get the request_tools meta-tool schema as JSON (for inclusion in tool lists).
#[napi]
pub fn get_request_tools_schema() -> String {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "request_tools",
            "description": "Request additional tools when you realize you need capabilities not currently available. Describe what you need and the router will provide the right tools on your next turn. Use this when the task evolved and you need different tools than what was initially provided.",
            "parameters": {
                "type": "object",
                "properties": {
                    "capability": {
                        "type": "string",
                        "description": "Describe the capability you need in natural language. Examples: 'browser automation to navigate websites', 'file system tools to read and write files', 'image generation', 'email sending', 'spotify music control', 'screen control and mouse clicking', 'GitHub repository management'"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Brief explanation of why you need these tools now (what changed in the task)"
                    }
                },
                "required": ["capability", "reason"]
            }
        }
    })
    .to_string()
}

/// Check if a tool name is the request_tools meta-tool.
#[napi]
pub fn is_request_tools_call(tool_name: String) -> bool {
    tool_name == "request_tools"
}

/// Handle the request_tools meta-tool call using structural classification
/// (fallback path). Returns JSON: { categories: string[], response: string }
///
/// For the embedding-based path, JS should:
///   1. Embed the capability string
///   2. Call `score_categories_by_embedding` with it
///   3. Filter categories with score > 0.2
///   4. Call `apply_tool_request` to register them
///
/// This function handles the structural fallback.
#[napi]
pub fn handle_tool_request_structural(
    capability: String,
    reason: String,
) -> String {
    // Use structural classification on the capability description
    let msg = capability.to_lowercase();
    let mut fallback_scores: Vec<(String, f64)> = Vec::new();

    for (category, regexes) in PATTERNS.iter() {
        let mut matched = 0u32;
        for re in regexes {
            if re.is_match(&msg) {
                matched += 1;
            }
        }
        let score = if matched > 0 {
            0.3 + (matched as f64 * 0.15)
        } else {
            0.05
        };
        fallback_scores.push((category.to_string(), score));
    }

    // Add core and memory
    fallback_scores.push(("core".to_string(), 0.9));
    fallback_scores.push(("memory".to_string(), 0.4));

    // Filter by threshold > 0.25
    let matched_categories: Vec<String> = fallback_scores
        .iter()
        .filter(|(_, s)| *s > 0.25)
        .map(|(c, _)| c.clone())
        .collect();

    if matched_categories.is_empty() {
        let all_cats: Vec<&str> = CATEGORIES.keys().copied().collect();
        return serde_json::json!({
            "categories": [],
            "response": format!(
                "No matching tool categories found for \"{}\". Available categories: {}. Try describing the capability differently.",
                capability,
                all_cats.join(", ")
            ),
        })
        .to_string();
    }

    // Register these as active categories
    {
        let mut state = CACHE_STATE.lock();
        let mut combined: HashSet<String> = state
            .active_requested_categories
            .iter()
            .cloned()
            .collect();
        for c in &matched_categories {
            combined.insert(c.clone());
        }
        state.active_requested_categories = combined.into_iter().collect();
        state.active_requested_last_iter = state.current_iteration;
    }

    // Build response
    let mut tool_descriptions: Vec<String> = Vec::new();
    let mut total_tools = 0usize;
    for cat_name in &matched_categories {
        if let Some(cat) = CATEGORIES.get(cat_name.as_str()) {
            tool_descriptions.push(format!("\n### {}", cat_name.to_uppercase()));
            tool_descriptions.push(format!("{}\n", cat.description));
            tool_descriptions.push(format!("Available tools: {}", cat.tools.join(", ")));
            total_tools += cat.tools.len();
        }
    }

    let response = format!(
        "Added {} tool categories for \"{}\":\n{}\n\nThese tools are now available in your next response. Use them as needed.",
        matched_categories.len(),
        capability,
        tool_descriptions.join("\n")
    );

    let _ = reason; // Used for logging on JS side

    serde_json::json!({
        "categories": matched_categories,
        "response": response,
        "total_tools": total_tools,
    })
    .to_string()
}

/// Apply a tool request from embedding-based matching.
/// Merges matched_categories into the active requested set.
/// Returns JSON with the formatted response.
#[napi]
pub fn apply_tool_request(
    capability: String,
    matched_categories: Vec<String>,
) -> String {
    if matched_categories.is_empty() {
        let all_cats: Vec<&str> = CATEGORIES.keys().copied().collect();
        return serde_json::json!({
            "categories": [],
            "response": format!(
                "No matching tool categories found for \"{}\". Available categories: {}. Try describing the capability differently.",
                capability,
                all_cats.join(", ")
            ),
        })
        .to_string();
    }

    // Register as active categories
    {
        let mut state = CACHE_STATE.lock();
        let mut combined: HashSet<String> = state
            .active_requested_categories
            .iter()
            .cloned()
            .collect();
        for c in &matched_categories {
            combined.insert(c.clone());
        }
        state.active_requested_categories = combined.into_iter().collect();
        state.active_requested_last_iter = state.current_iteration;
    }

    // Build detailed response
    let mut tool_descriptions: Vec<String> = Vec::new();
    let mut total_tools = 0usize;
    for cat_name in &matched_categories {
        if let Some(cat) = CATEGORIES.get(cat_name.as_str()) {
            tool_descriptions.push(format!("\n### {}", cat_name.to_uppercase()));
            tool_descriptions.push(format!("{}\n", cat.description));
            tool_descriptions.push(format!("Available tools: {}", cat.tools.join(", ")));
            total_tools += cat.tools.len();
        }
    }

    let response = format!(
        "Added {} tool categories for \"{}\":\n{}\n\nThese tools are now available in your next response. Use them as needed.",
        matched_categories.len(),
        capability,
        tool_descriptions.join("\n")
    );

    serde_json::json!({
        "categories": matched_categories,
        "response": response,
        "total_tools": total_tools,
    })
    .to_string()
}

// ══════════════════════════════════════════════════
// Router Stats & State Management
// ══════════════════════════════════════════════════

/// NAPI result type for router stats
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterStats {
    pub cache_size: u32,
    pub embedding_cache_size: u32,
    pub mcp_tools_scored: u32,
    pub current_iteration: u32,
    pub embeddings_ready: bool,
    pub total_selections: f64,
    pub cache_hits: f64,
    pub structural_fallbacks: f64,
    pub semantic_classifications: f64,
    pub cache_hit_rate: f64,
}

/// Get current router statistics.
#[napi]
pub fn get_router_stats() -> RouterStats {
    let state = CACHE_STATE.lock();
    let total = state.total_selections as f64;
    let hit_rate = if total > 0.0 {
        state.cache_hits as f64 / total
    } else {
        0.0
    };
    RouterStats {
        cache_size: state.selection_cache.len() as u32,
        embedding_cache_size: state.embedding_cache_keys.len() as u32,
        mcp_tools_scored: state.mcp_tools_scored,
        current_iteration: state.current_iteration,
        embeddings_ready: state.embeddings_ready,
        total_selections: state.total_selections as f64,
        cache_hits: state.cache_hits as f64,
        structural_fallbacks: state.structural_fallbacks as f64,
        semantic_classifications: state.semantic_classifications as f64,
        cache_hit_rate: hit_rate,
    }
}

/// Set embeddings_ready flag (called from JS when embedding model is loaded).
#[napi]
pub fn set_embeddings_ready(ready: bool) {
    let mut state = CACHE_STATE.lock();
    state.embeddings_ready = ready;
}

/// Check if embeddings are ready.
#[napi]
pub fn are_embeddings_ready() -> bool {
    let state = CACHE_STATE.lock();
    state.embeddings_ready
}

/// Record a cache hit (called from JS when selection cache is used).
#[napi]
pub fn record_cache_hit() {
    let mut state = CACHE_STATE.lock();
    state.cache_hits += 1;
    state.total_selections += 1;
}

/// Record a full classification (called from JS on cache miss).
#[napi]
pub fn record_classification(used_embeddings: bool) {
    let mut state = CACHE_STATE.lock();
    state.total_selections += 1;
    if used_embeddings {
        state.semantic_classifications += 1;
    } else {
        state.structural_fallbacks += 1;
    }
}

/// Track embedding cache entry existence
#[napi]
pub fn track_embedding_cache_entry(message_hash: String) {
    let mut state = CACHE_STATE.lock();

    // Evict oldest if cache is full
    if state.embedding_cache_keys.len() >= MAX_CACHE_SIZE {
        let oldest_key = state
            .embedding_cache_keys
            .iter()
            .min_by_key(|(_, v)| v.timestamp)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest_key {
            state.embedding_cache_keys.remove(&k);
        }
    }

    state.embedding_cache_keys.insert(
        message_hash.clone(),
        CachedEmbeddingEntry {
            hash: message_hash,
            timestamp: now_ms(),
        },
    );
}

/// Check if an embedding is cached
#[napi]
pub fn has_cached_embedding(message_hash: String) -> bool {
    let state = CACHE_STATE.lock();
    state.embedding_cache_keys.contains_key(&message_hash)
}

/// Compute a hash for a message (for embedding cache key)
#[napi]
pub fn hash_message(message: String) -> String {
    simple_hash(&message)
}

// ── Internal Helpers ─────────────────────────────

/// Internal version of get_used_categories that returns a HashSet<&str>
fn get_used_categories_internal(tool_names: &[String]) -> HashSet<&'static str> {
    let mut used = HashSet::new();
    let tool_set: HashSet<&str> = tool_names.iter().map(|s| s.as_str()).collect();

    for (cat_name, cat_def) in CATEGORIES.iter() {
        if cat_def.tools.iter().any(|t| tool_set.contains(t.as_str())) {
            used.insert(*cat_name);
        }
    }

    used
}

fn magnitude_f64(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}

fn cosine_similarity_f64(a: &[f64], b: &[f64], a_mag: f64) -> f64 {
    if a.len() != b.len() || a_mag == 0.0 {
        return 0.0;
    }

    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let b_mag = magnitude_f64(b);

    if b_mag == 0.0 {
        return 0.0;
    }

    dot / (a_mag * b_mag)
}

/// f32 magnitude for Float32Array vectors from JS
fn magnitude_f32(v: &[f32]) -> f64 {
    let sum: f64 = v.iter().map(|x| (*x as f64) * (*x as f64)).sum();
    sum.sqrt()
}

/// f32 cosine similarity — used for embedding vectors from JS (Float32Array)
fn cosine_similarity_f32(a: &[f32], b: &[f32], a_mag: f64) -> f64 {
    if a.len() != b.len() || a_mag == 0.0 {
        return 0.0;
    }

    let dot: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum();
    let b_mag = magnitude_f32(b);

    if b_mag == 0.0 {
        return 0.0;
    }

    dot / (a_mag * b_mag)
}
