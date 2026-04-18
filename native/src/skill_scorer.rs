// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Skill Scorer — SAGE-style skill relevance scoring per agent turn.
// Ranks skills by relevance to current task for dynamic injection.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SkillCandidate {
    pub slug: String,
    pub name: String,
    pub triggers: Vec<String>,
    pub description: String,
    pub use_count: u32,
    pub success_rate: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SkillRanking {
    pub slug: String,
    pub relevance_score: f64,
    pub trigger_match: bool,
    pub description_match: f64,
}

// ── Scoring ────────────────────────────────────────

/// Score and rank skills by relevance to the current task.
/// Uses keyword matching + trigger matching + historical success.
#[napi]
pub fn rank_skills(
    candidates: Vec<SkillCandidate>,
    task_keywords: Vec<String>,
    task_text: String,
) -> Vec<SkillRanking> {
    let task_lower = task_text.to_lowercase();
    let keywords: Vec<String> = task_keywords.iter().map(|k| k.to_lowercase()).collect();

    let mut rankings: Vec<SkillRanking> = candidates.iter().map(|skill| {
        // Trigger matching
        let trigger_match = skill.triggers.iter().any(|t| {
            let t_lower = t.to_lowercase();
            task_lower.contains(&t_lower) || keywords.iter().any(|k| t_lower.contains(k))
        });

        // Description keyword overlap
        let desc_lower = skill.description.to_lowercase();
        let desc_words: std::collections::HashSet<&str> = desc_lower.split_whitespace()
            .filter(|w| w.len() > 3).collect();
        let task_words: std::collections::HashSet<&str> = task_lower.split_whitespace()
            .filter(|w| w.len() > 3).collect();

        let overlap = desc_words.intersection(&task_words).count() as f64;
        let union = desc_words.union(&task_words).count().max(1) as f64;
        let description_match = overlap / union;

        // Composite score
        let trigger_bonus = if trigger_match { 0.5 } else { 0.0 };
        let success_bonus = skill.success_rate * 0.1;
        let usage_bonus = (skill.use_count as f64 / 20.0).min(0.1);

        let relevance = (description_match * 0.4 + trigger_bonus + success_bonus + usage_bonus)
            .clamp(0.0, 1.0);

        SkillRanking {
            slug: skill.slug.clone(),
            relevance_score: relevance,
            trigger_match,
            description_match,
        }
    }).collect();

    rankings.sort_by(|a, b| b.relevance_score.partial_cmp(&a.relevance_score)
        .unwrap_or(std::cmp::Ordering::Equal));
    rankings
}
