// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Sub-Agent Runtime — Rust port via napi-rs
// Role definitions, tool subsets per role, context windowing logic,
// summarization thresholds. Actual LLM calls and tool execution stay in JS.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Context Window Configuration ────────────

/// Maximum messages to keep in the LLM context window.
const MAX_CONTEXT_MESSAGES: usize = 20;

/// Summarize when full history exceeds this count.
const SUMMARIZE_THRESHOLD: usize = 30;

/// Maximum characters to keep from a tool output for sub-agents.
const MAX_TOOL_OUTPUT_CHARS: usize = 4000;

/// Get the max context messages constant.
#[napi]
pub fn get_max_context_messages() -> i32 {
    MAX_CONTEXT_MESSAGES as i32
}

/// Get the summarize threshold constant.
#[napi]
pub fn get_summarize_threshold() -> i32 {
    SUMMARIZE_THRESHOLD as i32
}

/// Get the max tool output chars constant.
#[napi]
pub fn get_max_tool_output_chars() -> i32 {
    MAX_TOOL_OUTPUT_CHARS as i32
}

// ── Role Definitions ────────────────────────

/// Valid agent roles.
#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentRole {
    Researcher,
    Coder,
    Browser,
    System,
    General,
}

/// Get all valid agent role names.
#[napi]
pub fn get_valid_roles() -> Vec<String> {
    vec![
        "researcher".into(),
        "coder".into(),
        "browser".into(),
        "system".into(),
        "general".into(),
    ]
}

/// Validate and normalize a role string. Returns "general" if invalid.
#[napi]
pub fn validate_role(role: String) -> String {
    match role.as_str() {
        "researcher" | "coder" | "browser" | "system" | "general" => role,
        _ => "general".into(),
    }
}

// ── Tool Subsets Per Role ────────────────────

/// Get the tool names available for a given agent role.
/// "general" returns an empty array (meaning ALL tools are available).
#[napi]
pub fn get_role_tools(role: String) -> Vec<String> {
    match role.as_str() {
        "researcher" => vec![
            "web_search".into(),
            "deep_research".into(),
            "memory_store".into(),
            "memory_search".into(),
            "memory_list".into(),
            "read_file".into(),
            "get_current_time".into(),
        ],
        "coder" => vec![
            "shell_exec".into(),
            "shell_exec_background".into(),
            "shell_check_process".into(),
            "shell_wait_process".into(),
            "read_file".into(),
            "write_file".into(),
            "list_directory".into(),
            "search_files".into(),
            "delete_file".into(),
            "get_current_time".into(),
        ],
        "browser" => vec![
            "web_search".into(),
            "browser_navigate".into(),
            "browser_scan".into(),
            "browser_click_at".into(),
            "browser_type".into(),
            "browser_scroll".into(),
            "browser_extract".into(),
            "browser_back".into(),
            "browser_analyze".into(),
            "browser_run_js".into(),
            "browser_wait".into(),
            "browser_select".into(),
            "browser_keyboard".into(),
            "browser_switch_tab".into(),
            "browser_close".into(),
            "browser_scroll_element".into(),
            "get_current_time".into(),
        ],
        "system" => vec![
            "shell_exec".into(),
            "apple_script".into(),
            "os_screenshot".into(),
            "os_click".into(),
            "os_type".into(),
            "os_context".into(),
            "os_ocr_click".into(),
            "os_visual_verify".into(),
            "read_file".into(),
            "write_file".into(),
            "get_current_time".into(),
        ],
        // "general" and any unknown role → empty (all tools)
        _ => vec![],
    }
}

// ── Role System Prompts ─────────────────────

/// Get the system prompt for a given agent role.
#[napi]
pub fn get_role_prompt(role: String) -> String {
    match role.as_str() {
        "researcher" => r#"You are a focused research agent. Your job is to find information using search and memory tools.
Rules:
- Be concise and factual. Return structured findings, not essays.
- Always cite sources when using web search.
- Stop as soon as you have enough information — don't over-research.
- Output your findings as a clear bullet-point summary."#.into(),

        "coder" => r#"You are a focused coding agent. Your job is to read, write, and modify code files.
Rules:
- Write clean, working code with no placeholders.
- Always read existing files before modifying them.
- Test your changes when possible (run build, lint, etc).
- Output a brief summary of what you did and any relevant file paths."#.into(),

        "browser" => r#"You are a focused browser automation agent. Your job is to interact with web pages.
Rules:
- Always scan the page after navigating to understand the layout.
- Use precise element IDs from scan results for clicks and typing.
- Handle errors gracefully — retry with different approaches if needed.
- Output what you found or accomplished on the page."#.into(),

        "system" => r#"You are a focused system agent. Your job is to automate macOS tasks.
Rules:
- Use AppleScript for app automation, shell_exec for terminal commands.
- Take screenshots to verify your actions worked.
- Be careful with destructive operations — always verify before proceeding.
- Output a brief summary of what you accomplished."#.into(),

        _ => r#"You are a general-purpose agent. Complete the assigned task using any available tools.
Rules:
- Be efficient — use the minimum number of tool calls needed.
- Output a concise summary of your results."#.into(),
    }
}

// ── Sub-Agent Task / Result Types ───────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentTask {
    pub id: String,
    pub role: String,
    pub description: String,
    pub context: Option<String>,
    pub max_iterations: Option<i32>,
    pub timeout_ms: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentResult {
    pub id: String,
    pub role: String,
    pub success: bool,
    pub output: String,
    pub tool_calls: i32,
    pub duration_ms: f64,
    pub error: Option<String>,
}

