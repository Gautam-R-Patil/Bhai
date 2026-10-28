// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Query Mode Classification — Full port of src/memory/classifier.ts

use napi_derive::napi;
use regex::Regex;

// ── Pattern Compilation ────────────────────────────

lazy_static::lazy_static! {
    static ref RETRIEVAL_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(?i)what did (i|we) (say|discuss|talk about|mention|decide)").unwrap(),
        Regex::new(r"(?i)last (time|week|month|session|conversation)").unwrap(),
        Regex::new(r"(?i)\b(previously|earlier|before|ago)\b").unwrap(),
        Regex::new(r"(?i)\bdo you remember\b").unwrap(),
        Regex::new(r"(?i)\bwhat was\b.*\b(conclusion|decision|result)\b").unwrap(),
        Regex::new(r"(?i)\b(three|two|four|five|six|seven|eight|nine|ten|\d+) (weeks?|months?|days?) ago\b").unwrap(),
        Regex::new(r"(?i)\bhistory\b").unwrap(),
        Regex::new(r"(?i)\brecall\b").unwrap(),
        Regex::new(r"(?i)\bwhat (have|did) (i|we) (done|worked on|discussed)\b").unwrap(),
        Regex::new(r"(?i)\byesterday\b").unwrap(),
        Regex::new(r"(?i)\b(didn'?t I mention|didnt I mention)\b").unwrap(),
        Regex::new(r"(?i)\b(earlier I told|earlier I said|earlier I mentioned)\b").unwrap(),
        Regex::new(r"(?i)\b(remind me|what was that)\b").unwrap(),
    ];

    static ref LLM_ONLY_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(?i)^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|gm)[\s!?.]*$").unwrap(),
        Regex::new(r"(?i)^(thanks|thank you|thx|ty)[\s!?.]*$").unwrap(),
        Regex::new(r"(?i)^(ok|okay|sure|got it|cool|nice|great)[\s!?.]*$").unwrap(),
        Regex::new(r"^/\w+").unwrap(),
        Regex::new(r"(?i)^(stop|cancel)$").unwrap(),
        Regex::new(r"(?i)^(what is the time|what's the time|whats the time|what time is it|time|current time|what is the date|what's the date|whats the date|what date is it|date|current date|what day is it|day)[\s!?.]*$").unwrap(),
    ];
}

// ── Classify ───────────────────────────────────────

/// Classify a user query into one of three modes:
/// - "llm_only": Simple greetings/commands -- no memory needed
/// - "llm_with_traits": Normal queries -- identity + traits injected
/// - "retrieve": User asking about past context -- trigger semantic retrieval
#[napi]
pub fn classify_query(user_message: String) -> String {
    // Normalize apostrophes
    let trimmed = user_message.trim().replace(['\u{2018}', '\u{2019}'], "'");

    // Short messages that are simple greetings
    if trimmed.len() < 30 {
        for pattern in LLM_ONLY_PATTERNS.iter() {
            if pattern.is_match(&trimmed) {
                return "llm_only".to_string();
            }
        }
    }

    // Check for retrieval patterns
    for pattern in RETRIEVAL_PATTERNS.iter() {
        if pattern.is_match(&trimmed) {
            return "retrieve".to_string();
        }
    }

    // Default
    "llm_with_traits".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_greeting() {
        assert_eq!(classify_query("hi".to_string()), "llm_only");
        assert_eq!(classify_query("Hello!".to_string()), "llm_only");
        assert_eq!(classify_query("thanks".to_string()), "llm_only");
    }

    #[test]
    fn test_classify_retrieval() {
        assert_eq!(
            classify_query("what did we discuss last time?".to_string()),
            "retrieve"
        );
        assert_eq!(
            classify_query("do you remember my project?".to_string()),
            "retrieve"
        );
    }

    #[test]
    fn test_classify_default() {
        assert_eq!(
            classify_query("How do I implement a binary tree in Rust?".to_string()),
            "llm_with_traits"
        );
    }
}
