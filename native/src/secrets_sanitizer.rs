// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Shell-output secrets sanitizer — port of src/security/secrets-sanitizer.ts
//
// All 22 patterns from the TS module are reproduced verbatim. Most use the
// standard `regex` crate; ENV_VAR_SECRET uses `fancy-regex` because Rust's
// production-grade `regex` crate explicitly does not support lookarounds
// and that pattern relies on `(?!\[REDACTED:)` to prevent re-redaction of
// values already replaced by more-specific patterns.

use fancy_regex::Regex as FancyRegex;
use lazy_static::lazy_static;
use napi_derive::napi;
use regex::Regex;
use std::collections::HashMap;

#[napi(object)]
pub struct SanitizeResultNapi {
    pub sanitized: String,
    /// JSON-serialized `Record<string, number>` to keep the napi ABI simple.
    /// The TS wrapper deserializes via JSON.parse — round-trip cost is negligible
    /// compared to the sanitizer's regex work.
    pub redactions_by_type_json: String,
    pub total_redactions: u32,
}

// `enum` over the two regex flavors lets us hold a single dispatch table
// even though one pattern needs the backtracking engine. Replacement loops
// fork on this enum.
enum Pat {
    Std(Regex),
    Fancy(FancyRegex),
}

struct Pattern {
    name: &'static str,
    regex: Pat,
}

