// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Long-Running Task Executor — Rust port via napi-rs
// Phase planning, checkpoint management, heartbeat, recovery logic.
// Actual LLM calls, file I/O, and agent execution stay in JS.

use std::collections::HashMap;

use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ── Constants ───────────────────────────────

/// Maximum phases in a long task.
const MAX_PHASES: usize = 100;

/// Default iterations per phase for complex tasks.
const DEFAULT_PHASE_ITERATIONS: i32 = 200;

/// Default timeout per phase in milliseconds (30 minutes).
const DEFAULT_PHASE_TIMEOUT_MS: f64 = 1_800_000.0;

/// Progress update interval in milliseconds (30 seconds).
const PROGRESS_INTERVAL_MS: f64 = 30_000.0;

/// Heartbeat checkpoint interval in milliseconds (60 seconds).
const HEARTBEAT_CHECKPOINT_MS: f64 = 60_000.0;

/// Valid agent roles for task phases.
const VALID_ROLES: &[&str] = &["researcher", "coder", "browser", "system", "general"];

/// Get the max phases constant.
#[napi]
pub fn get_max_phases() -> i32 {
    MAX_PHASES as i32
}

/// Get the default phase iterations constant.
#[napi]
pub fn get_default_phase_iterations() -> i32 {
    DEFAULT_PHASE_ITERATIONS
}

/// Get the default phase timeout in milliseconds.
#[napi]
pub fn get_default_phase_timeout_ms() -> f64 {
    DEFAULT_PHASE_TIMEOUT_MS
}

/// Get the progress interval in milliseconds.
#[napi]
pub fn get_progress_interval_ms() -> f64 {
    PROGRESS_INTERVAL_MS
}

/// Get the heartbeat checkpoint interval in milliseconds.
#[napi]
pub fn get_heartbeat_checkpoint_ms() -> f64 {
    HEARTBEAT_CHECKPOINT_MS
}

