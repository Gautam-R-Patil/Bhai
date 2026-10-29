// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Deep Research v2 — Rust-compiled IP: scoring, dedup, cross-reference, domain ranking

use std::collections::{HashMap, HashSet};

use lazy_static::lazy_static;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── Domain Quality Scoring (IP) ──────────────

lazy_static! {
    static ref HIGH_QUALITY: HashSet<&'static str> = {
        let mut s = HashSet::new();
        for d in &[
            "arxiv.org",
            "nature.com",
            "science.org",
            "ieee.org",
            "acm.org",
            "sciencedirect.com",
            "springer.com",
            "wiley.com",
            "pubmed.ncbi.nlm.nih.gov",
            "pnas.org",
            "cell.com",
            "bmj.com",
            "thelancet.com",
            "jamanetwork.com",
        ] {
            s.insert(*d);
        }
        s
    };
    static ref GOOD_QUALITY: HashSet<&'static str> = {
        let mut s = HashSet::new();
        for d in &[
            "github.com",
            "stackoverflow.com",
            "docs.google.com",
            "developer.mozilla.org",
            "microsoft.com",
            "apple.com",
            "cloud.google.com",
            "aws.amazon.com",
        ] {
            s.insert(*d);
        }
        s
    };
    static ref MEDIUM_QUALITY: HashSet<&'static str> = {
        let mut s = HashSet::new();
        for d in &[
            "medium.com",
            "dev.to",
            "hackernews.com",
            "news.ycombinator.com",
            "towardsdatascience.com",
            "blog.google",
            "openai.com",
            "anthropic.com",
        ] {
            s.insert(*d);
        }
        s
    };
}

fn extract_domain(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_lowercase()
}

#[napi]
pub fn score_domain_quality(url: String) -> f64 {
    let domain = extract_domain(&url);
    if domain.ends_with(".edu") || domain.ends_with(".gov") {
        return 0.9;
    }
    if HIGH_QUALITY
        .iter()
        .any(|d| domain == *d || domain.ends_with(d))
    {
        return 0.85;
    }
    if domain.contains("wikipedia.org") {
        return 0.6;
    }
    if GOOD_QUALITY
        .iter()
        .any(|d| domain == *d || domain.ends_with(d))
    {
        return 0.7;
    }
    if MEDIUM_QUALITY
        .iter()
        .any(|d| domain == *d || domain.ends_with(d))
    {
        return 0.5;
    }
    0.3
}

// ── Source Ranking (IP) ──────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceScore {
    pub url: String,
    pub domain_score: f64,
    pub content_depth: f64,
    pub finding_density: f64,
    pub recency_score: f64,
    pub citation_score: f64,
    pub final_score: f64,
}

#[napi]
pub fn rank_source(
    url: String,
    content_length: u32,
    finding_count: u32,
    citation_count: u32,
    has_recent_year: bool,
) -> SourceScore {
    let domain_score = score_domain_quality(url.clone());
    let content_depth = f64::min(1.0, content_length as f64 / 30000.0);
    let finding_density = if content_length > 0 {
        f64::min(
            1.0,
            (finding_count as f64 / (content_length as f64 / 1000.0)) * 0.5,
        )
    } else {
        0.0
    };
    let recency_score = if has_recent_year { 0.8 } else { 0.3 };
    let citation_score = f64::min(1.0, citation_count as f64 / 100.0);

    let final_score = domain_score * 0.30
        + content_depth * 0.20
        + finding_density * 0.25
        + recency_score * 0.15
        + citation_score * 0.10;

    SourceScore {
        url,
        domain_score,
        content_depth,
        finding_density,
        recency_score,
        citation_score,
        final_score,
    }
}

#[napi]
pub fn rank_sources_batch(sources_json: String) -> String {
    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct InputSource {
        url: String,
        content_length: u32,
        finding_count: u32,
        citation_count: Option<u32>,
        has_recent_year: Option<bool>,
    }

    let sources: Vec<InputSource> = serde_json::from_str(&sources_json).unwrap_or_default();
    let mut scored: Vec<SourceScore> = sources
        .iter()
        .map(|s| {
            rank_source(
                s.url.clone(),
                s.content_length,
                s.finding_count,
                s.citation_count.unwrap_or(0),
                s.has_recent_year.unwrap_or(false),
            )
        })
        .collect();

    scored.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    serde_json::to_string(&scored).unwrap_or_default()
}

// ── Finding Deduplication (IP) ───────────────

