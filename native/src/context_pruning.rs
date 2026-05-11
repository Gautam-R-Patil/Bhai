// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Context Pruning — Full port of src/memory/context-pruning.ts (algorithmic parts)
// LLM summarization calls stay in JS; Rust handles token estimation, split finding,
// and tool history compression.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ──────────────────────────────────────

const MAX_MESSAGES: usize = 40;
const PRUNE_KEEP_RECENT: usize = 10;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ContextMessageInfo {
    pub role: String,       // "user" | "assistant" | "system" | "tool"
    pub content: String,    // text content (may be truncated)
    pub has_tool_calls: bool,
    pub tool_call_id: Option<String>,
    /// Serialized tool_calls array if present
    pub tool_calls_json: Option<String>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PruneSplit {
    /// Index to split at (messages before this go into summary)
    pub split_index: u32,
    /// Whether pruning is needed
    pub needs_pruning: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CompressedMessage {
    pub role: String,
    pub content: String,
    pub tool_call_id: Option<String>,
}

// ── Token Estimation ───────────────────────────────

/// Rough token counter (~4 chars per token)
#[napi]
pub fn estimate_tokens(text: String) -> u32 {
    ((text.len() as f64) / 4.0).ceil() as u32
}

/// Estimate total tokens across messages
#[napi]
pub fn estimate_messages_tokens(messages: Vec<ContextMessageInfo>) -> u32 {
    messages
        .iter()
        .map(|m| ((m.content.len() as f64) / 4.0).ceil() as u32)
        .sum()
}

// ── Split Finding ──────────────────────────────────

/// Find the safe split point for context pruning.
/// Returns the split index and whether pruning is needed.
#[napi]
pub fn find_prune_split(messages: Vec<ContextMessageInfo>) -> PruneSplit {
    if messages.len() <= MAX_MESSAGES {
        return PruneSplit {
            split_index: 0,
            needs_pruning: false,
        };
    }

    let target_split = messages.len() - PRUNE_KEEP_RECENT;
    let mut safe_split = target_split;

    // Look backwards for the nearest user message
    while safe_split > 0 && messages[safe_split].role != "user" {
        safe_split -= 1;
    }

    // If no user message was found backwards, look forwards
    if safe_split == 0 {
        safe_split = target_split;
        while safe_split < messages.len() && messages[safe_split].role != "user" {
            safe_split += 1;
        }
        if safe_split == messages.len() {
            safe_split = target_split;
        }
    }

    // Walk forward past any orphaned assistant+tool_calls block and its tool responses
    while safe_split < messages.len() {
        let msg = &messages[safe_split];
        if msg.role == "assistant" && msg.has_tool_calls {
            safe_split += 1;
            while safe_split < messages.len() && messages[safe_split].role == "tool" {
                safe_split += 1;
            }
        } else {
            break;
        }
    }

    PruneSplit {
        split_index: safe_split as u32,
        needs_pruning: true,
    }
}

/// Find the safe split point for compact conversation.
#[napi]
pub fn find_compact_split(message_count: u32) -> u32 {
    if message_count <= 4 {
        return 0;
    }

    let half = (message_count as f64 / 2.0).floor() as u32;
    let split = message_count - half.min(6);
    split.max(1)
}

// ── Tool History Compression ───────────────────────

/// Compress tool history in messages to save tokens.
/// Returns compressed message list.
#[napi]
pub fn compress_tool_history(messages: Vec<ContextMessageInfo>) -> Vec<CompressedMessage> {
    let mut compressed: Vec<CompressedMessage> = Vec::new();

    // Find the last user message index
    let mut last_user_index = messages.len();
    for i in (0..messages.len()).rev() {
        if messages[i].role == "user" {
            last_user_index = i;
            break;
        }
    }

    for (i, msg) in messages.iter().enumerate() {
        // Reached the active turn? Copy verbatim
        if i >= last_user_index {
            compressed.push(CompressedMessage {
                role: msg.role.clone(),
                content: msg.content.clone(),
                tool_call_id: msg.tool_call_id.clone(),
            });
            continue;
        }

        // Assistant with tool calls -> compress
        if msg.role == "assistant" && msg.has_tool_calls {
            let mut tool_summary = if !msg.content.is_empty() {
                format!("{}\n\n", msg.content)
            } else {
                String::new()
            };
            tool_summary.push_str("[Tools Used]:\n");

            if let Some(ref tc_json) = msg.tool_calls_json {
                // Parse tool calls JSON to extract function names
                if let Ok(calls) = serde_json::from_str::<Vec<ToolCall>>(tc_json) {
                    for tc in &calls {
                        tool_summary.push_str(&format!(
                            "- {}({})\n",
                            tc.function.name, tc.function.arguments
                        ));
                    }
                }
            }

            compressed.push(CompressedMessage {
                role: "system".to_string(),
                content: tool_summary.trim().to_string(),
                tool_call_id: None,
            });
            continue;
        }

        // Tool response -> compress severely
        if msg.role == "tool" {
            let content_preview = if msg.content.len() > 500 {
                let mut end = 500;
                while end > 0 && !msg.content.is_char_boundary(end) { end -= 1; }
                format!("{}...(truncated)", &msg.content[..end])
            } else {
                msg.content.clone()
            };
            let call_id = msg.tool_call_id.as_deref().unwrap_or("");
            compressed.push(CompressedMessage {
                role: "system".to_string(),
                content: format!(
                    "<tool_log call_id=\"{}\">{}</tool_log>",
                    call_id, content_preview
                ),
                tool_call_id: None,
            });
            continue;
        }

        compressed.push(CompressedMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
            tool_call_id: msg.tool_call_id.clone(),
        });
    }

    // Merge consecutive system messages
    let mut merged: Vec<CompressedMessage> = Vec::new();
    for msg in compressed {
        if let Some(last) = merged.last_mut() {
            if last.role == "system" && msg.role == "system" {
                last.content = format!("{}\n{}", last.content, msg.content);
                continue;
            }
        }
        merged.push(msg);
    }

    merged
}

// ── Helper types for JSON parsing ──────────────────

#[derive(Deserialize)]
struct ToolCall {
    function: ToolCallFunction,
}

#[derive(Deserialize)]
struct ToolCallFunction {
    name: String,
    arguments: String,
}
