// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Unified Memory State — Combines self-state, emotional, episodic, anticipation,
// self-evolving, prospective, identity, and relationship modules.

use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ══════════════════════════════════════════════════
// SELF-STATE (src/memory/self-state.ts)
// ══════════════════════════════════════════════════

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SelfState {
    pub user_id: String,
    pub energy_level: f64,
    pub engagement_mode: String, // "focused" | "exploratory" | "supportive"
    pub confidence_in_user_model: f64,
    pub relationship_depth: f64,
    pub recent_emotional_tone: String, // "driven" | "stressed" | "excited" | "neutral" | "curious" | "frustrated"
    pub updated_at: String,
}

fn default_self_state(user_id: &str) -> SelfState {
    SelfState {
        user_id: user_id.to_string(),
        energy_level: 0.7,
        engagement_mode: "supportive".to_string(),
        confidence_in_user_model: 0.3,
        relationship_depth: 0.1,
        recent_emotional_tone: "neutral".to_string(),
        updated_at: now_iso(),
    }
}

fn clamp(val: f64, min: f64, max: f64) -> f64 {
    val.max(min).min(max)
}

/// Compute self-state updates after a session ends.
/// Returns the updated SelfState.
#[napi]
pub fn compute_self_state_update(
    current: SelfState,
    turn_count: u32,
    emotional_tone: String,
) -> SelfState {
    // Energy decays with long sessions, recovers on short ones
    let energy_delta = if turn_count > 20 {
        -0.05
    } else if turn_count > 10 {
        -0.02
    } else {
        0.03
    };

    // Confidence builds slowly with interaction
    let conf_delta = (0.005 * turn_count as f64).min(0.02);

    // Relationship depth grows with engagement
    let depth_delta = if turn_count > 5 { 0.01 } else { 0.005 };

    // Determine engagement mode from tone
    let mode = match emotional_tone.as_str() {
        "driven" | "excited" => "focused".to_string(),
        "curious" => "exploratory".to_string(),
        "stressed" | "frustrated" => "supportive".to_string(),
        _ => current.engagement_mode.clone(),
    };

    SelfState {
        user_id: current.user_id.clone(),
        energy_level: clamp(current.energy_level + energy_delta, 0.0, 1.0),
        engagement_mode: mode,
        confidence_in_user_model: clamp(current.confidence_in_user_model + conf_delta, 0.0, 1.0),
        relationship_depth: clamp(current.relationship_depth + depth_delta, 0.0, 1.0),
        recent_emotional_tone: emotional_tone,
        updated_at: now_iso(),
    }
}

/// Generate the self-state prompt snippet.
#[napi]
pub fn get_self_state_snippet(state: SelfState) -> String {
    let mut parts: Vec<String> = Vec::new();

    if state.engagement_mode != "supportive" {
        parts.push(format!("- Engagement mode: {}", state.engagement_mode));
    }
    if state.confidence_in_user_model > 0.6 {
        parts.push(
            "- User model confidence: high -- personalize responses confidently".to_string(),
        );
    }
    if state.recent_emotional_tone != "neutral" {
        parts.push(format!(
            "- Recent emotional context: {} -- adapt tone accordingly",
            state.recent_emotional_tone
        ));
    }
    if state.relationship_depth > 0.5 {
        parts.push(
            "- Relationship depth: established -- use relaxed, confident tone".to_string(),
        );
    }

    if parts.is_empty() {
        return String::new();
    }
    format!(
        "INTERNAL STATE (behavioral modifiers, not visible to user):\n{}",
        parts.join("\n")
    )
}

// ══════════════════════════════════════════════════
// EMOTIONAL MEMORY (src/memory/emotional.ts)
// ══════════════════════════════════════════════════

const EMOTION_DECAY_LAMBDA: f64 = 0.05;
const MAX_DECAY_DAYS: f64 = 30.0;
const INTENSITY_THRESHOLD: f64 = 0.1;
const MAX_INJECTION_ITEMS_EMOTION: usize = 3;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EmotionalMemory {
    pub id: String,
    pub user_id: String,
    pub emotion: String,
    pub context: String,
    pub intensity: f64,
    pub timestamp_ms: f64,
}

