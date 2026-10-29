// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Goal Engine — Rust hot-path for goal priority scoring, curiosity signals,
// goal decay/reinforcement, and feasibility estimation.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Constants ──────────────────────────────────────

/// Daily decay rate for inactive goals
const GOAL_DECAY_RATE: f64 = 0.02;

/// Minimum priority before a goal is auto-abandoned
const ABANDON_THRESHOLD: f64 = 0.05;

/// Max age in days for proposed goals before auto-cleanup
const PROPOSED_MAX_AGE_DAYS: f64 = 14.0;

/// Curiosity signal threshold for knowledge graph gap detection
const CURIOSITY_GAP_THRESHOLD: f64 = 0.3;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct GoalCandidate {
    pub title: String,
    pub description: String,
    pub source: String, // "user_explicit" | "pattern_observed" | "curiosity" | "dream"
    pub evidence_strength: f64, // 0-1 how strong the evidence for this goal
    pub user_interest_score: f64, // 0-1 how relevant to user's interests
    pub feasibility: f64, // 0-1 how achievable
    pub urgency: f64,   // 0-1 how time-sensitive
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct GoalPriority {
    pub title: String,
    pub priority: f64,
    pub breakdown: String, // JSON breakdown of scoring factors
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ActiveGoal {
    pub id: u32,
    pub title: String,
    pub priority: f64,
    pub progress: f64,
    pub days_since_update: f64,
    pub source: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct KnowledgeGraphEntity {
    pub name: String,
    pub entity_type: String,
    pub connection_count: u32,
    pub last_mentioned_days_ago: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CuriositySignal {
    pub topic: String,
    pub signal_type: String, // "knowledge_gap" | "declining_interest" | "unexplored" | "stale_entity"
    pub strength: f64,
    pub reasoning: String,
}

// ── Goal Priority Scoring ──────────────────────────

/// Score and rank goal candidates by priority.
/// Factors: evidence strength × user interest × feasibility × urgency.
/// Source type applies a multiplier (user-explicit goals rank higher).
#[napi]
pub fn score_goal_priorities(candidates: Vec<GoalCandidate>) -> Vec<GoalPriority> {
    let mut priorities: Vec<GoalPriority> = candidates
        .iter()
        .map(|c| {
            let source_multiplier = match c.source.as_str() {
                "user_explicit" => 1.5,
                "pattern_observed" => 1.0,
                "dream" => 0.8,
                "curiosity" => 0.6,
                _ => 0.7,
            };

            let raw_priority = c.evidence_strength * 0.25
                + c.user_interest_score * 0.30
                + c.feasibility * 0.20
                + c.urgency * 0.25;

            let priority = (raw_priority * source_multiplier).clamp(0.0, 1.0);

            let breakdown = format!(
                r#"{{"evidence":{:.2},"interest":{:.2},"feasibility":{:.2},"urgency":{:.2},"source_mult":{:.1},"raw":{:.3}}}"#,
                c.evidence_strength, c.user_interest_score, c.feasibility,
                c.urgency, source_multiplier, raw_priority
            );

            GoalPriority {
                title: c.title.clone(),
                priority,
                breakdown,
            }
        })
        .collect();

    // Sort by priority descending
    priorities.sort_by(|a, b| {
        b.priority
            .partial_cmp(&a.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    priorities
}

// ── Goal Lifecycle ─────────────────────────────────

/// Apply daily decay to inactive goals and compute updated priorities.
/// Returns list of (goal_id, new_priority, should_abandon) tuples.
#[napi]
pub fn apply_goal_decay(goals: Vec<ActiveGoal>) -> Vec<Vec<f64>> {
    goals
        .iter()
        .map(|g| {
            // Goals with recent progress decay slower
            let decay_factor = if g.days_since_update < 1.0 {
                0.0 // Updated today, no decay
            } else if g.days_since_update < 3.0 {
                GOAL_DECAY_RATE * 0.5
            } else if g.days_since_update < 7.0 {
                GOAL_DECAY_RATE
            } else {
                GOAL_DECAY_RATE * 1.5 // Accelerated decay for stale goals
            };

            // User-explicit goals decay slower
            let source_factor = if g.source == "user_explicit" {
                0.5
            } else {
                1.0
            };

            let new_priority = (g.priority - decay_factor * source_factor).max(0.0);
            let should_abandon = if new_priority < ABANDON_THRESHOLD {
                1.0
            } else {
                0.0
            };

            vec![g.id as f64, new_priority, should_abandon]
        })
        .collect()
}

/// Reinforce a goal's priority based on user engagement.
/// Returns the new priority value.
#[napi]
pub fn reinforce_goal(
    current_priority: f64,
    engagement_type: String, // "mentioned" | "worked_on" | "completed_task" | "explicitly_asked"
) -> f64 {
    let boost = match engagement_type.as_str() {
        "explicitly_asked" => 0.15,
        "completed_task" => 0.10,
        "worked_on" => 0.05,
        "mentioned" => 0.02,
        _ => 0.01,
    };

    (current_priority + boost).min(1.0)
}

// ── Curiosity Signal Computation ───────────────────

/// Analyze knowledge graph entities to find curiosity-worthy gaps.
/// Identifies: isolated entities (few connections), stale entities (not mentioned recently),
/// and potential unexplored topics.
#[napi]
pub fn compute_curiosity_signals(
    entities: Vec<KnowledgeGraphEntity>,
    user_interest_topics: Vec<String>,
) -> Vec<CuriositySignal> {
    let mut signals: Vec<CuriositySignal> = Vec::new();

    // Build interest set for quick lookup
    let interests: HashSet<String> = user_interest_topics
        .iter()
        .map(|t| t.to_lowercase())
        .collect();

    // Compute average connectivity
    let avg_connections = if entities.is_empty() {
        0.0
    } else {
        entities
            .iter()
            .map(|e| e.connection_count as f64)
            .sum::<f64>()
            / entities.len() as f64
    };

    for entity in &entities {
        let name_lower = entity.name.to_lowercase();

        // Knowledge gap: entity related to interests but poorly connected
        if interests
            .iter()
            .any(|i| name_lower.contains(i) || i.contains(&name_lower))
            && (entity.connection_count as f64) < avg_connections * CURIOSITY_GAP_THRESHOLD
        {
            signals.push(CuriositySignal {
                topic: entity.name.clone(),
                signal_type: "knowledge_gap".to_string(),
                strength: (1.0 - entity.connection_count as f64 / avg_connections.max(1.0))
                    .clamp(0.0, 1.0),
                reasoning: format!(
                    "'{}' is related to user interests but has only {} connections (avg: {:.0})",
                    entity.name, entity.connection_count, avg_connections
                ),
            });
        }

        // Stale entity: mentioned in interests but not recently discussed
        if entity.last_mentioned_days_ago > 30.0 && entity.connection_count > 2 {
            let staleness = (entity.last_mentioned_days_ago / 90.0).min(1.0);
            if staleness > 0.3 {
                signals.push(CuriositySignal {
                    topic: entity.name.clone(),
                    signal_type: "stale_entity".to_string(),
                    strength: staleness * 0.7,
                    reasoning: format!(
                        "'{}' was a connected topic but hasn't been discussed in {:.0} days",
                        entity.name, entity.last_mentioned_days_ago
                    ),
                });
            }
        }

        // Unexplored: entity type suggests exploration value
        if (entity.entity_type == "project" || entity.entity_type == "tool")
            && entity.connection_count < 3
            && entity.last_mentioned_days_ago < 7.0
        {
            signals.push(CuriositySignal {
                topic: entity.name.clone(),
                signal_type: "unexplored".to_string(),
                strength: 0.5,
                reasoning: format!(
                    "'{}' ({}) was recently mentioned but barely explored",
                    entity.name, entity.entity_type
                ),
            });
        }
    }

    // Sort by strength descending, cap at 10
    signals.sort_by(|a, b| {
        b.strength
            .partial_cmp(&a.strength)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    signals.truncate(10);
    signals
}

/// Score how well a dream task aligns with active goals.
/// Returns alignment score (0-1).
#[napi]
pub fn score_dream_task_alignment(
    task_keywords: Vec<String>,
    goal_keywords: Vec<Vec<String>>,
    goal_priorities: Vec<f64>,
) -> f64 {
    if goal_keywords.is_empty() || task_keywords.is_empty() {
        return 0.0;
    }

    let task_set: HashSet<String> = task_keywords.iter().map(|k| k.to_lowercase()).collect();
    let mut max_alignment = 0.0f64;

    for (i, gk) in goal_keywords.iter().enumerate() {
        let goal_set: HashSet<String> = gk.iter().map(|k| k.to_lowercase()).collect();

        // Jaccard similarity between task and goal keywords
        let intersection = task_set.intersection(&goal_set).count() as f64;
        let union = task_set.union(&goal_set).count() as f64;

        if union > 0.0 {
            let similarity = intersection / union;
            let priority = goal_priorities.get(i).copied().unwrap_or(0.5);
            let alignment = similarity * priority;
            if alignment > max_alignment {
                max_alignment = alignment;
            }
        }
    }

    max_alignment.clamp(0.0, 1.0)
}