// ── Types ───────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskPhase {
    pub id: String,
    pub role: String,
    pub description: String,
    pub depends_on: Vec<String>,
    pub max_iterations: Option<i32>,
    pub timeout_ms: Option<f64>,
}

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Planning,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTask {
    pub id: String,
    pub description: String,
    pub phases: Vec<TaskPhase>,
    pub status: TaskStatus,
    pub current_phase: i32,
    pub started_at: String,
    pub updated_at: String,
    /// phaseId → output JSON string (checkpoint data)
    pub checkpoint_data: HashMap<String, String>,
    pub error: Option<String>,
    pub total_duration_ms: f64,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTaskProgress {
    pub task_id: String,
    pub phases_total: i32,
    pub phases_completed: i32,
    pub current_phase_id: String,
    pub current_phase_description: String,
    pub status: TaskStatus,
    pub elapsed_ms: f64,
}

// ── In-Memory Store ─────────────────────────

lazy_static! {
    static ref ACTIVE_TASKS: Mutex<HashMap<String, LongTask>> = Mutex::new(HashMap::new());
    static ref TASK_COUNTER: Mutex<u64> = Mutex::new(0);
    /// Track which tasks have been cancelled (abort signal).
    static ref CANCELLED_TASKS: Mutex<std::collections::HashSet<String>> = Mutex::new(std::collections::HashSet::new());
}

/// Generate a unique task ID.
#[napi]
pub fn generate_task_id() -> String {
    let mut counter = TASK_COUNTER.lock();
    *counter += 1;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("lt_{}_{}", *counter, now_ms)
}

/// Create a new LongTask from a description and planned phases.
#[napi]
pub fn create_long_task(id: String, description: String, phases: Vec<TaskPhase>) -> LongTask {
    let now = chrono_now_iso();

    let task = LongTask {
        id: id.clone(),
        description,
        phases,
        status: TaskStatus::Running,
        current_phase: 0,
        started_at: now.clone(),
        updated_at: now,
        checkpoint_data: HashMap::new(),
        error: None,
        total_duration_ms: 0.0,
    };

    // Store in active tasks
    ACTIVE_TASKS.lock().insert(id, task.clone());

    task
}

/// Store a task in the active tasks map.
#[napi]
pub fn store_active_task(task_json: String) -> napi::Result<()> {
    let task: LongTask = serde_json::from_str(&task_json).map_err(|e| {
        napi::Error::new(
            napi::Status::InvalidArg,
            format!("Invalid task JSON: {}", e),
        )
    })?;
    ACTIVE_TASKS.lock().insert(task.id.clone(), task);
    Ok(())
}

/// Get a task from the active tasks map.
#[napi]
pub fn get_active_task(task_id: String) -> Option<String> {
    ACTIVE_TASKS
        .lock()
        .get(&task_id)
        .and_then(|t| serde_json::to_string(t).ok())
}

/// List all active task IDs.
#[napi]
pub fn list_active_task_ids() -> Vec<String> {
    ACTIVE_TASKS.lock().keys().cloned().collect()
}

/// List all active tasks as JSON strings.
#[napi]
pub fn list_active_tasks() -> Vec<String> {
    ACTIVE_TASKS
        .lock()
        .values()
        .filter_map(|t| serde_json::to_string(t).ok())
        .collect()
}

// ── Cancel Logic ────────────────────────────

/// Mark a task as cancelled. Returns true if the task was found and cancelled.
#[napi]
pub fn cancel_task(task_id: String) -> bool {
    let mut cancelled = CANCELLED_TASKS.lock();
    cancelled.insert(task_id.clone());

    let mut tasks = ACTIVE_TASKS.lock();
    if let Some(task) = tasks.get_mut(&task_id) {
        task.status = TaskStatus::Cancelled;
        task.updated_at = chrono_now_iso();
        true
    } else {
        false
    }
}

/// Check if a task has been cancelled.
#[napi]
pub fn is_task_cancelled(task_id: String) -> bool {
    CANCELLED_TASKS.lock().contains(&task_id)
}

/// Clear the cancellation flag for a task (e.g., on resume).
#[napi]
pub fn clear_task_cancellation(task_id: String) {
    CANCELLED_TASKS.lock().remove(&task_id);
}

// ── Phase Planning ──────────────────────────

/// Build the phase planning prompt for the LLM.
/// JS will send this to the LLM and parse the response using validate_phase_plan_response.
#[napi]
pub fn build_phase_planning_prompt(description: String) -> String {
    format!(
        r#"You are a task planner for long-running, complex tasks. Break down the following task into sequential phases.

Each phase will be executed by a specialized agent. Phases run one at a time (sequentially), with each phase receiving the output of previous phases as context.

Available agent roles:
- "researcher": Can search the web, search memory, read files. Use for information gathering.
- "coder": Can run shell commands, read/write files. Use for coding and file operations.
- "browser": Can navigate websites, click, type, extract data. Use for web automation.
- "system": Can run AppleScript, shell commands, take screenshots. Use for macOS automation.
- "general": Can use all tools. Use when a task doesn't fit other roles.

Rules:
- Maximum {} phases, but aim for the minimum needed
- Each phase has: id (e.g. "p1"), role, description, depends_on (list of phase IDs)
- Give each phase a VERY detailed description — the agent executing it needs full context
- For tasks that involve waiting (downloads, builds), wrap them in a single phase with clear instructions to monitor and wait
- Consider error recovery: if a download might fail, include retry logic in the description
- Output ONLY valid JSON array of phases, no markdown, no explanation

Example output:
[
    {{"id": "p1", "role": "researcher", "description": "Search for the download URL of XYZ software from the official website", "depends_on": []}},
    {{"id": "p2", "role": "coder", "description": "Download the file using curl/wget and verify the checksum. If download fails, retry up to 3 times.", "depends_on": ["p1"]}},
    {{"id": "p3", "role": "coder", "description": "Install the software and verify it works by running the version command", "depends_on": ["p2"]}}
]

Task: {}"#,
        MAX_PHASES, description
    )
}

/// Validate and normalize a phase plan response from the LLM.
/// Takes the raw LLM response text and returns validated phases.
/// Falls back to a single "general" phase if parsing fails.
#[napi]
pub fn validate_phase_plan_response(
    response_text: String,
    fallback_description: String,
) -> Vec<TaskPhase> {
    let fallback = vec![TaskPhase {
        id: "p1".into(),
        role: "general".into(),
        description: fallback_description,
        depends_on: vec![],
        max_iterations: None,
        timeout_ms: None,
    }];

    // Extract JSON array from response
    let json_str = match extract_json_array(&response_text) {
        Some(s) => s,
        None => return fallback,
    };

    let parsed: Vec<serde_json::Value> = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(_) => return fallback,
    };

    let mut phases: Vec<TaskPhase> = Vec::new();

    for (idx, p) in parsed.iter().enumerate().take(MAX_PHASES) {
        let id = p
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("p{}", idx + 1));

        let role_raw = p.get("role").and_then(|v| v.as_str()).unwrap_or("general");
        let role = if VALID_ROLES.contains(&role_raw) {
            role_raw.to_string()
        } else {
            "general".to_string()
        };

        let description = match p.get("description").and_then(|v| v.as_str()) {
            Some(d) => d.to_string(),
            None => continue, // Skip phases without descriptions
        };

        let depends_on = p
            .get("depends_on")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        let max_iterations = p
            .get("maxIterations")
            .and_then(|v| v.as_i64())
            .map(|n| n as i32);

        let timeout_ms = p.get("timeoutMs").and_then(|v| v.as_f64());

        phases.push(TaskPhase {
            id,
            role,
            description,
            depends_on,
            max_iterations,
            timeout_ms,
        });
    }

    if phases.is_empty() {
        return fallback;
    }

    phases
}

