// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Reflection Core — Full port of src/memory/reflection.ts (pipeline/scoring logic)
// LLM calls stay in JS; Rust handles transcript building, clustering, validation,
// instability detection, keyword extraction, and HMAC signing.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Constants ──────────────────────────────────────

const MAX_TRAIT_SIGNALS: usize = 5;
const HMAC_SECRET: &str = "atlas-sacdr-audit-v1";

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TranscriptMessage {
    pub role: String,
    pub content: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TraitSignal {
    pub key: String,
    pub value: String,
    pub evidence: f64,
    pub explicit: bool,
    pub topics: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct IdentityUpdate {
    pub field: String,
    pub value: String,
    pub explicit: bool,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EmotionalSignal {
    pub emotion: String,
    pub context: String,
    pub intensity: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct EpisodicSignal {
    pub r#type: String,
    pub description: String,
    pub importance: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ExtractionResult {
    pub traits: Vec<TraitSignal>,
    pub identity_updates: Vec<IdentityUpdate>,
    pub emotions: Vec<EmotionalSignal>,
    pub episodes: Vec<EpisodicSignal>,
    pub dominant_tone: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ReflectionSummary {
    pub summary: String,
    pub highlights: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SummaryCluster {
    pub summaries: Vec<String>,
    pub keywords: Vec<String>,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TraitFlip {
    pub key: String,
    pub flip_ratio: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct TraitForInstability {
    pub trait_key: String,
    pub confidence: f64,
    pub reinforcement_count: u32,
}

// ── Transcript Building ────────────────────────────

/// Build a transcript string from conversation history (last 20 messages).
#[napi]
pub fn build_transcript(history: Vec<TranscriptMessage>) -> String {
    let start = if history.len() > 20 {
        history.len() - 20
    } else {
        0
    };

    history[start..]
        .iter()
        .filter(|m| m.role == "user" || (m.role == "assistant" && !m.content.is_empty()))
        .map(|m| {
            let content_preview = if m.content.len() > 250 {
                &m.content[..250]
            } else {
                &m.content
            };
            format!("{}: {}", m.role, content_preview)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Check if conversation history contains browser/OS tool usage.
#[napi]
pub fn has_browser_or_os_tools(history: Vec<TranscriptMessage>) -> bool {
    let pattern = regex::Regex::new(r"browser_|os_click|os_type|apple_script|shell_exec")
        .unwrap_or_else(|_| regex::Regex::new(".^").unwrap()); // Never-match fallback

    history.iter().any(|m| pattern.is_match(&m.content))
}

// ── JSON Validation ────────────────────────────────

/// Parse and validate a summary JSON response from LLM.
#[napi]
pub fn validate_summary_json(text: String) -> Option<ReflectionSummary> {
    let json_match = extract_json_object(&text)?;
    let parsed: serde_json::Value = serde_json::from_str(&json_match).ok()?;

    let summary = parsed.get("summary")?.as_str()?;
    if summary.is_empty() {
        return None;
    }

    let highlights = parsed
        .get("highlights")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Some(ReflectionSummary {
        summary: summary.to_string(),
        highlights,
    })
}

/// Parse and validate an extraction JSON response from LLM.
#[napi]
pub fn validate_extraction_json(text: String) -> Option<ExtractionResult> {
    let json_match = extract_json_object(&text)?;
    let parsed: serde_json::Value = serde_json::from_str(&json_match).ok()?;

    let traits_val = parsed.get("traits")?.as_array()?;
    let mut traits: Vec<TraitSignal> = Vec::new();

    for t in traits_val {
        let key = t.get("key")?.as_str()?.to_string();
        let value = t.get("value")?.as_str()?.to_string();
        if key.is_empty() || value.is_empty() {
            continue; // skip invalid, don't fail
        }
        let evidence = t
            .get("evidence")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.5);
        let explicit = t
            .get("explicit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let topics = t
            .get("topics")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        traits.push(TraitSignal {
            key,
            value,
            evidence,
            explicit,
            topics,
        });
    }

    // Optional fields
    let identity_updates = parsed
        .get("identity_updates")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|iu| {
                    let field = iu.get("field")?.as_str()?.to_string();
                    let value = iu.get("value")?.as_str()?.to_string();
                    let explicit = iu
                        .get("explicit")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    Some(IdentityUpdate {
                        field,
                        value,
                        explicit,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let emotions = parsed
        .get("emotions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|em| {
                    let emotion = em.get("emotion")?.as_str()?.to_string();
                    let context = em.get("context")?.as_str()?.to_string();
                    let intensity = em
                        .get("intensity")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.5);
                    Some(EmotionalSignal {
                        emotion,
                        context,
                        intensity,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let episodes = parsed
        .get("episodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ep| {
                    let ep_type = ep.get("type")?.as_str()?.to_string();
                    let description = ep.get("description")?.as_str()?.to_string();
                    let importance = ep
                        .get("importance")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.5);
                    Some(EpisodicSignal {
                        r#type: ep_type,
                        description,
                        importance,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let dominant_tone = parsed
        .get("dominant_tone")
        .and_then(|v| v.as_str())
        .unwrap_or("neutral")
        .to_string();

    Some(ExtractionResult {
        traits,
        identity_updates,
        emotions,
        episodes,
        dominant_tone,
    })
}

/// Validate task learnings JSON.
#[napi]
pub fn validate_learnings_json(text: String) -> Option<String> {
    let json_match = extract_json_object(&text)?;
    let parsed: serde_json::Value = serde_json::from_str(&json_match).ok()?;

    let learnings = parsed.get("learnings")?.as_array()?;
    for l in learnings {
        // Must have task_pattern and context
        l.get("task_pattern")?.as_str()?;
        l.get("context")?.as_str()?;
    }

    // Return the cleaned JSON
    Some(serde_json::to_string(&parsed).unwrap_or_default())
}

/// Cap trait signals to MAX_TRAIT_SIGNALS.
#[napi]
pub fn cap_trait_signals(signals: Vec<TraitSignal>) -> Vec<TraitSignal> {
    signals.into_iter().take(MAX_TRAIT_SIGNALS).collect()
}

// ── Summary Clustering ─────────────────────────────

/// Cluster summaries by keyword overlap.
#[napi]
pub fn cluster_summaries(summaries: Vec<String>) -> Vec<SummaryCluster> {
    let mut clusters: Vec<(Vec<String>, HashSet<String>)> = Vec::new();

    for summary in &summaries {
        let keywords = extract_keywords_set(summary);
        let mut merged = false;

        for cluster in clusters.iter_mut() {
            let overlap = keyword_overlap(&keywords, &cluster.1);
            if overlap > 0.3 {
                cluster.0.push(summary.clone());
                for kw in &keywords {
                    cluster.1.insert(kw.clone());
                }
                merged = true;
                break;
            }
        }

        if !merged {
            clusters.push((vec![summary.clone()], keywords));
        }
    }

    clusters
        .into_iter()
        .map(|(summaries, keywords)| SummaryCluster {
            summaries,
            keywords: keywords.into_iter().collect(),
        })
        .collect()
}

// ── Trait Instability Detection ────────────────────

/// Detect unstable traits (high reinforcement but low confidence = flip-flopping).
#[napi]
pub fn detect_trait_instability(traits: Vec<TraitForInstability>) -> Vec<TraitFlip> {
    let mut flips: Vec<TraitFlip> = Vec::new();

    for t in &traits {
        if t.reinforcement_count > 3 && t.confidence < 0.4 {
            let flip_ratio = 1.0 - t.confidence;
            flips.push(TraitFlip {
                key: t.trait_key.clone(),
                flip_ratio,
            });
        }
    }

    flips
}

/// Check if a dominant tone is valid.
#[napi]
pub fn is_valid_emotional_tone(tone: String) -> bool {
    matches!(
        tone.as_str(),
        "driven" | "stressed" | "excited" | "neutral" | "curious" | "frustrated"
    )
}

// ── HMAC-Signed Audit Logging ──────────────────────

/// Compute HMAC-SHA256 signature for an audit log payload.
#[napi]
pub fn compute_hmac_signature(payload_json: String) -> String {
    use std::io::Write;

    // Simple HMAC-SHA256 implementation using the built-in approach
    // We'll use a basic HMAC construction: H((K xor opad) || H((K xor ipad) || message))
    // For production, this is adequate since it's just audit signing

    let key = HMAC_SECRET.as_bytes();
    hmac_sha256(key, payload_json.as_bytes())
}

/// Build a signed audit log entry JSON string.
#[napi]
pub fn build_audit_log_entry(action: String, details_json: String) -> String {
    let now = now_iso();
    let mut payload: serde_json::Value = serde_json::from_str(&details_json).unwrap_or(serde_json::json!({}));

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("action".to_string(), serde_json::json!(action));
        obj.insert("ts".to_string(), serde_json::json!(now));
        obj.insert("user_id".to_string(), serde_json::json!("default"));
    }

    let payload_str = serde_json::to_string(&payload).unwrap_or_default();
    let sig = hmac_sha256(HMAC_SECRET.as_bytes(), payload_str.as_bytes());

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("sig".to_string(), serde_json::json!(sig));
    }

    serde_json::to_string(&payload).unwrap_or_default()
}

// ── Keyword Extraction ─────────────────────────────

fn extract_keywords_set(text: &str) -> HashSet<String> {
    let stopwords: HashSet<&str> = [
        "the", "a", "an", "is", "are", "was", "to", "of", "in", "for", "and", "or", "this",
        "that", "with", "on", "at", "by", "it",
    ]
    .iter()
    .copied()
    .collect();

    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.len() > 3 && !stopwords.contains(w))
        .map(|w| w.to_string())
        .collect()
}

fn keyword_overlap(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let overlap = a.iter().filter(|w| b.contains(*w)).count();
    overlap as f64 / a.len().min(b.len()) as f64
}

// ── Extract JSON object from text ──────────────────

fn extract_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let mut depth = 0;
    let mut end = start;

    for (i, ch) in text[start..].chars().enumerate() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if depth == 0 && end > start {
        Some(text[start..end].to_string())
    } else {
        None
    }
}

// ── Simple HMAC-SHA256 ─────────────────────────────
// Using a basic implementation since we only need it for audit signing

fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    // SHA-256 block size is 64 bytes
    const BLOCK_SIZE: usize = 64;

    let mut padded_key = vec![0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        // Hash the key if it's too long
        let hashed = sha256(key);
        padded_key[..32].copy_from_slice(&hashed);
    } else {
        padded_key[..key.len()].copy_from_slice(key);
    }

    let mut ipad = vec![0x36u8; BLOCK_SIZE];
    let mut opad = vec![0x5cu8; BLOCK_SIZE];

    for i in 0..BLOCK_SIZE {
        ipad[i] ^= padded_key[i];
        opad[i] ^= padded_key[i];
    }

    // Inner hash: H(ipad || message)
    let mut inner_data = ipad;
    inner_data.extend_from_slice(message);
    let inner_hash = sha256(&inner_data);

    // Outer hash: H(opad || inner_hash)
    let mut outer_data = opad;
    outer_data.extend_from_slice(&inner_hash);
    let outer_hash = sha256(&outer_data);

    // Convert to hex string
    outer_hash.iter().map(|b| format!("{:02x}", b)).collect()
}

// Simple SHA-256 implementation
fn sha256(data: &[u8]) -> [u8; 32] {
    // SHA-256 constants
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Pre-processing: adding padding bits
    let ml = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&ml.to_be_bytes());

    // Process each 512-bit block
    for chunk in padded.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut result = [0u8; 32];
    for (i, &val) in h.iter().enumerate() {
        result[i * 4..i * 4 + 4].copy_from_slice(&val.to_be_bytes());
    }
    result
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    format!("{}", secs)
}
