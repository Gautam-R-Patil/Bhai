// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Mesh Workflow Engine — Rust port via napi-rs
// DAG validation (Kahn's algorithm) and parallel/sequential execution planning.
// Actual agent execution stays in JS.

use std::collections::{HashMap, HashSet, VecDeque};

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Types ───────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshStep {
    pub id: String,
    pub role: String,
    pub description: String,
    pub depends_on: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshStepResult {
    pub id: String,
    pub success: bool,
    pub output: String,
    pub tool_calls: i32,
    pub duration_ms: f64,
    pub error: Option<String>,
}

/// A single execution wave: all steps in this wave can run in parallel.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionWave {
    /// Wave number (1-indexed).
    pub wave_number: i32,
    /// Step IDs that can run in parallel in this wave.
    pub step_ids: Vec<String>,
}

/// The full execution plan computed from DAG analysis.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    /// Ordered list of execution waves.
    pub waves: Vec<ExecutionWave>,
    /// Topological sort order (for reference/debugging).
    pub topological_order: Vec<String>,
    /// Total number of parallel waves.
    pub parallel_groups: i32,
}

/// Validation error details.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationError {
    pub error_type: String,
    pub message: String,
    /// Step IDs involved in the error (if applicable).
    pub step_ids: Vec<String>,
}

/// DAG validation result.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationError>,
}

// ── DAG Validation (Kahn's Algorithm) ───────

/// Validate a set of mesh steps as a valid DAG.
/// Checks:
/// 1. All dependency references point to existing step IDs
/// 2. No cycles (via Kahn's topological sort)
/// Returns a ValidationResult indicating success or listing all errors found.
#[napi]
pub fn validate_dag(steps: Vec<MeshStep>) -> ValidationResult {
    let mut errors = Vec::new();
    let ids: HashSet<String> = steps.iter().map(|s| s.id.clone()).collect();

    // Check for duplicate IDs
    if ids.len() != steps.len() {
        let mut seen = HashSet::new();
        let mut duplicates = Vec::new();
        for s in &steps {
            if !seen.insert(s.id.clone()) {
                duplicates.push(s.id.clone());
            }
        }
        errors.push(ValidationError {
            error_type: "duplicate_ids".into(),
            message: format!("Duplicate step IDs found: {}", duplicates.join(", ")),
            step_ids: duplicates,
        });
    }

    // Check all dependencies reference existing steps
    for step in &steps {
        for dep in &step.depends_on {
            if !ids.contains(dep) {
                errors.push(ValidationError {
                    error_type: "unknown_dependency".into(),
                    message: format!("Step \"{}\" depends on unknown step \"{}\"", step.id, dep),
                    step_ids: vec![step.id.clone(), dep.clone()],
                });
            }
        }
    }

    // Kahn's algorithm for cycle detection
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();

    for step in &steps {
        in_degree.entry(step.id.clone()).or_insert(0);
        let deg = in_degree.entry(step.id.clone()).or_insert(0);
        *deg = step.depends_on.iter().filter(|d| ids.contains(*d)).count();

        for dep in &step.depends_on {
            if ids.contains(dep) {
                adjacency.entry(dep.clone()).or_default().push(step.id.clone());
            }
        }
    }

    // Start with all zero-in-degree nodes
    let mut queue: VecDeque<String> = steps.iter()
        .filter(|s| {
            let effective_deps: usize = s.depends_on.iter().filter(|d| ids.contains(*d)).count();
            effective_deps == 0
        })
        .map(|s| s.id.clone())
        .collect();

    let mut visited: usize = 0;
    let mut topo_order: Vec<String> = Vec::new();

    while let Some(current) = queue.pop_front() {
        visited += 1;
        topo_order.push(current.clone());

        if let Some(neighbors) = adjacency.get(&current) {
            for next in neighbors {
                if let Some(degree) = in_degree.get_mut(next) {
                    *degree = degree.saturating_sub(1);
                    if *degree == 0 {
                        queue.push_back(next.clone());
                    }
                }
            }
        }
    }

    if visited != steps.len() {
        let unreachable: Vec<String> = steps.iter()
            .filter(|s| !topo_order.contains(&s.id))
            .map(|s| s.id.clone())
            .collect();

        errors.push(ValidationError {
            error_type: "cycle_detected".into(),
            message: format!(
                "Plan contains a cycle \u{2014} {} step(s) are unreachable: {}",
                steps.len() - visited,
                unreachable.join(", ")
            ),
            step_ids: unreachable,
        });
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

// ── Execution Ordering ──────────────────────

/// Compute the execution plan: group steps into parallel waves based on
/// dependency resolution. Steps whose dependencies are all satisfied
/// can run in the same wave (in parallel).
///
/// Throws (returns error) if the DAG is invalid.
#[napi]
pub fn compute_execution_plan(steps: Vec<MeshStep>) -> napi::Result<ExecutionPlan> {
    // Validate first
    let validation = validate_dag(steps.clone());
    if !validation.valid {
        let msgs: Vec<String> = validation.errors.iter().map(|e| e.message.clone()).collect();
        return Err(napi::Error::new(
            napi::Status::InvalidArg,
            format!("Invalid DAG: {}", msgs.join("; ")),
        ));
    }

    let mut completed: HashSet<String> = HashSet::new();
    let mut waves: Vec<ExecutionWave> = Vec::new();
    let mut topological_order: Vec<String> = Vec::new();
    let mut wave_number: i32 = 0;

    while completed.len() < steps.len() {
        // Find all steps whose dependencies are met
        let ready: Vec<String> = steps.iter()
            .filter(|s| {
                !completed.contains(&s.id)
                    && s.depends_on.iter().all(|dep| completed.contains(dep))
            })
            .map(|s| s.id.clone())
            .collect();

        if ready.is_empty() {
            // Should not happen after validation, but guard against it
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                "Deadlock detected \u{2014} no steps are ready".to_string(),
            ));
        }

        wave_number += 1;

        for id in &ready {
            completed.insert(id.clone());
            topological_order.push(id.clone());
        }

        waves.push(ExecutionWave {
            wave_number,
            step_ids: ready,
        });
    }

    Ok(ExecutionPlan {
        waves,
        topological_order,
        parallel_groups: wave_number,
    })
}