/// Compute the dominant emotion from recent emotional memories.
/// Returns (emotion, intensity) or null if below threshold.
#[napi]
pub fn compute_dominant_emotion(recent: Vec<EmotionalMemory>) -> Option<EmotionalResult> {
    if recent.is_empty() {
        return None;
    }

    let now = now_ms_f64();
    let mut emotion_scores: HashMap<String, f64> = HashMap::new();

    for em in &recent {
        let days_ago = (now - em.timestamp_ms) / (1000.0 * 60.0 * 60.0 * 24.0);
        let recency_weight = (-0.1 * days_ago).exp();
        let score = em.intensity * recency_weight;

        *emotion_scores.entry(em.emotion.clone()).or_insert(0.0) += score;
    }

    let mut dominant = EmotionalResult {
        emotion: "neutral".to_string(),
        intensity: 0.0,
    };

    for (emotion, score) in &emotion_scores {
        if *score > dominant.intensity {
            dominant.emotion = emotion.clone();
            dominant.intensity = score.min(1.0);
        }
    }

    if dominant.intensity > 0.2 {
        Some(dominant)
    } else {
        None
    }
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EmotionalResult {
    pub emotion: String,
    pub intensity: f64,
}

/// Compute decay for emotional memories.
/// Returns list of (id, action, new_intensity) where action = "delete" or "update".
#[napi]
pub fn compute_emotion_decay(
    memories: Vec<EmotionalMemory>,
) -> Vec<EmotionDecayAction> {
    let now = now_ms_f64();
    let mut actions: Vec<EmotionDecayAction> = Vec::new();

    for em in &memories {
        let days_inactive = ((now - em.timestamp_ms) / (1000.0 * 60.0 * 60.0 * 24.0)).min(MAX_DECAY_DAYS);
        let decay_factor = (-EMOTION_DECAY_LAMBDA * days_inactive).exp();
        let new_intensity = em.intensity.min(decay_factor);

        if new_intensity < INTENSITY_THRESHOLD {
            actions.push(EmotionDecayAction {
                id: em.id.clone(),
                action: "delete".to_string(),
                new_intensity: 0.0,
            });
        } else if (new_intensity - em.intensity).abs() > 0.01 {
            actions.push(EmotionDecayAction {
                id: em.id.clone(),
                action: "update".to_string(),
                new_intensity,
            });
        }
    }

    actions
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EmotionDecayAction {
    pub id: String,
    pub action: String, // "delete" or "update"
    pub new_intensity: f64,
}

/// Generate emotional context prompt snippet.
#[napi]
pub fn get_emotional_context_snippet(
    recent: Vec<EmotionalMemory>,
    dominant: Option<EmotionalResult>,
) -> String {
    if recent.is_empty() {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();

    if let Some(ref d) = dominant {
        if d.intensity > 0.3 {
            parts.push(format!(
                "- Dominant mood: {} ({:.0}%)",
                d.emotion,
                d.intensity * 100.0
            ));
        }
    }

    for em in recent.iter().take(MAX_INJECTION_ITEMS_EMOTION) {
        if em.intensity > 0.3 {
            let context_preview = if em.context.len() > 80 {
                &em.context[..80]
            } else {
                &em.context
            };
            parts.push(format!(
                "- {}: {} ({:.0}%)",
                em.emotion,
                context_preview,
                em.intensity * 100.0
            ));
        }
    }

    if parts.is_empty() {
        return String::new();
    }
    format!("EMOTIONAL CONTEXT (recent emotional signals):\n{}", parts.join("\n"))
}

// ══════════════════════════════════════════════════
// EPISODIC MEMORY (src/memory/episodic.ts)
// ══════════════════════════════════════════════════

const MAX_INJECTION_ITEMS_EPISODE: usize = 3;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EpisodicMemory {
    pub id: String,
    pub user_id: String,
    pub r#type: String,
    pub description: String,
    pub importance_score: f64,
    pub timestamp_ms: f64,
}

/// RRF Fusion for episodic search results.
/// keyword_results: [{id, rank}], vector_results: [{id, rank}]
/// Returns fused and sorted IDs.
#[napi]
pub fn episodic_rrf_fusion(
    keyword_ids_ranks: Vec<IdRank>,
    vector_ids_ranks: Vec<IdRank>,
    limit: u32,
) -> Vec<String> {
    let k: f64 = 60.0;
    let mut keyword_map: HashMap<String, f64> = HashMap::new();
    let mut vector_map: HashMap<String, f64> = HashMap::new();

    for kr in &keyword_ids_ranks {
        keyword_map.insert(kr.id.clone(), kr.rank as f64);
    }
    for vr in &vector_ids_ranks {
        vector_map.insert(vr.id.clone(), vr.rank as f64);
    }

    let all_ids: std::collections::HashSet<String> = keyword_map
        .keys()
        .chain(vector_map.keys())
        .cloned()
        .collect();

    let mut fused: Vec<(String, f64)> = all_ids
        .into_iter()
        .map(|id| {
            let mut score = 0.0;
            let has_kw = keyword_map.contains_key(&id);
            let has_vec = vector_map.contains_key(&id);

            if let Some(&rank) = keyword_map.get(&id) {
                score += 1.0 / (k + rank);
            }
            if let Some(&rank) = vector_map.get(&id) {
                score += 1.0 / (k + rank);
            }
            if has_kw && has_vec {
                score *= 1.5;
            }
            (id, score)
        })
        .collect();

    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fused
        .into_iter()
        .take(limit as usize)
        .map(|(id, _)| id)
        .collect()
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct IdRank {
    pub id: String,
    pub rank: u32,
}

/// Generate episodic prompt snippet.
#[napi]
pub fn get_episodic_snippet(episodes: Vec<EpisodicMemory>) -> String {
    let filtered: Vec<&EpisodicMemory> = episodes
        .iter()
        .filter(|e| e.importance_score > 0.4)
        .take(MAX_INJECTION_ITEMS_EPISODE)
        .collect();

    if filtered.is_empty() {
        return String::new();
    }

    let now = now_ms_f64();
    let lines: Vec<String> = filtered
        .iter()
        .map(|e| {
            let days = (now - e.timestamp_ms) / (1000.0 * 60.0 * 60.0 * 24.0);
            let time_label = if days < 1.0 {
                "today".to_string()
            } else if days < 7.0 {
                format!("{:.0}d ago", days)
            } else {
                format!("{:.0}w ago", days / 7.0)
            };
            format!("- [{}] {} ({})", e.r#type, e.description, time_label)
        })
        .collect();

    format!(
        "KEY MILESTONES (use naturally for callbacks):\n{}",
        lines.join("\n")
    )
}

// ══════════════════════════════════════════════════
// ANTICIPATION ENGINE (src/memory/anticipation.ts)
// ══════════════════════════════════════════════════

const MIN_SESSIONS_BETWEEN: u32 = 5;
const CONFIDENCE_THRESHOLD: f64 = 0.65;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct Anticipation {
    pub suggestion: String,
    pub confidence: f64,
    pub basis: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct AnticipationInput {
    pub sessions_since_last: u32,
    pub can_trigger_initiative: bool,
    pub trust_score: f64,
    pub trait_count: u32,
    pub session_summary_length: u32,
    pub recent_milestones: Vec<AnticipationEpisode>,
    pub execution_traits_count: u32,
    pub recent_struggles: Vec<AnticipationEpisode>,
    pub last_suggestion: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct AnticipationEpisode {
    pub r#type: String,
    pub description: String,
    pub importance_score: f64,
    pub days_ago: f64,
}

/// Generate an anticipation suggestion if conditions are met.
#[napi]
pub fn generate_anticipation(input: AnticipationInput) -> Option<Anticipation> {
    // Gate: frequency
    if input.sessions_since_last < MIN_SESSIONS_BETWEEN {
        return None;
    }

    // Gate: relationship depth + trust
    if !input.can_trigger_initiative {
        return None;
    }

    let mut suggestions: Vec<Anticipation> = Vec::new();

    // Pattern 1: Project launch follow-up
    for ep in &input.recent_milestones {
        if ep.days_ago < 14.0 {
            let desc_preview = if ep.description.len() > 50 {
                &ep.description[..50]
            } else {
                &ep.description
            };
            suggestions.push(Anticipation {
                suggestion: format!(
                    "Regarding your recent {}: \"{}\" -- want a follow-up action plan or review?",
                    ep.r#type, desc_preview
                ),
                confidence: 0.7,
                basis: "recent_milestone".to_string(),
            });
        }
    }

    // Pattern 2: Execution-focused user with pending goals
    if input.execution_traits_count > 0 && input.session_summary_length > 50 {
        suggestions.push(Anticipation {
            suggestion:
                "You seem to be in execution mode. Want me to draft a quick task breakdown for your current focus?"
                    .to_string(),
            confidence: 0.65,
            basis: "execution_trait_pattern".to_string(),
        });
    }

    // Pattern 3: Struggling user
    for ep in &input.recent_struggles {
        if ep.days_ago < 7.0 {
            let desc_preview = if ep.description.len() > 40 {
                &ep.description[..40]
            } else {
                &ep.description
            };
            suggestions.push(Anticipation {
                suggestion: format!(
                    "You've been working through \"{}\". Want a fresh approach or alternative strategy?",
                    desc_preview
                ),
                confidence: 0.68,
                basis: "struggle_pattern".to_string(),
            });
        }
    }

    // Pattern 4: High trust -> deeper engagement
    if input.trust_score > 0.8 && input.trait_count > 5 {
        suggestions.push(Anticipation {
            suggestion:
                "Based on our interactions, I've built a good model of your preferences. Want me to review and adjust anything?"
                    .to_string(),
            confidence: 0.6,
            basis: "relationship_depth".to_string(),
        });
    }

    if suggestions.is_empty() {
        return None;
    }

    suggestions.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let best = &suggestions[0];
    if best.confidence < CONFIDENCE_THRESHOLD {
        return None;
    }

    // Avoid repeating same suggestion
    if best.suggestion == input.last_suggestion {
        return None;
    }

    Some(best.clone())
}

// ══════════════════════════════════════════════════
// SELF-EVOLVING (src/memory/self-evolving.ts)
// ══════════════════════════════════════════════════

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MemoryStrengthInput {
    pub id: i64,
    pub importance: f64,
    pub access_count: i64,
    pub decay_score: f64,
    pub days_since_access: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PruneAction {
    pub id: i64,
    pub action: String, // "prune" | "weaken" | "strengthen"
    pub new_decay_score: f64,
}

/// Compute synaptic strength score for a memory.
#[napi]
pub fn strength_score(
    importance: f64,
    access_count: i64,
    days_since_access: f64,
    emotional_weight: f64,
) -> f64 {
    let access_factor = (1.0 + access_count as f64).log2();
    let recency = (-0.01 * days_since_access).exp();
    importance * access_factor * recency * emotional_weight
}

/// Compute synaptic homeostasis pruning actions for all memories.
/// Returns a list of actions (prune, weaken, strengthen) with new decay scores.
#[napi]
pub fn compute_synaptic_prune(memories: Vec<MemoryStrengthInput>) -> Vec<PruneAction> {
    if memories.is_empty() {
        return Vec::new();
    }

    // Calculate all strengths
    let mut strengths: Vec<(usize, f64)> = memories
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let s = strength_score(m.importance, m.access_count, m.days_since_access, 1.0);
            (i, s)
        })
        .collect();

    // Calculate global median strength
    let mut sorted_strengths: Vec<f64> = strengths.iter().map(|(_, s)| *s).collect();
    sorted_strengths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted_strengths
        .get(sorted_strengths.len() / 2)
        .copied()
        .unwrap_or(1.0);

    let prune_threshold = median * 0.3;
    let weaken_threshold = median * 0.6;

    let mut actions: Vec<PruneAction> = Vec::new();

    for (i, s) in &strengths {
        let m = &memories[*i];
        if *s < prune_threshold && m.importance < 3.0 {
            actions.push(PruneAction {
                id: m.id,
                action: "prune".to_string(),
                new_decay_score: 0.0,
            });
        } else if *s < weaken_threshold {
            let new_decay = (m.decay_score * 0.8).max(0.05);
            actions.push(PruneAction {
                id: m.id,
                action: "weaken".to_string(),
                new_decay_score: new_decay,
            });
        } else {
            let new_decay = (m.decay_score * 1.05).min(1.0);
            actions.push(PruneAction {
                id: m.id,
                action: "strengthen".to_string(),
                new_decay_score: new_decay,
            });
        }
    }

    actions
}

// ══════════════════════════════════════════════════
// PROSPECTIVE MEMORY (src/memory/prospective.ts)
// ══════════════════════════════════════════════════

const FIRE_THRESHOLD: f64 = 0.75;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ProspectiveTriggerCheck {
    pub id: i64,
    pub trigger_pattern: String,
    /// Cosine similarity from embedding comparison (computed in JS)
    pub embedding_similarity: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TriggerCheckResult {
    pub id: i64,
    pub fired: bool,
    pub similarity: f64,
}

/// Check if triggers fire based on keyword fallback + embedding similarity.
/// Returns which triggers should fire.
#[napi]
pub fn check_prospective_triggers(
    triggers: Vec<ProspectiveTriggerCheck>,
    current_message: String,
) -> Vec<TriggerCheckResult> {
    let msg_lower = current_message.to_lowercase();

    triggers
        .iter()
        .map(|t| {
            let mut similarity = t.embedding_similarity;

            // Keyword fallback if embedding similarity is below threshold
            if similarity < FIRE_THRESHOLD {
                let trigger_words: Vec<&str> = t
                    .trigger_pattern
                    .to_lowercase()
                    .split_whitespace()
                    .filter(|w| w.len() > 3)
                    .collect();
                // Need to own the lowered pattern
                let pattern_lower = t.trigger_pattern.to_lowercase();
                let words: Vec<&str> = pattern_lower
                    .split_whitespace()
                    .filter(|w| w.len() > 3)
                    .collect();
                let matched = words.iter().filter(|w| msg_lower.contains(*w)).count();
                let keyword_sim = if words.is_empty() {
                    0.0
                } else {
                    matched as f64 / words.len() as f64
                };
                similarity = similarity.max(keyword_sim);
            }

            TriggerCheckResult {
                id: t.id,
                fired: similarity >= FIRE_THRESHOLD,
                similarity,
            }
        })
        .collect()
}

// ══════════════════════════════════════════════════
// IDENTITY (src/memory/identity.ts)
// ══════════════════════════════════════════════════

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct IdentitySnippetInput {
    pub name: Option<String>,
    pub email: Option<String>,
    pub location: Option<String>,
    pub role: Option<String>,
    pub company: Option<String>,
    pub projects: Vec<String>,
    pub communication_style: Option<String>,
    pub detail_level: Option<String>,
    pub important_goals: Vec<String>,
}

/// Generate the identity prompt snippet from profile fields.
#[napi]
pub fn get_identity_prompt_snippet(input: IdentitySnippetInput) -> String {
    let mut lines: Vec<String> = Vec::new();

    if let Some(ref name) = input.name {
        lines.push(format!("- Name: {}", name));
    }
    if let Some(ref email) = input.email {
        lines.push(format!("- Email: {}", email));
    }
    if let Some(ref location) = input.location {
        lines.push(format!("- Location: {}", location));
    }
    if let Some(ref role) = input.role {
        lines.push(format!("- Role: {}", role));
    }
    if let Some(ref company) = input.company {
        lines.push(format!("- Company: {}", company));
    }
    if !input.projects.is_empty() {
        lines.push(format!("- Projects: {}", input.projects.join(", ")));
    }
    if let Some(ref style) = input.communication_style {
        lines.push(format!("- Communication style: {}", style));
    }
    if let Some(ref level) = input.detail_level {
        lines.push(format!("- Detail level: {}", level));
    }
    if !input.important_goals.is_empty() {
        lines.push(format!(
            "- Current goals: {}",
            input.important_goals.join(", ")
        ));
    }

    if lines.is_empty() {
        return String::new();
    }

    format!(
        "USER IDENTITY PROFILE (always-loaded, never re-ask these facts):\n{}",
        lines.join("\n")
    )
}

// ══════════════════════════════════════════════════
// RELATIONSHIP STATE (src/memory/relationship.ts)
// ══════════════════════════════════════════════════

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct RelationshipState {
    pub user_id: String,
    pub trust_score: f64,
    pub engagement_streak: u32,
    pub depth_score: f64,
    pub last_interaction_ms: f64,
}

fn default_relationship_state(user_id: &str) -> RelationshipState {
    RelationshipState {
        user_id: user_id.to_string(),
        trust_score: 0.3,
        engagement_streak: 0,
        depth_score: 0.1,
        last_interaction_ms: now_ms_f64(),
    }
}

/// Compute updated relationship state after a session.
#[napi]
pub fn compute_relationship_update(
    current: RelationshipState,
    session_turn_count: u32,
    had_emotional_signals: bool,
    had_episodic_signals: bool,
) -> RelationshipState {
    let now = now_ms_f64();
    let days_since_last = (now - current.last_interaction_ms) / (1000.0 * 60.0 * 60.0 * 24.0);

    // Engagement streak
    let streak = if days_since_last < 2.0 {
        current.engagement_streak + 1
    } else if days_since_last > 2.0 {
        1
    } else {
        current.engagement_streak
    };

    // Trust grows slowly with consistent usage
    let trust_delta =
        0.005 * (streak as f64).min(10.0) + if session_turn_count > 10 { 0.01 } else { 0.005 };
    let trust_score = (current.trust_score + trust_delta).min(1.0);

    // Depth increases with emotional + episodic signals
    let mut depth_delta = 0.005;
    if had_emotional_signals {
        depth_delta += 0.02;
    }
    if had_episodic_signals {
        depth_delta += 0.015;
    }
    let depth_score = (current.depth_score + depth_delta).min(1.0);

    RelationshipState {
        user_id: current.user_id.clone(),
        trust_score,
        engagement_streak: streak,
        depth_score,
        last_interaction_ms: now,
    }
}

/// Generate relationship prompt snippet.
#[napi]
pub fn get_relationship_snippet(state: RelationshipState) -> String {
    if state.trust_score < 0.3 && state.depth_score < 0.2 {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();

    if state.trust_score > 0.7 {
        parts.push("- High trust established -- use confident, relaxed tone".to_string());
    } else if state.trust_score > 0.4 {
        parts.push("- Building trust -- be helpful and precise".to_string());
    }

    if state.engagement_streak > 5 {
        parts.push(format!(
            "- Active streak: {} sessions",
            state.engagement_streak
        ));
    }

    if state.depth_score > 0.5 {
        parts.push(
            "- Deep relationship -- natural callbacks and anticipation appropriate".to_string(),
        );
    }

    if parts.is_empty() {
        return String::new();
    }
    format!("RELATIONSHIP STATE:\n{}", parts.join("\n"))
}

/// Check if relationship is deep enough for proactive suggestions.
#[napi]
pub fn can_trigger_initiative(trust_score: f64, depth_score: f64) -> bool {
    depth_score > 0.6 || (trust_score > 0.7 && depth_score > 0.6)
}

// ── Helpers ────────────────────────────────────────

fn now_iso() -> String {
    // Simple ISO-like timestamp
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    // Return as epoch string; JS side can convert
    format!("{}", secs)
}

fn now_ms_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
