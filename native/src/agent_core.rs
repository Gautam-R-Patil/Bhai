// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Agent Core — Rust port via napi-rs
// Agent loop decision logic: memory injection pipeline, tool batching rules,
// persistence nudge thresholds, cascade escalation rules.
// Async I/O (LLM calls, tool execution) stays in JS.

use std::collections::HashSet;

use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ── Constants ───────────────────────────────

/// Maximum iterations before the agent loop halts.
pub const MAX_ITERATIONS: i32 = 200;

/// Maximum total characters for injected memory context (~1000 tokens).
const MAX_INJECTION_CHARS: usize = 4000;

/// Minimum remaining chars to include a truncated final part.
const MIN_TRUNCATION_REMAINING: usize = 100;

/// Progress throttle in milliseconds.
const PROGRESS_THROTTLE_MS: u64 = 3000;

/// Mid-session credit check interval (every N tool calls).
const CREDIT_CHECK_INTERVAL: i32 = 5;

/// Periodic progress notification interval (every N tool calls).
const PROGRESS_NOTIFY_INTERVAL: i32 = 8;

// ── Browser Tool Set ────────────────────────

lazy_static! {
    static ref BROWSER_TOOLS: HashSet<&'static str> = {
        let mut s = HashSet::new();
        s.insert("browser_navigate");
        s.insert("browser_click_at");
        s.insert("browser_type");
        s.insert("browser_scan");
        s.insert("browser_extract");
        s.insert("browser_back");
        s.insert("browser_scroll");
        s.insert("browser_analyze");
        s.insert("browser_run_js");
        s.insert("browser_wait");
        s.insert("browser_select");
        s.insert("browser_right_click");
        s.insert("browser_hold_click");
        s.insert("browser_drag");
        s.insert("browser_hover");
        s.insert("browser_keyboard");
        s.insert("browser_switch_tab");
        s.insert("browser_upload_file");
        s.insert("browser_save_strategy");
        s.insert("browser_recall_strategy");
        s
    };
    static ref HARD_DECISION_TOOLS: HashSet<&'static str> = {
        let mut s = HashSet::new();
        s.insert("web_search");
        s.insert("shell_exec");
        s.insert("memory_store");
        s
    };
}

/// Check if a tool name is a browser tool.
#[napi]
pub fn is_browser_tool(name: String) -> bool {
    BROWSER_TOOLS.contains(name.as_str())
}

/// Check if a tool name is a hard-decision tool.
#[napi]
pub fn is_hard_decision_tool(name: String) -> bool {
    HARD_DECISION_TOOLS.contains(name.as_str())
}

// ── Milestone Descriptions ──────────────────

/// Get a human-readable milestone message for a tool call (for progress updates).
/// Returns None if the tool has no milestone description.
#[napi]
pub fn get_milestone_message(tool_name: String, args_json: String) -> Option<String> {
    let args: serde_json::Value =
        serde_json::from_str(&args_json).unwrap_or(serde_json::Value::Null);

    match tool_name.as_str() {
        "browser_navigate" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let truncated = safe_truncate(url, 60);
            Some(format!("\u{1F310} Opening {}...", truncated))
        }
        "web_search" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            Some(format!("\u{1F50D} Searching: \"{}\"", query))
        }
        "shell_exec" => {
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let truncated = safe_truncate(command, 50);
            Some(format!("\u{2699}\u{FE0F} Running command: {}", truncated))
        }
        "browser_scan" => Some("\u{1F50D} Scanning the active browser page DOM...".into()),
        "browser_analyze" => Some("\u{1F50E} Analyzing page elements...".into()),
        "browser_run_js" => Some("\u{1F4CA} Extracting data from the page...".into()),
        "browser_save_strategy" => {
            let pattern = args
                .get("task_pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Some(format!("\u{1F4BE} Saving strategy: \"{}\"", pattern))
        }
        "write_file" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            Some(format!("\u{1F4DD} Writing file: {}", path))
        }
        "read_file" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            Some(format!("\u{1F4D6} Reading: {}", path))
        }
        "memory_store" => {
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let truncated = safe_truncate(content, 40);
            Some(format!("\u{1F9E0} Remembering: \"{}\"", truncated))
        }
        _ => None,
    }
}

/// Detect if a tool result JSON contains an error field.
#[napi]
pub fn get_error_message(tool_name: String, result: String) -> Option<String> {
    let parsed: serde_json::Value = match serde_json::from_str(&result) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        let truncated = safe_truncate(err, 80);
        Some(format!(
            "\u{26A0}\u{FE0F} {} failed: {}. Trying another approach...",
            tool_name, truncated
        ))
    } else {
        None
    }
}