// ── Checkpoint Management ───────────────────

/// Store a checkpoint for a completed phase.
/// Updates the task's checkpoint data and metadata in the active store.
#[napi]
pub fn store_phase_checkpoint(
    task_id: String,
    phase_id: String,
    output: String,
    success: bool,
    error: Option<String>,
    total_duration_ms: f64,
) -> Option<String> {
    let mut tasks = ACTIVE_TASKS.lock();
    let task = tasks.get_mut(&task_id)?;

    if success {
        task.checkpoint_data.insert(phase_id.clone(), output);
    } else {
        let error_output = format!(
            "PHASE FAILED: {}\nPartial output: {}",
            error.as_deref().unwrap_or("unknown"),
            output
        );
        task.checkpoint_data.insert(phase_id.clone(), error_output);
    }

    task.total_duration_ms = total_duration_ms;
    task.updated_at = chrono_now_iso();

    serde_json::to_string(task).ok()
}

/// Store an error checkpoint for a phase that threw an exception.
#[napi]
pub fn store_phase_error_checkpoint(
    task_id: String,
    phase_id: String,
    error_message: String,
) -> Option<String> {
    let mut tasks = ACTIVE_TASKS.lock();
    let task = tasks.get_mut(&task_id)?;

    task.checkpoint_data
        .insert(phase_id, format!("PHASE ERROR: {}", error_message));
    task.updated_at = chrono_now_iso();

    serde_json::to_string(task).ok()
}

/// Mark a task as completed.
#[napi]
pub fn mark_task_completed(task_id: String, total_duration_ms: f64) -> Option<String> {
    let mut tasks = ACTIVE_TASKS.lock();
    let task = tasks.get_mut(&task_id)?;

    task.status = TaskStatus::Completed;
    task.total_duration_ms = total_duration_ms;
    task.updated_at = chrono_now_iso();

    serde_json::to_string(task).ok()
}

/// Mark a task as failed.
#[napi]
pub fn mark_task_failed(task_id: String, error_message: String) -> Option<String> {
    let mut tasks = ACTIVE_TASKS.lock();
    let task = tasks.get_mut(&task_id)?;

    task.status = TaskStatus::Failed;
    task.error = Some(error_message);
    task.updated_at = chrono_now_iso();

    serde_json::to_string(task).ok()
}