fn get_words(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .filter(|w| w.len() > 2)
        .map(|w| w.to_string())
        .collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let intersection = a.iter().filter(|w| b.contains(*w)).count();
    let union = a.len() + b.len() - intersection;
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

#[napi]
pub fn deduplicate_findings(findings: Vec<String>) -> Vec<String> {
    if findings.len() <= 1 {
        return findings;
    }

    let word_sets: Vec<HashSet<String>> = findings.iter().map(|f| get_words(f)).collect();
    let mut keep = vec![true; findings.len()];

    for i in 0..findings.len() {
        if !keep[i] {
            continue;
        }
        for j in (i + 1)..findings.len() {
            if !keep[j] {
                continue;
            }
            if jaccard(&word_sets[i], &word_sets[j]) > 0.6 {
                if findings[i].len() >= findings[j].len() {
                    keep[j] = false;
                } else {
                    keep[i] = false;
                    break;
                }
            }
        }
    }

    findings
        .into_iter()
        .enumerate()
        .filter(|(i, _)| keep[*i])
        .map(|(_, f)| f)
        .collect()
}

// ── Cross-Reference Confidence (IP) ──────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindingConfidence {
    pub text: String,
    pub confidence: String,
    pub supporting_count: u32,
}

#[napi]
pub fn cross_reference_findings(findings_json: String, sources_findings_json: String) -> String {
    #[derive(Deserialize)]
    struct Finding {
        text: String,
        source_url: String,
    }
    #[derive(Deserialize)]
    struct SourceFindings {
        url: String,
        findings_text: String,
    }

    let findings: Vec<Finding> = serde_json::from_str(&findings_json).unwrap_or_default();
    let sources: Vec<SourceFindings> =
        serde_json::from_str(&sources_findings_json).unwrap_or_default();

    let source_words: Vec<(String, HashSet<String>)> = sources
        .iter()
        .map(|s| (s.url.clone(), get_words(&s.findings_text)))
        .collect();

    let results: Vec<FindingConfidence> = findings
        .iter()
        .map(|f| {
            let words = get_words(&f.text);
            let mut supporting = 0u32;
            for (url, sw) in &source_words {
                if *url == f.source_url {
                    continue;
                }
                if jaccard(&words, sw) > 0.3 {
                    supporting += 1;
                }
            }

            let confidence = if supporting >= 2 {
                "strong"
            } else if supporting == 1 {
                "moderate"
            } else {
                "weak"
            };
            FindingConfidence {
                text: f.text.clone(),
                confidence: confidence.to_string(),
                supporting_count: supporting,
            }
        })
        .collect();

    serde_json::to_string(&results).unwrap_or_default()
}

// ── Outbound Link Ranking (IP) ───────────────

#[napi]
pub fn rank_outbound_links(
    links: Vec<String>,
    visited_urls: Vec<String>,
    max_links: u32,
) -> Vec<String> {
    let visited: HashSet<&str> = visited_urls.iter().map(|u| u.as_str()).collect();

    let mut scored: Vec<(String, f64)> = links
        .into_iter()
        .filter(|url| !visited.contains(url.as_str()))
        .map(|url| {
            let score = score_domain_quality(url.clone());
            (url, score)
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .take(max_links as usize)
        .map(|(url, _)| url)
        .collect()
}

// ── Adaptive Rate Limiter State (IP) ─────────

use parking_lot::Mutex;

struct RateLimiterState {
    delay_ms: f64,
    min_ms: f64,
    max_ms: f64,
}

lazy_static! {
    static ref RATE_LIMITER: Mutex<RateLimiterState> = Mutex::new(RateLimiterState {
        delay_ms: 500.0,
        min_ms: 300.0,
        max_ms: 3000.0,
    });
}

#[napi]
pub fn rate_limiter_on_success() -> f64 {
    let mut state = RATE_LIMITER.lock();
    state.delay_ms = f64::max(state.min_ms, state.delay_ms * 0.8);
    state.delay_ms
}

#[napi]
pub fn rate_limiter_on_rate_limit() -> f64 {
    let mut state = RATE_LIMITER.lock();
    state.delay_ms = f64::min(state.max_ms, state.delay_ms * 2.0);
    state.delay_ms
}

#[napi]
pub fn rate_limiter_get_delay() -> f64 {
    RATE_LIMITER.lock().delay_ms
}

#[napi]
pub fn rate_limiter_reset() {
    let mut state = RATE_LIMITER.lock();
    state.delay_ms = 500.0;
}