/// Check if a tool result JSON contains a screenshot_base64 field.
#[napi]
pub fn has_screenshot(result: String) -> bool {
    match serde_json::from_str::<serde_json::Value>(&result) {
        Ok(v) => v.get("screenshot_base64").is_some(),
        Err(_) => false,
    }
}

// ── Tool Batching Logic ─────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallInfo {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPlan {
    /// Tool call IDs that should run sequentially (browser tools).
    pub sequential_ids: Vec<String>,
    /// Tool call IDs that can run in parallel (non-browser tools).
    pub parallel_ids: Vec<String>,
    /// Original order of all tool call IDs for result merging.
    pub original_order: Vec<String>,
}

/// Classify tool calls into browser (sequential) and non-browser (parallel) batches.
/// Browser tools share page state and must execute sequentially.
/// Non-browser tools are independent and can run concurrently.
#[napi]
pub fn plan_tool_batch(tool_calls: Vec<ToolCallInfo>) -> BatchPlan {
    let mut sequential_ids = Vec::new();
    let mut parallel_ids = Vec::new();
    let mut original_order = Vec::new();

    for tc in &tool_calls {
        original_order.push(tc.id.clone());
        if BROWSER_TOOLS.contains(tc.name.as_str()) {
            sequential_ids.push(tc.id.clone());
        } else {
            parallel_ids.push(tc.id.clone());
        }
    }

    BatchPlan {
        sequential_ids,
        parallel_ids,
        original_order,
    }
}

// ── Memory Injection Pipeline ───────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DateTimeContext {
    pub date_str: String,
    pub time_str: String,
    pub greeting: String,
}

/// Compute the IST greeting period from an IST hour (0-23).
#[napi]
pub fn compute_greeting(ist_hour: i32) -> String {
    if ist_hour < 12 {
        "morning".to_string()
    } else if ist_hour < 17 {
        "afternoon".to_string()
    } else if ist_hour < 21 {
        "evening".to_string()
    } else {
        "night".to_string()
    }
}

/// Cap injected memory parts to MAX_INJECTION_CHARS (~4000 chars / ~1000 tokens).
/// Returns the capped parts, truncating the last overflowing part if there's
/// at least MIN_TRUNCATION_REMAINING (100) chars remaining.
#[napi]
pub fn cap_injection_parts(parts: Vec<String>) -> Vec<String> {
    let mut total_chars: usize = 0;
    let mut capped: Vec<String> = Vec::new();

    for part in &parts {
        if total_chars + part.len() > MAX_INJECTION_CHARS {
            let remaining = MAX_INJECTION_CHARS - total_chars;
            if remaining > MIN_TRUNCATION_REMAINING {
                // Safe truncation at char boundary
                let truncated = safe_truncate(part, remaining);
                capped.push(format!("{}...", truncated));
            }
            break;
        }
        capped.push(part.clone());
        total_chars += part.len();
    }

    capped
}

/// Build the full injection string from capped parts.
#[napi]
pub fn build_injection_string(capped_parts: Vec<String>, model_hint: Option<String>) -> String {
    let mut injection = String::new();

    if !capped_parts.is_empty() {
        injection.push_str("[Auto-Injected Memory & Strategy Context]\n");
        injection.push_str(&capped_parts.join("\n\n"));
    }

    // For simple casual messages, add a nudge for extra natural tone
    if model_hint.as_deref() == Some("simple") {
        injection.push_str("\n\n[CASUAL MODE \u{2014} this is a simple/casual message. Respond like you're texting a close friend. Be spontaneous, not formulaic. Don't pad your response. If 2 words is enough, send 2 words. Match their energy exactly. Don't try to be impressive or add observations just to fill space.]");
    }

    injection
}

/// Build the first-time user onboarding nudge text.
#[napi]
pub fn get_onboarding_nudge() -> String {
    "\u{1F195} FIRST-TIME USER \u{2014} you have zero memory. This is your very first chat with this person.\n\
     - Introduce yourself casually ONCE: \"hey! I'm Bhai \u{1F44B}\" \u{2014} keep it short and warm.\n\
     - Naturally get to know them through conversation (name, what they do, what they're building). DON'T interrogate.\n\
     - Save info as you learn it: identity_update for name/role/company, trait_update for preferences.\n\
     - After this chat, you'll remember everything. Never re-introduce or re-ask.".to_string()
}