/// Gather dependency context for a step from completed results.
/// Returns a formatted context string containing outputs from all dependency steps.
#[napi]
pub fn gather_dependency_context(
    step_id: String,
    steps: Vec<MeshStep>,
    results_json: String,
) -> String {
    let step = match steps.iter().find(|s| s.id == step_id) {
        Some(s) => s,
        None => return String::new(),
    };

    let results: HashMap<String, MeshStepResult> = match serde_json::from_str(&results_json) {
        Ok(r) => r,
        Err(_) => return String::new(),
    };

    let step_map: HashMap<String, &MeshStep> = steps.iter().map(|s| (s.id.clone(), s)).collect();

    step.depends_on.iter()
        .filter_map(|dep_id| {
            let dep_result = results.get(dep_id)?;
            let dep_step = step_map.get(dep_id);
            let label = dep_step
                .map(|ds| format!("{} ({})", ds.role, dep_id))
                .unwrap_or_else(|| dep_id.clone());
            Some(format!("### Result from {}:\n{}", label, dep_result.output))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Check if a set of steps would form a valid DAG if a new dependency edge were added.
/// Useful for incremental plan building.
#[napi]
pub fn would_create_cycle(
    steps: Vec<MeshStep>,
    from_step_id: String,
    to_step_id: String,
) -> bool {
    // Check if to_step_id can reach from_step_id via existing dependencies
    // If so, adding from_step_id -> to_step_id would create a cycle
    let adjacency: HashMap<String, Vec<String>> = {
        let mut adj = HashMap::new();
        for step in &steps {
            for dep in &step.depends_on {
                // dep -> step.id (dep must complete before step)
                adj.entry(dep.clone()).or_insert_with(Vec::new).push(step.id.clone());
            }
        }
        adj
    };

    // BFS from to_step_id to see if we can reach from_step_id
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    queue.push_back(to_step_id.clone());

    while let Some(current) = queue.pop_front() {
        if current == from_step_id {
            return true; // Would create a cycle
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        if let Some(neighbors) = adjacency.get(&current) {
            for n in neighbors {
                if !visited.contains(n) {
                    queue.push_back(n.clone());
                }
            }
        }
    }

    false
}

/// Get the critical path length (longest dependency chain) in a DAG.
/// Returns the number of steps on the critical path.
#[napi]
pub fn get_critical_path_length(steps: Vec<MeshStep>) -> i32 {
    if steps.is_empty() {
        return 0;
    }

    let step_map: HashMap<String, &MeshStep> = steps.iter().map(|s| (s.id.clone(), s)).collect();

    // Compute longest path to each node using dynamic programming
    let mut longest: HashMap<String, i32> = HashMap::new();

    fn compute_longest(
        id: &str,
        step_map: &HashMap<String, &MeshStep>,
        longest: &mut HashMap<String, i32>,
    ) -> i32 {
        if let Some(&cached) = longest.get(id) {
            return cached;
        }

        let step = match step_map.get(id) {
            Some(s) => s,
            None => return 1,
        };

        let max_dep = step.depends_on.iter()
            .map(|dep| compute_longest(dep, step_map, longest))
            .max()
            .unwrap_or(0);

        let result = max_dep + 1;
        longest.insert(id.to_string(), result);
        result
    }

    steps.iter()
        .map(|s| compute_longest(&s.id, &step_map, &mut longest))
        .max()
        .unwrap_or(0)
}

// ── Critical Path & Step Priority ─────────────

/// Step priority level based on critical path position.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepPriority {
    pub step_id: String,
    /// "critical" | "normal" | "low"
    pub priority: String,
    /// Length of the longest path through this step.
    pub path_length: i32,
}

/// Compute the full critical path (ordered list of step IDs on the longest path).
#[napi]
pub fn compute_critical_path(steps: Vec<MeshStep>) -> Vec<String> {
    if steps.is_empty() {
        return vec![];
    }

    let step_map: HashMap<String, &MeshStep> = steps.iter().map(|s| (s.id.clone(), s)).collect();
    let mut longest: HashMap<String, i32> = HashMap::new();

    // Reuse the DP computation (same as get_critical_path_length)
    fn compute_longest_dp(
        id: &str,
        step_map: &HashMap<String, &MeshStep>,
        longest: &mut HashMap<String, i32>,
    ) -> i32 {
        if let Some(&cached) = longest.get(id) {
            return cached;
        }
        let step = match step_map.get(id) {
            Some(s) => s,
            None => return 1,
        };
        let max_dep = step.depends_on.iter()
            .map(|dep| compute_longest_dp(dep, step_map, longest))
            .max()
            .unwrap_or(0);
        let result = max_dep + 1;
        longest.insert(id.to_string(), result);
        result
    }

    // Compute longest path length for every step
    for s in &steps {
        compute_longest_dp(&s.id, &step_map, &mut longest);
    }

    // Find the overall max
    let max_len = longest.values().cloned().max().unwrap_or(0);
    if max_len == 0 {
        return vec![];
    }

    // Trace back the critical path from the terminal node with max_len
    let mut path: Vec<String> = Vec::new();
    let mut current_id: Option<String> = steps.iter()
        .find(|s| longest.get(&s.id).copied() == Some(max_len))
        .map(|s| s.id.clone());

    while let Some(id) = current_id {
        path.push(id.clone());
        let step = match step_map.get(&id) {
            Some(s) => s,
            None => break,
        };
        // Follow the dependency with the longest path
        current_id = step.depends_on.iter()
            .max_by_key(|dep| longest.get(*dep).copied().unwrap_or(0))
            .cloned();
    }

    path.reverse();
    path
}

/// Get priority for each step based on its position relative to the critical path.
/// Steps on the critical path are "critical", steps that feed into the critical
/// path (within 1 hop) are "normal", and leaf/peripheral steps are "low".
#[napi]
pub fn get_step_priorities(steps: Vec<MeshStep>) -> Vec<StepPriority> {
    if steps.is_empty() {
        return vec![];
    }

    let critical_path = compute_critical_path(steps.clone());
    let critical_set: HashSet<String> = critical_path.into_iter().collect();

    let step_map: HashMap<String, &MeshStep> = steps.iter().map(|s| (s.id.clone(), s)).collect();
    let mut longest: HashMap<String, i32> = HashMap::new();

    fn compute_len(
        id: &str,
        step_map: &HashMap<String, &MeshStep>,
        longest: &mut HashMap<String, i32>,
    ) -> i32 {
        if let Some(&cached) = longest.get(id) {
            return cached;
        }
        let step = match step_map.get(id) {
            Some(s) => s,
            None => return 1,
        };
        let max_dep = step.depends_on.iter()
            .map(|dep| compute_len(dep, step_map, longest))
            .max()
            .unwrap_or(0);
        let result = max_dep + 1;
        longest.insert(id.to_string(), result);
        result
    }

    for s in &steps {
        compute_len(&s.id, &step_map, &mut longest);
    }

    // Build reverse adjacency: who depends on this step?
    let mut dependents: HashMap<String, Vec<String>> = HashMap::new();
    for s in &steps {
        for dep in &s.depends_on {
            dependents.entry(dep.clone()).or_default().push(s.id.clone());
        }
    }

    steps.iter().map(|s| {
        let path_length = longest.get(&s.id).copied().unwrap_or(1);

        let priority = if critical_set.contains(&s.id) {
            "critical".to_string()
        } else {
            // Check if this step feeds into a critical step (1 hop)
            let feeds_critical = dependents.get(&s.id)
                .map(|deps| deps.iter().any(|d| critical_set.contains(d)))
                .unwrap_or(false);
            if feeds_critical {
                "normal".to_string()
            } else {
                "low".to_string()
            }
        };

        StepPriority {
            step_id: s.id.clone(),
            priority,
            path_length,
        }
    }).collect()
}