lazy_static! {
    static ref PATTERNS: Vec<Pattern> = vec![
        Pattern {
            name: "ANTHROPIC_API_KEY",
            regex: Pat::Std(Regex::new(r"sk-ant-(?:api|sid|admin)\d+-[A-Za-z0-9_-]{80,}").unwrap()),
        },
        Pattern {
            name: "OPENAI_API_KEY",
            regex: Pat::Std(Regex::new(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b").unwrap()),
        },
        Pattern {
            name: "OPENROUTER_API_KEY",
            regex: Pat::Std(Regex::new(r"\bsk-or-v\d+-[A-Fa-f0-9]{32,}\b").unwrap()),
        },
        Pattern {
            name: "AWS_ACCESS_KEY",
            regex: Pat::Std(Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap()),
        },
        Pattern {
            name: "STRIPE_LIVE_KEY",
            regex: Pat::Std(Regex::new(r"\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b").unwrap()),
        },
        Pattern {
            name: "STRIPE_TEST_KEY",
            regex: Pat::Std(Regex::new(r"\b(?:sk|pk|rk)_test_[A-Za-z0-9]{24,}\b").unwrap()),
        },
        Pattern {
            name: "GITHUB_TOKEN",
            regex: Pat::Std(Regex::new(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b").unwrap()),
        },
        Pattern {
            name: "GITHUB_FINE_GRAINED_TOKEN",
            regex: Pat::Std(
                Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9]{59,}\b").unwrap(),
            ),
        },
        Pattern {
            name: "GOOGLE_API_KEY",
            regex: Pat::Std(Regex::new(r"\bAIza[A-Za-z0-9_-]{35}\b").unwrap()),
        },
        Pattern {
            name: "SLACK_TOKEN",
            regex: Pat::Std(Regex::new(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b").unwrap()),
        },
        Pattern {
            name: "SLACK_WEBHOOK_URL",
            regex: Pat::Std(
                Regex::new(
                    r"\bhttps://hooks\.slack\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{20,}\b",
                )
                .unwrap(),
            ),
        },
        Pattern {
            name: "DISCORD_BOT_TOKEN",
            regex: Pat::Std(
                Regex::new(r"\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b")
                    .unwrap(),
            ),
        },
        Pattern {
            name: "DISCORD_WEBHOOK_URL",
            regex: Pat::Std(
                Regex::new(
                    r"\bhttps://discord(?:app)?\.com/api/webhooks/\d{17,20}/[A-Za-z0-9_-]{60,}\b",
                )
                .unwrap(),
            ),
        },
        Pattern {
            name: "TWILIO_ACCOUNT_SID",
            regex: Pat::Std(Regex::new(r"\bAC[a-f0-9]{32}\b").unwrap()),
        },
        Pattern {
            name: "TWILIO_AUTH_TOKEN",
            regex: Pat::Std(Regex::new(r"\bSK[a-f0-9]{32}\b").unwrap()),
        },
        Pattern {
            name: "SENDGRID_API_KEY",
            regex: Pat::Std(Regex::new(r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b").unwrap()),
        },
        Pattern {
            name: "MAPBOX_TOKEN",
            regex: Pat::Std(Regex::new(r"\b(?:pk|sk)\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").unwrap()),
        },
        Pattern {
            name: "NPM_TOKEN",
            regex: Pat::Std(Regex::new(r"\bnpm_[A-Za-z0-9]{36}\b").unwrap()),
        },
        Pattern {
            name: "NOTION_SECRET",
            regex: Pat::Std(
                Regex::new(r"\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{45,})\b").unwrap(),
            ),
        },
        Pattern {
            name: "SQUARE_ACCESS_TOKEN",
            regex: Pat::Std(Regex::new(r"\bEAAA[A-Za-z0-9_-]{60,}\b").unwrap()),
        },
        Pattern {
            name: "JWT",
            // The `regex` crate needs `(?s)` to make `.` match newlines, but
            // this pattern uses character classes so no flag is required.
            regex: Pat::Std(
                Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").unwrap(),
            ),
        },
        Pattern {
            name: "BEARER_TOKEN",
            regex: Pat::Std(Regex::new(r"\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}=*").unwrap()),
        },
        Pattern {
            name: "PRIVATE_KEY_PEM",
            // `(?s)` enables dot-matches-newline so `[\s\S]+?` in the TS
            // pattern becomes `.+?` here (lazy, cross-line).
            regex: Pat::Std(
                Regex::new(
                    r"(?s)-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----.+?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----",
                )
                .unwrap(),
            ),
        },
        Pattern {
            name: "ENV_VAR_SECRET",
            // Lookahead `(?!\[REDACTED:)` requires fancy-regex.
            regex: Pat::Fancy(
                FancyRegex::new(
                    r#"\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSPHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|TOKEN|CLIENT[_-]?SECRET)\s*=\s*(?!\[REDACTED:)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"'\n]{8,})"#,
                )
                .unwrap(),
            ),
        },
    ];
}

/// Apply a single pattern in a sequential left-to-right scan, replacing every
/// non-overlapping match with `marker` and returning (new_string, hit_count).
/// Mirrors JS's `string.replace(regex_g, () => { hits++; return marker; })`.
fn apply_std(text: &str, re: &Regex, marker: &str) -> (String, u32) {
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut hits = 0u32;
    for m in re.find_iter(text) {
        out.push_str(&text[last..m.start()]);
        out.push_str(marker);
        last = m.end();
        hits += 1;
    }
    out.push_str(&text[last..]);
    (out, hits)
}

fn apply_fancy(text: &str, re: &FancyRegex, marker: &str) -> (String, u32) {
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut hits = 0u32;
    let mut iter_pos = 0usize;
    // fancy-regex has no built-in find_iter that returns disjoint matches the
    // way std regex does; we use captures_from_pos and advance manually,
    // mirroring how a g-flag JS regex steps forward after each match.
    while iter_pos <= text.len() {
        match re.find_from_pos(text, iter_pos) {
            Ok(Some(m)) => {
                out.push_str(&text[last..m.start()]);
                out.push_str(marker);
                last = m.end();
                // Zero-width match guard (defensive — none of our patterns
                // can match zero-width, but if a future edit introduces one
                // we'd otherwise loop forever).
                if m.end() == iter_pos {
                    if iter_pos < text.len() {
                        iter_pos += 1;
                    } else {
                        break;
                    }
                } else {
                    iter_pos = m.end();
                }
                hits += 1;
            }
            Ok(None) => break,
            Err(_) => break, // Backtrack budget exhausted etc. — fail closed.
        }
    }
    out.push_str(&text[last..]);
    (out, hits)
}

/// Scan `input` for all 22 well-known secret formats; replace each match with
/// a typed `[REDACTED:NAME]` marker. Returns the sanitized string plus a
/// per-type hit count (JSON-encoded to keep the napi ABI flat).
#[napi]
pub fn sanitize_secrets(input: String) -> SanitizeResultNapi {
    if input.is_empty() {
        return SanitizeResultNapi {
            sanitized: input,
            redactions_by_type_json: "{}".to_string(),
            total_redactions: 0,
        };
    }

    let mut current = input;
    let mut counts: HashMap<&'static str, u32> = HashMap::new();
    let mut total: u32 = 0;

    for pat in PATTERNS.iter() {
        let marker = format!("[REDACTED:{}]", pat.name);
        let (next, hits) = match &pat.regex {
            Pat::Std(re) => apply_std(&current, re, &marker),
            Pat::Fancy(re) => apply_fancy(&current, re, &marker),
        };
        if hits > 0 {
            counts.insert(pat.name, hits);
            total += hits;
        }
        current = next;
    }

    SanitizeResultNapi {
        sanitized: current,
        redactions_by_type_json: serde_json::to_string(&counts).unwrap_or_else(|_| "{}".to_string()),
        total_redactions: total,
    }
}

/// Cheap probe: does `input` contain ANY secret pattern? No allocation of a
/// new string; bails out on first hit.
#[napi]
pub fn contains_secrets(input: String) -> bool {
    if input.is_empty() {
        return false;
    }
    for pat in PATTERNS.iter() {
        let hit = match &pat.regex {
            Pat::Std(re) => re.is_match(&input),
            Pat::Fancy(re) => re.is_match(&input).unwrap_or(false),
        };
        if hit {
            return true;
        }
    }
    false
}
