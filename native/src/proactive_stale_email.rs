// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Proactive V3 — stale-email scoring for inbox draft candidates.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EmailSummary {
    pub id: String,
    pub from: String,
    pub subject: String,
    pub received_ms: f64,
    pub is_important: bool,
    pub thread_msg_count: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct StaleEmailCandidate {
    pub id: String,
    pub from: String,
    pub subject: String,
    pub days_stale: u32,
    pub score: f64,
}

#[napi]
pub fn stale_email_score(
    emails: Vec<EmailSummary>,
    user_engaged_senders: Vec<String>,
    now_ms: f64,
) -> Vec<StaleEmailCandidate> {
    let engaged: HashSet<String> = user_engaged_senders.into_iter().collect();
    let mut scored: Vec<StaleEmailCandidate> = emails
        .into_iter()
        .map(|e| {
            let days = ((now_ms - e.received_ms) / 86_400_000.0).max(0.0) as u32;
            let importance = if e.is_important { 2.0 } else { 1.0 };
            let engaged_boost = if engaged.contains(&e.from) { 1.5 } else { 1.0 };
            let age_weight = ((days as f64) / 7.0).min(2.0);
            let score = importance * engaged_boost * age_weight;
            StaleEmailCandidate {
                id: e.id,
                from: e.from,
                subject: e.subject,
                days_stale: days,
                score,
            }
        })
        .collect();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(3);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn em(id: &str, from: &str, important: bool, age_days: f64, now: f64) -> EmailSummary {
        EmailSummary {
            id: id.into(),
            from: from.into(),
            subject: format!("subject {}", id),
            received_ms: now - age_days * 86_400_000.0,
            is_important: important,
            thread_msg_count: 1,
        }
    }

    #[test]
    fn important_scores_higher_than_unimportant() {
        let now = 1_000_000.0 * 86_400.0;
        let a = em("imp", "x@x.com", true, 3.0, now);
        let b = em("non", "y@y.com", false, 3.0, now);
        let r = stale_email_score(vec![a, b], vec![], now);
        assert_eq!(r[0].id, "imp");
    }

    #[test]
    fn engaged_sender_boost_1_5x() {
        let now = 1_000_000.0 * 86_400.0;
        let a = em("eng", "friend@x.com", false, 3.0, now);
        let b = em("cold", "stranger@x.com", false, 3.0, now);
        let r = stale_email_score(vec![a, b], vec!["friend@x.com".into()], now);
        assert_eq!(r[0].id, "eng");
        assert!((r[0].score / r[1].score - 1.5).abs() < 0.01);
    }

    #[test]
    fn top_3_cutoff() {
        let now = 1_000_000.0 * 86_400.0;
        let emails: Vec<EmailSummary> = (0..10)
            .map(|i| em(&format!("e{}", i), "x@x.com", false, 3.0 + i as f64, now))
            .collect();
        let r = stale_email_score(emails, vec![], now);
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn score_sorted_desc() {
        let now = 1_000_000.0 * 86_400.0;
        let emails = vec![
            em("a", "x@x.com", false, 5.0, now),
            em("b", "x@x.com", false, 3.0, now),
            em("c", "x@x.com", false, 7.0, now),
        ];
        let r = stale_email_score(emails, vec![], now);
        assert_eq!(r[0].id, "c");
        assert_eq!(r[1].id, "a");
        assert_eq!(r[2].id, "b");
    }
}
