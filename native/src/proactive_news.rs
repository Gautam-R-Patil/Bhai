// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Proactive V3 — news headline relevance scoring via cosine similarity.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ScoredHeadline {
    pub title: String,
    pub score: f64,
    pub index: u32,
}

// Plain Rust cosine for f64 vectors — avoids type-conversion churn with the
// SIMD variant in vector.rs which takes f32 slices. For 384-dim at 3-10
// headlines, the perf difference is negligible.
fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..a.len().min(b.len()) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 { return 0.0; }
    dot / (na.sqrt() * nb.sqrt())
}

#[napi]
pub fn news_score_headlines(
    headlines: Vec<String>,
    interest_embedding: Vec<f64>,
    headline_embeddings: Vec<Vec<f64>>,
) -> Vec<ScoredHeadline> {
    if headlines.len() != headline_embeddings.len() {
        return vec![];
    }
    let empty_interest = interest_embedding.iter().all(|&x| x == 0.0);

    let mut scored: Vec<ScoredHeadline> = headlines
        .into_iter()
        .enumerate()
        .zip(headline_embeddings.iter())
        .map(|((i, title), emb)| {
            let score = if empty_interest { 0.0 } else { cosine(&interest_embedding, emb) };
            ScoredHeadline { title, score, index: i as u32 }
        })
        .collect();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(10);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(i: usize, dim: usize) -> Vec<f64> {
        let mut v = vec![0.0; dim];
        v[i] = 1.0;
        v
    }

    #[test]
    fn sorts_by_cosine_desc() {
        let interest = unit(0, 16);
        let headlines = vec!["aligned".to_string(), "orthogonal".to_string()];
        let embeddings = vec![unit(0, 16), unit(1, 16)];
        let r = news_score_headlines(headlines, interest, embeddings);
        assert_eq!(r[0].title, "aligned");
        assert!(r[0].score > r[1].score);
    }

    #[test]
    fn empty_interest_returns_zero_scores_preserves_order() {
        let interest = vec![0.0; 16];
        let headlines = vec!["a".to_string(), "b".to_string()];
        let embeddings = vec![unit(0, 16), unit(1, 16)];
        let r = news_score_headlines(headlines, interest, embeddings);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].score, 0.0);
        assert_eq!(r[1].score, 0.0);
    }

    #[test]
    fn length_mismatch_returns_empty() {
        let interest = unit(0, 16);
        let headlines = vec!["a".to_string(), "b".to_string()];
        let embeddings = vec![unit(0, 16)];
        let r = news_score_headlines(headlines, interest, embeddings);
        assert!(r.is_empty());
    }

    #[test]
    fn top_10_cutoff() {
        let interest = unit(0, 16);
        let headlines: Vec<String> = (0..15).map(|i| format!("h{}", i)).collect();
        let embeddings: Vec<Vec<f64>> = (0..15).map(|i| unit(i % 16, 16)).collect();
        let r = news_score_headlines(headlines, interest, embeddings);
        assert_eq!(r.len(), 10);
    }
}
