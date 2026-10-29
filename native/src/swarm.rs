// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Swarm Orchestrator — Rust port via napi-rs
// Task decomposition planning and synthesis structure.
// Actual LLM calls for decomposition/synthesis stay in JS.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Constants ───────────────────────────────

/// Maximum number of steps in a swarm plan.
const MAX_STEPS: usize = 20;

/// Timeout per step in milliseconds (5 minutes).
const STEP_TIMEOUT_MS: u64 = 300_000;

/// Valid agent roles for swarm steps.
const VALID_ROLES: &[&str] = &["researcher", "coder", "browser", "system", "general"];

// ── Types ───────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmStep {
    pub id: String,
    pub role: String,
    pub description: String,
    pub depends_on: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmPlan {
    pub steps: Vec<SwarmStep>,
    pub reasoning: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmStepResult {
    pub id: String,
    pub role: String,
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmResult {
    pub plan: SwarmPlan,
    pub synthesis: String,
    pub total_duration_ms: f64,
    pub steps_completed: i32,
    pub steps_failed: i32,
}

// ── Decomposition Prompt ────────────────────

/// Build the decomposition prompt for the LLM.
/// JS will send this to the LLM and parse the response using validate_decomposition_response.
#[napi]
pub fn build_decomposition_prompt(user_request: String) -> String {
    format!(
        r#"You are a task planner. Break down the following user request into independent steps that can be executed by specialized agents.

Available agent roles:
- "researcher": Can search the web, search memory, and read files. Use for information gathering.
- "coder": Can run shell commands, read/write files. Use for coding and file operations.
- "browser": Can navigate websites, click, type, extract data. Use for web automation.
- "system": Can run AppleScript, shell commands, take screenshots. Use for macOS automation.
- "general": Can use all tools. Use when a task doesn't fit other roles.

Rules:
- Maximum {} steps
- Each step has: id (short like "s1", "s2"), role, description, depends_on (array of step IDs)
- Steps with no dependencies will run IN PARALLEL — use this for independent tasks
- Steps with dependencies run AFTER those steps complete and receive their results
- If the request is simple enough for ONE agent, return {{"steps":[], "reasoning":"..."}}
- Only decompose when there are genuinely independent sub-tasks or different expertise needed
- Output ONLY valid JSON, no markdown, no explanation

Example output:
{{
  "steps": [
    {{"id": "s1", "role": "researcher", "description": "Search for the top 3 AI frameworks in 2025", "depends_on": []}},
    {{"id": "s2", "role": "researcher", "description": "Find pricing and features for each framework", "depends_on": ["s1"]}},
    {{"id": "s3", "role": "coder", "description": "Create a comparison table in markdown and save to comparison.md", "depends_on": ["s2"]}}
  ],
  "reasoning": "Research phase can be split from writing. s2 depends on s1 for the framework names."
}}

User request: {}"#,
        MAX_STEPS, user_request
    )
}

/// Validate and normalize a decomposition response from the LLM.
/// Takes the raw LLM response text and returns a validated SwarmPlan or None.
#[napi]
pub fn validate_decomposition_response(response_text: String) -> Option<SwarmPlan> {
    // Extract JSON from response
    let json_str = extract_json_object(&response_text)?;

    let parsed: serde_json::Value = serde_json::from_str(&json_str).ok()?;

    // Must have a "steps" array
    let steps_arr = parsed.get("steps")?.as_array()?;

    let mut steps: Vec<SwarmStep> = Vec::new();

    for s in steps_arr.iter().take(MAX_STEPS) {
        let id = s.get("id").and_then(|v| v.as_str());
        let role = s.get("role").and_then(|v| v.as_str());
        let description = s.get("description").and_then(|v| v.as_str());

        // All three fields are required
        let (id, role, description) = match (id, role, description) {
            (Some(i), Some(r), Some(d)) => (i, r, d),
            _ => continue,
        };

        // Validate role, default to "general"
        let validated_role = if VALID_ROLES.contains(&role) {
            role.to_string()
        } else {
            "general".to_string()
        };

        // Parse depends_on
        let depends_on = s
            .get("depends_on")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        steps.push(SwarmStep {
            id: id.to_string(),
            role: validated_role,
            description: description.to_string(),
            depends_on,
        });
    }

    let reasoning = parsed
        .get("reasoning")
        .and_then(|v| v.as_str())
        .unwrap_or("No reasoning provided")
        .to_string();

    Some(SwarmPlan { steps, reasoning })
}

// ── Synthesis Prompt ────────────────────────

/// Build the synthesis prompt for merging step results into a final answer.
/// JS will send this to the LLM.
#[napi]
pub fn build_synthesis_prompt(
    user_request: String,
    plan: SwarmPlan,
    results: Vec<SwarmStepResult>,
) -> String {
    // Build result map for quick lookup
    let result_map: std::collections::HashMap<String, &SwarmStepResult> =
        results.iter().map(|r| (r.id.clone(), r)).collect();

    // Build a summary of all step results
    let result_summary: String = plan
        .steps
        .iter()
        .map(|step| match result_map.get(&step.id) {
            None => format!("### Step {} ({}): NOT EXECUTED", step.id, step.role),
            Some(r) if !r.success => {
                format!(
                    "### Step {} ({}): FAILED\nError: {}",
                    step.id,
                    step.role,
                    r.error.as_deref().unwrap_or("unknown")
                )
            }
            Some(r) => {
                format!(
                    "### Step {} ({}): {}\n{}",
                    step.id, step.role, step.description, r.output
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        r#"The user asked: "{}"

I broke this into {} sub-tasks and executed them. Here are the results:

{}

Now synthesize these results into a single, coherent response for the user. Be concise and natural — don't mention the steps or the decomposition process. Just answer as if you did it all yourself."#,
        user_request,
        plan.steps.len(),
        result_summary
    )
}

/// Build a fallback synthesis by concatenating results directly.
/// Used when the LLM synthesis call fails.
#[napi]
pub fn build_fallback_synthesis(results: Vec<SwarmStepResult>) -> String {
    results
        .iter()
        .filter_map(|r| {
            if r.output.is_empty() {
                None
            } else {
                Some(r.output.as_str())
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Count completed and failed steps from results.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepCounts {
    pub completed: i32,
    pub failed: i32,
}

#[napi]
pub fn count_step_results(results: Vec<SwarmStepResult>) -> StepCounts {
    let mut completed = 0;
    let mut failed = 0;
    for r in &results {
        if r.success {
            completed += 1;
        } else {
            failed += 1;
        }
    }
    StepCounts { completed, failed }
}

/// Get the step timeout in milliseconds.
#[napi]
pub fn get_step_timeout_ms() -> f64 {
    STEP_TIMEOUT_MS as f64
}

/// Get the max steps constant.
#[napi]
pub fn get_max_steps() -> i32 {
    MAX_STEPS as i32
}

/// Format a step log line for console output.
#[napi]
pub fn format_step_log(step: SwarmStep) -> String {
    let deps = if step.depends_on.is_empty() {
        " (no deps)".to_string()
    } else {
        format!(" (after: {})", step.depends_on.join(", "))
    };
    format!(
        "  \u{2192} {} [{}]: {}{}",
        step.id, step.role, step.description, deps
    )
}

// ── Helper: Extract JSON object from text ───

fn extract_json_object(text: &str) -> Option<String> {
    // Find the first '{' and the matching '}'
    let start = text.find('{')?;
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut end = start;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if escape_next {
            escape_next = false;
            continue;
        }
        if b == b'\\' && in_string {
            escape_next = true;
            continue;
        }
        if b == b'"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            if depth == 0 {
                end = i;
                break;
            }
        }
    }

    if depth == 0 && end > start {
        Some(text[start..=end].to_string())
    } else {
        None
    }
}