// ── Persistence Nudge Logic ─────────────────

/// Stop words / phrases that indicate the user is done or acknowledging completion.
/// If the user's last message matches any of these (and is short), the agent should NOT
/// be nudged to continue.
const STOP_WORDS: &[&str] = &[
    // Explicit stop signals
    "stop",
    "cancel",
    "no",
    "don't",
    "dont",
    "quit",
    "abort",
    "never mind",
    "nevermind",
    "enough",
    "leave it",
    // Short acknowledgements
    "ok",
    "okay",
    "got it",
    "got that",
    "thanks",
    "thank you",
    "cool",
    "great",
    "nice",
    "alright",
    "noted",
    "sounds good",
    "awesome",
    "perfect",
    "understood",
    "sure",
    "yep",
    "yup",
    "yeah",
    "good",
    "that's fine",
    "thats fine",
    // Greetings / casual
    "hi",
    "hey",
    "hello",
    "hii",
    "yo",
    "sup",
    "hola",
    "good morning",
    "good night",
    "gm",
    "gn",
    "how are you",
    "what's up",
    "whats up",
    // Confirmations of completion
    "done",
    "thats it",
    "that's it",
    "all good",
    "looks good",
    "\u{1F44D}",
    "\u{2705}",
    "\u{1FAE1}",
    "\u{1F64C}",
    "\u{1F60A}",
    "\u{2764}\u{FE0F}",
    "\u{1F525}",
];

/// Keywords that indicate the agent's response is wrapping up / reporting completion.
const WRAPPING_UP_KEYWORDS: &[&str] = &[
    "stopping",
    "stopped",
    "closed the tab",
    "closed the browser",
    "task complete",
    "all done",
    "done",
    "complete",
    "finished",
    "here's",
    "here is",
    "sent",
    "delivered",
    "briefing",
    "summary",
    "good morning",
    "good night",
    "all systems",
    "phone verification",
    "verification required",
    "couldn't complete",
    "wasn't able",
    "giving up",
    "as requested",
    "cancelled",
    "deleted",
    "removed",
    "cleaned",
    "updated",
    "saved",
    "created",
    "installed",
    "fixed",
    "resolved",
    "confirmed",
    "verified",
    "ready",
    "set up",
    "looks good",
];

/// Keywords that indicate the agent is asking the user for something.
const ASKING_USER_PATTERNS: &[&str] = &[
    "would you like",
    "do you want",
    "could you",
    "please provide",
    "need your",
    "what is your",
    "enter the otp",
    "waiting for",
    "let me know",
    "should i",
];