/// Mark a task as cancelled with updated timestamp.
#[napi]
pub fn mark_task_cancelled(task_id: String) -> Option<String> {
    let mut tasks = ACTIVE_TASKS.lock();
    let task = tasks.get_mut(&task_id)?;

    task.status = TaskStatus::Cancelled;
    task.updated_at = chrono_now_iso();

    serde_json::to_string(task).ok()
}

/// Update the current phase index.
#[napi]
pub fn set_current_phase(task_id: String, phase_index: i32) {
    let mut tasks = ACTIVE_TASKS.lock();
    if let Some(task) = tasks.get_mut(&task_id) {
        task.current_phase = phase_index;
        task.updated_at = chrono_now_iso();
    }
}

/// Update the task's total duration (for heartbeat checkpoints).
#[napi]
pub fn update_task_duration(task_id: String, total_duration_ms: f64) {
    let mut tasks = ACTIVE_TASKS.lock();
    if let Some(task) = tasks.get_mut(&task_id) {
        task.total_duration_ms = total_duration_ms;
        task.updated_at = chrono_now_iso();
    }
}

// ── Dependency Context ──────────────────────

/// Gather context from dependency phases for a given phase.
#[napi]
pub fn gather_phase_dependency_context(task_id: String, phase_id: String) -> String {
    let tasks = ACTIVE_TASKS.lock();
    let task = match tasks.get(&task_id) {
        Some(t) => t,
        None => return String::new(),
    };

    let phase = match task.phases.iter().find(|p| p.id == phase_id) {
        Some(p) => p,
        None => return String::new(),
    };

    phase
        .depends_on
        .iter()
        .filter_map(|dep_id| {
            let output = task.checkpoint_data.get(dep_id)?;
            if output.is_empty() {
                return None;
            }
            Some(format!("### Result from phase {}:\n{}", dep_id, output))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ── Resume Logic ────────────────────────────

/// Find the next uncompleted phase for a task (for resume).
/// Returns -1 if all phases are complete.
#[napi]
pub fn find_next_uncompleted_phase(task_id: String) -> i32 {
    let tasks = ACTIVE_TASKS.lock();
    let task = match tasks.get(&task_id) {
        Some(t) => t,
        None => return -1,
    };

    task.phases
        .iter()
        .position(|p| !task.checkpoint_data.contains_key(&p.id))
        .map(|i| i as i32)
        .unwrap_or(-1)
}

/// Prepare a task for resumption. Updates status and current phase.
/// Returns the task JSON or None if not found.
#[napi]
pub fn prepare_task_resume(task_id: String, next_phase: i32) -> Option<String> {
    let mut tasks = ACTIVE_TASKS.lock();
    let task = tasks.get_mut(&task_id)?;

    task.current_phase = next_phase;
    task.status = TaskStatus::Running;
    task.updated_at = chrono_now_iso();

    // Clear any cancellation flag
    CANCELLED_TASKS.lock().remove(&task_id);

    serde_json::to_string(task).ok()
}

/// Check if a task should be auto-resumed (was running/paused when process died).
#[napi]
pub fn should_auto_resume(status: TaskStatus) -> bool {
    matches!(status, TaskStatus::Running | TaskStatus::Paused)
}

/// Check if a task is already completed (no need to resume).
#[napi]
pub fn is_task_completed(status: TaskStatus) -> bool {
    status == TaskStatus::Completed
}

// ── Progress Builder ────────────────────────

/// Build a LongTaskProgress object from the current task state.
#[napi]
pub fn build_task_progress(task_id: String, phase_index: i32, elapsed_ms: f64) -> Option<String> {
    let tasks = ACTIVE_TASKS.lock();
    let task = tasks.get(&task_id)?;

    let phases_total = task.phases.len() as i32;
    let current_phase = task.phases.get(phase_index as usize);

    let progress = LongTaskProgress {
        task_id: task.id.clone(),
        phases_total,
        phases_completed: phase_index,
        current_phase_id: current_phase
            .map(|p| p.id.clone())
            .unwrap_or_else(|| "done".into()),
        current_phase_description: current_phase
            .map(|p| p.description.clone())
            .unwrap_or_else(|| "All phases completed".into()),
        status: task.status,
        elapsed_ms,
    };

    serde_json::to_string(&progress).ok()
}

/// Build a completion progress notification.
#[napi]
pub fn build_completion_progress(task_id: String, total_duration_ms: f64) -> Option<String> {
    let tasks = ACTIVE_TASKS.lock();
    let task = tasks.get(&task_id)?;

    let progress = LongTaskProgress {
        task_id: task.id.clone(),
        phases_total: task.phases.len() as i32,
        phases_completed: task.phases.len() as i32,
        current_phase_id: "done".into(),
        current_phase_description: "All phases completed".into(),
        status: TaskStatus::Completed,
        elapsed_ms: total_duration_ms,
    };

    serde_json::to_string(&progress).ok()
}

// ── Heartbeat Logic ─────────────────────────

/// Determine if a heartbeat checkpoint should be saved based on elapsed time.
#[napi]
pub fn needs_heartbeat_checkpoint(last_heartbeat_ms: f64, now_ms: f64) -> bool {
    (now_ms - last_heartbeat_ms) >= HEARTBEAT_CHECKPOINT_MS
}

/// Get the effective max iterations for a phase (with default).
#[napi]
pub fn get_phase_max_iterations(phase_max: Option<i32>) -> i32 {
    phase_max.unwrap_or(DEFAULT_PHASE_ITERATIONS)
}

/// Get the effective timeout for a phase in milliseconds (with default).
#[napi]
pub fn get_phase_timeout_ms(phase_timeout: Option<f64>) -> f64 {
    phase_timeout.unwrap_or(DEFAULT_PHASE_TIMEOUT_MS)
}

/// Serialize a LongTask to JSON string (for checkpoint persistence).
#[napi]
pub fn serialize_task(task_json: String) -> napi::Result<String> {
    // Validate it's valid JSON by parsing and re-serializing
    let task: LongTask = serde_json::from_str(&task_json).map_err(|e| {
        napi::Error::new(
            napi::Status::InvalidArg,
            format!("Invalid task JSON: {}", e),
        )
    })?;
    serde_json::to_string_pretty(&task).map_err(|e| {
        napi::Error::new(
            napi::Status::GenericFailure,
            format!("Serialization failed: {}", e),
        )
    })
}

/// Deserialize a LongTask from JSON string (for loading checkpoints).
#[napi]
pub fn deserialize_task(json: String) -> napi::Result<String> {
    // Validate and normalize
    let task: LongTask = serde_json::from_str(&json).map_err(|e| {
        napi::Error::new(
            napi::Status::InvalidArg,
            format!("Invalid task JSON: {}", e),
        )
    })?;

    // Store in active tasks
    ACTIVE_TASKS.lock().insert(task.id.clone(), task.clone());

    serde_json::to_string(&task).map_err(|e| {
        napi::Error::new(
            napi::Status::GenericFailure,
            format!("Serialization failed: {}", e),
        )
    })
}

/// Remove a task from the active tasks map.
#[napi]
pub fn remove_active_task(task_id: String) -> bool {
    ACTIVE_TASKS.lock().remove(&task_id).is_some()
}

// ── Helper: Extract JSON array from text ────

fn extract_json_array(text: &str) -> Option<String> {
    let start = text.find('[')?;
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
        if b == b'[' {
            depth += 1;
        } else if b == b']' {
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

// ── Helper: ISO timestamp ───────────────────

fn chrono_now_iso() -> String {
    // Simple ISO 8601 timestamp without external dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();

    // Convert to datetime components (simplified, UTC)
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    let millis = now.subsec_millis();

    // Days since epoch to date (simplified Gregorian)
    let mut y = 1970i64;
    let mut remaining_days = days as i64;

    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }

    let days_in_months: [i64; 12] = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0usize;
    for (i, &dim) in days_in_months.iter().enumerate() {
        if remaining_days < dim {
            m = i;
            break;
        }
        remaining_days -= dim;
    }

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes,
        seconds,
        millis
    )
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}
