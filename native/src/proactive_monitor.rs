// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Proactive Monitor — Rust-side latent-topic matcher.
// Called on every inbound message across every channel. Read-heavy: uses
// RwLock. Cosine is naive (f64, 384-d) — fast enough even at 100 rules.
// See docs/superpowers/specs/2026-04-21-proactiveness-overhaul-design.md

use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MonitorRuleRust {
    pub id: String,
    pub topic_embedding: Vec<f64>,
    pub scope_channels: Vec<String>,
    pub scope_senders: Option<Vec<String>>,
    pub exclude_self: bool,
    pub threshold: f64,
    pub cooldown_minutes: f64,
    pub active: bool,
    pub last_fired_at: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct RuleHit {
    pub rule_id: String,
    pub score: f64,
}

static RULES: Lazy<Arc<RwLock<HashMap<String, MonitorRuleRust>>>> =
    Lazy::new(|| Arc::new(RwLock::new(HashMap::new())));

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for i in 0..a.len().min(b.len()) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

#[napi]
pub fn monitor_load_rules(rules: Vec<MonitorRuleRust>) {
    let mut st = RULES.write();
    st.clear();
    for r in rules {
        st.insert(r.id.clone(), r);
    }
}

#[napi]
pub fn monitor_upsert_rule(rule: MonitorRuleRust) {
    let mut st = RULES.write();
    st.insert(rule.id.clone(), rule);
}

#[napi]
pub fn monitor_delete_rule(id: String) {
    let mut st = RULES.write();
    st.remove(&id);
}

#[napi]
pub fn monitor_count() -> u32 {
    let st = RULES.read();
    st.len() as u32
}

#[napi]
pub fn monitor_check(
    msg_embedding: Vec<f64>,
    channel: String,
    sender: String,
    now_ms: f64,
) -> Vec<RuleHit> {
    let st = RULES.read();
    let mut hits: Vec<RuleHit> = Vec::new();
    for r in st.values() {
        if !r.active {
            continue;
        }
        if !r.scope_channels.iter().any(|c| c == "*" || c == &channel) {
            continue;
        }
        if let Some(senders) = &r.scope_senders {
            if !senders.iter().any(|s| s == &sender) {
                continue;
            }
        }
        if r.exclude_self && sender == "self" {
            continue;
        }
        // last_fired_at == 0.0 sentinel means "never fired" — skip cooldown check.
        if r.last_fired_at > 0.0 {
            let cooldown_ms = r.cooldown_minutes * 60_000.0;
            if now_ms - r.last_fired_at < cooldown_ms {
                continue;
            }
        }
        let score = cosine(&msg_embedding, &r.topic_embedding);
        if score > r.threshold {
            hits.push(RuleHit {
                rule_id: r.id.clone(),
                score,
            });
        }
    }
    hits
}

#[napi]
pub fn monitor_mark_fired(id: String, ts_ms: f64) {
    let mut st = RULES.write();
    if let Some(r) = st.get_mut(&id) {
        r.last_fired_at = ts_ms;
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() {
        let mut st = RULES.write();
        st.clear();
    }

    fn mk(id: &str, embedding: Vec<f64>, scope: Vec<&str>) -> MonitorRuleRust {
        MonitorRuleRust {
            id: id.into(),
            topic_embedding: embedding,
            scope_channels: scope.iter().map(|s| s.to_string()).collect(),
            scope_senders: None,
            exclude_self: true,
            threshold: 0.5,
            cooldown_minutes: 0.0,
            active: true,
            last_fired_at: 0.0,
        }
    }

    #[test]
    fn matches_above_threshold() {
        fresh();
        let r = mk("r1", vec![1.0, 0.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r]);
        let hits = monitor_check(
            vec![0.9, 0.1, 0.0],
            "whatsapp".into(),
            "alice".into(),
            1000.0,
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule_id, "r1");
        assert!(hits[0].score > 0.9);
    }

    #[test]
    fn ignores_below_threshold() {
        fresh();
        let r = mk("r1", vec![1.0, 0.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r]);
        let hits = monitor_check(
            vec![0.0, 1.0, 0.0],
            "whatsapp".into(),
            "alice".into(),
            1000.0,
        );
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn channel_scope_is_honored() {
        fresh();
        let r = mk("tg_only", vec![1.0, 0.0], vec!["telegram"]);
        monitor_load_rules(vec![r]);
        let on_wa = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(on_wa.len(), 0);
        let on_tg = monitor_check(vec![1.0, 0.0], "telegram".into(), "alice".into(), 1000.0);
        assert_eq!(on_tg.len(), 1);
    }

    #[test]
    fn wildcard_channel_matches_everything() {
        fresh();
        let r = mk("anywhere", vec![1.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r]);
        for ch in ["whatsapp", "telegram", "discord", "slack"] {
            let hits = monitor_check(vec![1.0, 0.0], ch.into(), "alice".into(), 1000.0);
            assert_eq!(hits.len(), 1, "wildcard should match {ch}");
        }
    }

    #[test]
    fn cooldown_suppresses() {
        fresh();
        let mut r = mk("r_cool", vec![1.0, 0.0], vec!["*"]);
        r.cooldown_minutes = 60.0;
        r.last_fired_at = 1000.0;
        monitor_load_rules(vec![r]);
        // Only 500ms elapsed since last fire — still in cooldown (60 min)
        let hits = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 1500.0);
        assert_eq!(hits.len(), 0);
        // After 61 minutes — cooldown passed
        let hits2 = monitor_check(
            vec![1.0, 0.0],
            "whatsapp".into(),
            "alice".into(),
            1000.0 + 61.0 * 60_000.0,
        );
        assert_eq!(hits2.len(), 1);
    }

    #[test]
    fn sender_allowlist_is_honored() {
        fresh();
        let mut r = mk("only_bob", vec![1.0, 0.0], vec!["*"]);
        r.scope_senders = Some(vec!["bob".into()]);
        monitor_load_rules(vec![r]);
        let from_alice = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(from_alice.len(), 0);
        let from_bob = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "bob".into(), 1000.0);
        assert_eq!(from_bob.len(), 1);
    }

    #[test]
    fn exclude_self_skips_self_sender() {
        fresh();
        let r = mk("anywhere", vec![1.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r]); // exclude_self defaults to true in mk()
        let hits = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "self".into(), 1000.0);
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn inactive_rules_are_skipped() {
        fresh();
        let mut r = mk("paused", vec![1.0, 0.0], vec!["*"]);
        r.active = false;
        monitor_load_rules(vec![r]);
        let hits = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn mark_fired_updates_last_fired_at() {
        fresh();
        let mut r = mk("r_fire", vec![1.0, 0.0], vec!["*"]);
        r.cooldown_minutes = 60.0;
        monitor_load_rules(vec![r]);
        // First fire: no prior
        let hits1 = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(hits1.len(), 1);
        monitor_mark_fired("r_fire".into(), 1000.0);
        // Immediate re-check: cooldown blocks
        let hits2 = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 2000.0);
        assert_eq!(hits2.len(), 0);
    }

    #[test]
    fn upsert_replaces_existing() {
        fresh();
        let r1 = mk("r_up", vec![1.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r1]);
        assert_eq!(monitor_count(), 1);
        let mut r2 = mk("r_up", vec![0.0, 1.0], vec!["*"]);
        r2.threshold = 0.9;
        monitor_upsert_rule(r2);
        assert_eq!(monitor_count(), 1);
        // New embedding now controls matching
        let should_miss = monitor_check(vec![1.0, 0.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(should_miss.len(), 0);
        let should_hit = monitor_check(vec![0.0, 1.0], "whatsapp".into(), "alice".into(), 1000.0);
        assert_eq!(should_hit.len(), 1);
    }

    #[test]
    fn delete_removes() {
        fresh();
        let r = mk("r_del", vec![1.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r]);
        assert_eq!(monitor_count(), 1);
        monitor_delete_rule("r_del".into());
        assert_eq!(monitor_count(), 0);
    }

    #[test]
    fn zero_embedding_never_matches() {
        fresh();
        let r = mk("r", vec![1.0, 0.0, 0.0], vec!["*"]);
        monitor_load_rules(vec![r]);
        let hits = monitor_check(
            vec![0.0, 0.0, 0.0],
            "whatsapp".into(),
            "alice".into(),
            1000.0,
        );
        assert_eq!(hits.len(), 0);
    }
}