/// Build the initial user content message for a sub-agent task.
#[napi]
pub fn build_sub_agent_prompt(task: SubAgentTask) -> String {
    let mut content = String::new();

    if let Some(ref ctx) = task.context {
        if !ctx.is_empty() {
            content.push_str("## Context from Previous Steps\n");
            content.push_str(ctx);
            content.push_str("\n\n");
        }
    }

    content.push_str("## Your Task\n");
    content.push_str(&task.description);

    content
}

/// Get the effective max iterations for a task (default: 50).
#[napi]
pub fn get_effective_max_iterations(task_max: Option<i32>) -> i32 {
    task_max.unwrap_or(50)
}

/// Get the effective timeout for a task in milliseconds (default: 300000 = 5 min).
#[napi]
pub fn get_effective_timeout_ms(task_timeout: Option<f64>) -> f64 {
    task_timeout.unwrap_or(300_000.0)
}

// ── Smart Context Windowing ─────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInfo {
    /// "user", "assistant", or "tool"
    pub role: String,
    /// The text content (or stringified content).
    pub content: String,
    /// For assistant messages with tool_calls: list of tool call function names.
    pub tool_call_names: Vec<String>,
    /// Whether this message has tool_calls attached.
    pub has_tool_calls: bool,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextWindowResult {
    /// Whether windowing was applied (history was too long).
    pub windowed: bool,
    /// The summary of older messages (if windowed).
    pub history_summary: Option<String>,
    /// Start index in the full history for the recent messages slice.
    pub recent_start_index: i32,
    /// Whether a new summary should be generated (history crossed summarize threshold).
    pub needs_summary: bool,
}

/// Determine how to window the context for a sub-agent's LLM call.
/// Returns instructions for JS on how to slice the message array.
#[napi]
pub fn compute_context_window(
    full_history_length: i32,
    existing_summary: Option<String>,
) -> ContextWindowResult {
    let len = full_history_length as usize;

    if len <= MAX_CONTEXT_MESSAGES {
        // Short history — send everything
        return ContextWindowResult {
            windowed: false,
            history_summary: None,
            recent_start_index: 0,
            needs_summary: false,
        };
    }

    // Long history — need windowing
    let recent_start = (len - MAX_CONTEXT_MESSAGES) as i32;
    let needs_summary = len >= SUMMARIZE_THRESHOLD && existing_summary.is_none();

    ContextWindowResult {
        windowed: true,
        history_summary: existing_summary,
        recent_start_index: recent_start,
        needs_summary,
    }
}

/// Build a context summary note to prepend to windowed messages.
#[napi]
pub fn build_context_summary_note(summary: String, older_message_count: i32) -> String {
    format!(
        "[CONTEXT SUMMARY - Previous {} messages]\n{}\n\n[END SUMMARY - Recent conversation continues below]",
        older_message_count, summary
    )
}

/// Summarize older messages into a compact synopsis (extractive, no LLM call).
/// This mirrors the TypeScript summarizeOldMessages function.
#[napi]
pub fn summarize_old_messages(messages: Vec<MessageInfo>) -> String {
    let mut tool_names: Vec<String> = Vec::new();
    let mut key_outputs: Vec<String> = Vec::new();

    for msg in &messages {
        if msg.role == "assistant" && msg.has_tool_calls {
            // Extract unique tool names used
            for name in &msg.tool_call_names {
                if !tool_names.contains(name) {
                    tool_names.push(name.clone());
                }
            }
        } else if msg.role == "tool" {
            // Extract first line of tool outputs (usually the most informative)
            let first_line: String = msg
                .content
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            if first_line.len() > 20 && !first_line.starts_with('{') {
                key_outputs.push(first_line);
            }
        } else if msg.role == "assistant" && msg.content.len() > 50 {
            // Extract assistant conclusions
            let conclusion: String = msg.content.chars().take(300).collect();
            if !conclusion.starts_with('[') && !conclusion.starts_with('{') {
                key_outputs.push(format!("Assistant: {}...", conclusion));
            }
        }
    }

    let mut summary_parts: Vec<String> = Vec::new();

    if !tool_names.is_empty() {
        summary_parts.push(format!("Tools used: {}", tool_names.join(", ")));
    }

    if !key_outputs.is_empty() {
        let items: Vec<String> = key_outputs.into_iter().take(5).collect();
        summary_parts.push(format!("Key findings:\n- {}", items.join("\n- ")));
    }

    if summary_parts.is_empty() {
        "Previous steps completed.".into()
    } else {
        summary_parts.join("\n\n")
    }
}

/// Truncate a tool result to the max allowed length for sub-agents.
#[napi]
pub fn truncate_tool_output(output: String) -> String {
    if output.len() <= MAX_TOOL_OUTPUT_CHARS {
        return output;
    }
    // Safe truncation at char boundary
    let mut end = MAX_TOOL_OUTPUT_CHARS;
    let bytes = output.as_bytes();
    while end > 0 && (end >= bytes.len() || !output.is_char_boundary(end)) {
        end -= 1;
    }
    output[..end].to_string()
}

/// Check if a role is the "general" role (uses all tools).
#[napi]
pub fn is_general_role(role: String) -> bool {
    role == "general"
}

/// Create an error SubAgentResult.
#[napi]
pub fn create_error_result(
    id: String,
    role: String,
    error_message: String,
    tool_calls: i32,
    duration_ms: f64,
) -> SubAgentResult {
    SubAgentResult {
        id,
        role,
        success: false,
        output: String::new(),
        tool_calls,
        duration_ms,
        error: Some(error_message),
    }
}

/// Create a success SubAgentResult.
#[napi]
pub fn create_success_result(
    id: String,
    role: String,
    output: String,
    tool_calls: i32,
    duration_ms: f64,
) -> SubAgentResult {
    SubAgentResult {
        id,
        role,
        success: true,
        output,
        tool_calls,
        duration_ms,
        error: None,
    }
}
