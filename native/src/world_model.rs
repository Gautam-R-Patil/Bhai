// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// World Model — Rust hot-path for entity confidence decay, accessibility aggregation,
// and planning feasibility checks.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

/// Half-life for entity confidence decay (hours since last verification)
const CONFIDENCE_HALF_LIFE_HOURS: f64 = 168.0; // 7 days

/// Failure count that drives confidence to near-zero
const MAX_FAILURE_COUNT: f64 = 5.0;

/// Minimum confidence to consider an entity "accessible"
const ACCESSIBLE_THRESHOLD: f64 = 0.3;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct WorldEntity {
    pub name: String,
    pub entity_type: String,     // "api" | "website" | "tool" | "document" | "contact" | "service"
    pub last_verified_hours_ago: f64,
    pub failure_count_24h: u32,
    pub success_count_24h: u32,
    pub typical_response_ms: f64,
    pub dependencies: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EntityConfidence {
    pub name: String,
    pub confidence: f64,       // 0-1
    pub status: String,        // "healthy" | "degraded" | "unreachable" | "unknown"
    pub hours_since_verified: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FeasibilityResult {
    pub overall_feasibility: f64,  // 0-1
    pub bottleneck: String,        // The least-confident required entity
    pub bottleneck_confidence: f64,
    pub entity_confidences: Vec<EntityConfidence>,
    pub recommendation: String,    // "proceed" | "verify_first" | "risky" | "blocked"
}

// ── Entity Confidence Decay ────────────────────────

/// Compute confidence for a single entity based on time since verification
/// and recent success/failure history.
/// Uses exponential decay with failure penalty.
#[napi]
pub fn entity_confidence_decay(entity: WorldEntity) -> EntityConfidence {
    // Time-based decay (exponential half-life)
    let time_factor = (-0.693 * entity.last_verified_hours_ago / CONFIDENCE_HALF_LIFE_HOURS).exp();

    // Failure penalty
    let failure_factor = if entity.failure_count_24h == 0 {
        1.0
    } else {
        (1.0 - entity.failure_count_24h as f64 / MAX_FAILURE_COUNT).max(0.0)
    };

    // Success bonus (partially counteracts time decay if recent successes)
    let success_bonus = if entity.success_count_24h > 0 && entity.last_verified_hours_ago < 24.0 {
        0.2 * (entity.success_count_24h as f64 / 5.0).min(1.0)
    } else {
        0.0
    };

    let confidence = (time_factor * failure_factor + success_bonus).clamp(0.0, 1.0);

    let status = if confidence > 0.7 {
        "healthy"
    } else if confidence > ACCESSIBLE_THRESHOLD {
        "degraded"
    } else if entity.failure_count_24h > 0 {
        "unreachable"
    } else {
        "unknown"
    };

    EntityConfidence {
        name: entity.name,
        confidence,
        status: status.to_string(),
        hours_since_verified: entity.last_verified_hours_ago,
    }
}

/// Batch compute confidences for multiple entities.
#[napi]
pub fn batch_entity_confidence(entities: Vec<WorldEntity>) -> Vec<EntityConfidence> {
    entities
        .into_iter()
        .map(entity_confidence_decay)
        .collect()
}

// ── Accessibility Aggregation ──────────────────────

/// Compute aggregate accessibility for a set of entities.
/// Returns the minimum confidence (weakest link in the chain).
#[napi]
pub fn accessibility_aggregate(confidences: Vec<f64>) -> f64 {
    if confidences.is_empty() {
        return 0.0;
    }
    confidences
        .iter()
        .cloned()
        .fold(f64::INFINITY, f64::min)
        .clamp(0.0, 1.0)
}

// ── Planning Feasibility Check ─────────────────────

/// Check if a planned action is feasible given the current world model state.
/// Takes the entities required by the plan and checks their accessibility.
/// Also resolves dependencies transitively.
#[napi]
pub fn feasibility_check(
    required_entities: Vec<WorldEntity>,
    all_known_entities: Vec<WorldEntity>,
) -> FeasibilityResult {
    if required_entities.is_empty() {
        return FeasibilityResult {
            overall_feasibility: 1.0,
            bottleneck: "none".to_string(),
            bottleneck_confidence: 1.0,
            entity_confidences: vec![],
            recommendation: "proceed".to_string(),
        };
    }

    // Build entity lookup map for dependency resolution
    let entity_map: HashMap<String, &WorldEntity> = all_known_entities
        .iter()
        .map(|e| (e.name.clone(), e))
        .collect();

    // Compute confidence for all required entities and their dependencies
    let mut all_confidences: Vec<EntityConfidence> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();

    fn resolve_entity(
        entity: &WorldEntity,
        entity_map: &HashMap<String, &WorldEntity>,
        visited: &mut std::collections::HashSet<String>,
        results: &mut Vec<EntityConfidence>,
    ) {
        if visited.contains(&entity.name) {
            return; // Avoid cycles
        }
        visited.insert(entity.name.clone());

        let conf = entity_confidence_decay(entity.clone());
        results.push(conf);

        // Resolve dependencies
        for dep_name in &entity.dependencies {
            if let Some(dep_entity) = entity_map.get(dep_name) {
                resolve_entity(dep_entity, entity_map, visited, results);
            } else {
                // Unknown dependency — assume low confidence
                results.push(EntityConfidence {
                    name: dep_name.clone(),
                    confidence: 0.2,
                    status: "unknown".to_string(),
                    hours_since_verified: 999.0,
                });
            }
        }
    }

    for entity in &required_entities {
        resolve_entity(entity, &entity_map, &mut visited, &mut all_confidences);
    }

    // Find bottleneck (lowest confidence)
    let mut min_conf = 1.0f64;
    let mut bottleneck = "none".to_string();

    for ec in &all_confidences {
        if ec.confidence < min_conf {
            min_conf = ec.confidence;
            bottleneck = ec.name.clone();
        }
    }

    let overall = min_conf;

    let recommendation = if overall > 0.7 {
        "proceed"
    } else if overall > 0.4 {
        "verify_first"
    } else if overall > 0.15 {
        "risky"
    } else {
        "blocked"
    };

    FeasibilityResult {
        overall_feasibility: overall,
        bottleneck,
        bottleneck_confidence: min_conf,
        entity_confidences: all_confidences,
        recommendation: recommendation.to_string(),
    }
}

/// Aggregate world model health: percentage of entities that are healthy.
#[napi]
pub fn world_model_health(entities: Vec<WorldEntity>) -> f64 {
    if entities.is_empty() {
        return 1.0;
    }

    let healthy_count = entities
        .iter()
        .filter(|e| {
            let conf = entity_confidence_decay((*e).clone());
            conf.confidence > ACCESSIBLE_THRESHOLD
        })
        .count() as f64;

    healthy_count / entities.len() as f64
}