/// Patterns for detecting the agent exploring its own codebase (ran out of real work).
const SELF_CODEBASE_PATTERNS: &[&str] = &[
    "package.json",
    "src/",
    "tsconfig",
    "git status",
    "npm run build",
    "node_modules",
    "dist/",
];

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceNudgeInput {
    /// The assistant's response text.
    pub response_text: String,
    /// Total tool calls made so far in this agent run.
    pub total_tool_calls: i32,
    /// Current iteration count.
    pub iterations: i32,
    /// The user's last message text (lowercased, trimmed).
    pub last_user_text: String,
    /// Recent tool/assistant message texts (last ~10 messages) for self-codebase detection.
    pub recent_message_texts: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceNudgeResult {
    /// Whether the agent should be nudged to continue working.
    pub should_nudge: bool,
    /// Reason for the decision (for logging).
    pub reason: String,
}

/// Determine whether the agent should be nudged to continue after it stopped
/// producing tool calls. This implements the "Persistence Guard" from agent.ts.
///
/// Returns should_nudge=true only when the agent made very few tool calls (<6)
/// AND none of the bail-out signals fired AND the user's message looks like a real task.
#[napi]
pub fn evaluate_persistence_nudge(input: PersistenceNudgeInput) -> PersistenceNudgeResult {
    let response_lower = input.response_text.to_lowercase();

    // 1. Short / conversational response = model is done, not stuck
    let is_conversational = input.response_text.len() < 300 && !response_lower.contains("error");
    if is_conversational {
        return PersistenceNudgeResult {
            should_nudge: false,
            reason: "conversational_response".into(),
        };
    }

    // 2. Asking the user for something?
    let ends_with_question = input.response_text.trim().ends_with('?');
    let is_asking_user = ends_with_question
        || ASKING_USER_PATTERNS
            .iter()
            .any(|p| response_lower.contains(p));
    if is_asking_user {
        return PersistenceNudgeResult {
            should_nudge: false,
            reason: "asking_user".into(),
        };
    }

    // 3. Agent is wrapping up
    let is_wrapping_up = WRAPPING_UP_KEYWORDS
        .iter()
        .any(|k| response_lower.contains(k));
    if is_wrapping_up {
        return PersistenceNudgeResult {
            should_nudge: false,
            reason: "wrapping_up".into(),
        };
    }

    // 4. Agent was exploring its own codebase
    let is_exploring_own_code = input
        .recent_message_texts
        .iter()
        .any(|txt| SELF_CODEBASE_PATTERNS.iter().any(|p| txt.contains(p)));
    if is_exploring_own_code {
        return PersistenceNudgeResult {
            should_nudge: false,
            reason: "exploring_own_codebase".into(),
        };
    }

    // 5. User's last message is simple — greeting, ack, or stop
    let user_word_count = input.last_user_text.split_whitespace().count();
    let is_user_stopping =
        user_word_count <= 10 && STOP_WORDS.iter().any(|w| input.last_user_text.contains(w));
    if is_user_stopping {
        return PersistenceNudgeResult {
            should_nudge: false,
            reason: "user_stopping".into(),
        };
    }

    // 6. Is the user's message simple enough?
    let is_simple_user_message = user_word_count <= 6;
    if is_simple_user_message {
        return PersistenceNudgeResult {
            should_nudge: false,
            reason: "simple_user_message".into(),
        };
    }

    // ── Decision ──
    let should_nudge = input.total_tool_calls > 0
        && input.total_tool_calls < 6
        && input.iterations < MAX_ITERATIONS - 1;

    PersistenceNudgeResult {
        should_nudge,
        reason: if should_nudge {
            format!("nudge_after_{}_tools", input.total_tool_calls)
        } else {
            "no_nudge_threshold".into()
        },
    }
}

/// Get the persistence nudge message to inject into the conversation.
#[napi]
pub fn get_persistence_nudge_message() -> String {
    "It looks like there may be more steps to complete this task. If you are genuinely done, go ahead and give your final answer. Otherwise, continue working.".to_string()
}

// ── Thinking Level Decision ─────────────────

/// Determine the thinking level for a given iteration.
/// Returns "off", "low", "medium", or "high".
#[napi]
pub fn compute_iteration_thinking(
    iteration: i32,
    model_hint: Option<String>,
    selection_thinking_level: String,
    global_thinking_level: String,
) -> String {
    if iteration <= 1 && model_hint.as_deref() == Some("simple") {
        return "off".to_string();
    }
    if iteration <= 1 {
        return selection_thinking_level;
    }
    if global_thinking_level == "off" {
        return "off".to_string();
    }
    global_thinking_level
}

// ── Query Classification (mirrors classifier.ts) ──

/// Classify a user query to determine retrieval depth.
/// Returns one of: "llm_only", "llm_with_traits", "retrieve"
#[napi]
pub fn classify_query_mode(message: String) -> String {
    let lower = message.to_lowercase();
    let trimmed = lower.trim();
    let word_count = trimmed.split_whitespace().count();

    // Very short messages (greetings, acks) → llm_only
    if word_count <= 3 {
        // Check if it's a greeting or ack
        let short_patterns = [
            "hi",
            "hey",
            "hello",
            "hii",
            "yo",
            "sup",
            "hola",
            "ok",
            "okay",
            "thanks",
            "thank you",
            "cool",
            "great",
            "nice",
            "yes",
            "no",
            "yep",
            "yeah",
            "sure",
            "alright",
            "gm",
            "gn",
            "good morning",
            "good night",
        ];
        if short_patterns
            .iter()
            .any(|p| trimmed == *p || trimmed.starts_with(&format!("{} ", p)))
        {
            return "llm_only".into();
        }
    }

    // Medium messages without strong retrieval signals → llm_with_traits
    if word_count <= 10 {
        let retrieval_signals = [
            "remember",
            "recall",
            "you told",
            "last time",
            "previously",
            "earlier",
            "before",
            "history",
            "search",
            "find",
            "look up",
            "what did",
            "when did",
            "who is",
            "what is",
        ];
        let has_retrieval = retrieval_signals.iter().any(|s| trimmed.contains(s));
        if !has_retrieval {
            return "llm_with_traits".into();
        }
    }

    // Default: full retrieval
    "retrieve".into()
}

// ── Agent Loop State ────────────────────────

#[derive(Debug, Clone, Default)]
struct AgentLoopState {
    iterations: i32,
    total_tool_calls: i32,
    error_count: i32,
    used_browser_tools: bool,
    last_progress_time_ms: u64,
}

lazy_static! {
    static ref AGENT_STATE: Mutex<AgentLoopState> = Mutex::new(AgentLoopState::default());
}

/// Reset the agent loop state for a new run.
#[napi]
pub fn reset_agent_state() {
    let mut state = AGENT_STATE.lock();
    *state = AgentLoopState::default();
}

/// Increment the iteration counter. Returns the new iteration number.
#[napi]
pub fn increment_agent_iteration() -> i32 {
    let mut state = AGENT_STATE.lock();
    state.iterations += 1;
    state.iterations
}

/// Get the current iteration count.
#[napi]
pub fn get_iteration_count() -> i32 {
    AGENT_STATE.lock().iterations
}

/// Add to the total tool call count. Returns the new total.
#[napi]
pub fn add_tool_calls(count: i32) -> i32 {
    let mut state = AGENT_STATE.lock();
    state.total_tool_calls += count;
    state.total_tool_calls
}

/// Get the total tool call count.
#[napi]
pub fn get_total_tool_calls() -> i32 {
    AGENT_STATE.lock().total_tool_calls
}

/// Increment the error count. Returns the new error count.
#[napi]
pub fn increment_error_count() -> i32 {
    let mut state = AGENT_STATE.lock();
    state.error_count += 1;
    state.error_count
}

/// Get the current error count.
#[napi]
pub fn get_error_count() -> i32 {
    AGENT_STATE.lock().error_count
}

/// Mark that browser tools have been used in this run.
#[napi]
pub fn mark_browser_tools_used() {
    AGENT_STATE.lock().used_browser_tools = true;
}

/// Check if browser tools have been used.
#[napi]
pub fn has_used_browser_tools() -> bool {
    AGENT_STATE.lock().used_browser_tools
}

/// Check if progress should be sent (throttled to PROGRESS_THROTTLE_MS).
/// If yes, updates the last progress time and returns true.
#[napi]
pub fn should_send_progress(now_ms: f64) -> bool {
    let mut state = AGENT_STATE.lock();
    let now = now_ms as u64;
    if now - state.last_progress_time_ms < PROGRESS_THROTTLE_MS {
        return false;
    }
    state.last_progress_time_ms = now;
    true
}

/// Check if a mid-session credit check is needed (every CREDIT_CHECK_INTERVAL tool calls).
#[napi]
pub fn needs_credit_check() -> bool {
    let state = AGENT_STATE.lock();
    state.total_tool_calls > 0 && state.total_tool_calls % CREDIT_CHECK_INTERVAL == 0
}

/// Check if a periodic progress notification should be sent (every PROGRESS_NOTIFY_INTERVAL tool calls).
#[napi]
pub fn needs_progress_notification() -> bool {
    let state = AGENT_STATE.lock();
    state.total_tool_calls > 0 && state.total_tool_calls % PROGRESS_NOTIFY_INTERVAL == 0
}

/// Check if the agent has hit the max iteration limit.
#[napi]
pub fn has_hit_max_iterations() -> bool {
    AGENT_STATE.lock().iterations >= MAX_ITERATIONS
}

/// Get a full snapshot of the current agent loop state (for JS).
#[napi]
pub fn get_agent_state_snapshot() -> String {
    let state = AGENT_STATE.lock();
    serde_json::json!({
        "iterations": state.iterations,
        "totalToolCalls": state.total_tool_calls,
        "errorCount": state.error_count,
        "usedBrowserTools": state.used_browser_tools,
    })
    .to_string()
}

// ── Source Tag Stripping ────────────────────

/// Strip [SOURCE: ...] tags from user messages.
/// The overlay appends these to every message, inflating word count
/// and breaking simple-message detection.
#[napi]
pub fn strip_source_tags(message: String) -> String {
    // Find the last occurrence of \n[SOURCE: or [SOURCE: at end
    if let Some(idx) = message.rfind("[SOURCE:") {
        // Only strip if it's at the end (possibly with trailing whitespace)
        let after = message[idx..].trim_end();
        if after.ends_with(']') {
            let before = message[..idx].trim_end();
            return before.to_string();
        }
    }
    message
}

// ── Helper: Safe UTF-8 truncation ───────────

fn safe_truncate(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    // Find the last char boundary at or before max_len
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
