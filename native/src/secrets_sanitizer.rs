// Copyright (c) 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Shell-output secrets sanitizer — port of src/security/secrets-sanitizer.ts
//
// Strategy: sequential per-pattern passes, byte-for-byte mirroring the TS
// PATTERNS-array iteration order. Each pass uses `regex::Regex` and
// short-circuits when the pattern doesn't match (zero allocation), so the
// 25 patterns cost one scan each and only the patterns that actually fire
// pay the cost of building a new String.
//
// Why NOT a single alternation: an early benchmark replaced the 23 passes
// with one big `(?P<A>p1)|(?P<B>p2)|...` regex. That preserved per-pattern
// semantics WHEN patterns matched the SAME span (alternation order = TS
// declaration order = correctness), but diverged silently when TS would
// redact a CONTAINED pattern first. Canonical case: `Authorization: Bearer
// <JWT>`. TS runs JWT before BEARER_TOKEN, redacts the JWT body inside the
// bearer span, and then BEARER_TOKEN fails because `[` is not in its
// alphabet. Alternation picks BEARER (leftmost start) and swallows the JWT.
// Sequential passes preserve the contained-first behaviour for free.
//
// ENV_VAR_SECRET (and URL_USERINFO) originally use a `(?!\[REDACTED:)`
// negative lookahead. `regex` has no lookarounds, so we drop the lookahead
// and emulate it with a post-match prefix check on the captured value. The
// lookahead fires immediately after `\s*=\s*` and only rejects the literal
// `[REDACTED:` prefix; quoted variants like `"[REDACTED:...]"` are NOT
// rejected by the lookahead (the next char is `"`, not `[`), so the post-
// match check must NOT include quoted-prefix branches. Parity-tested with
// fixtures covering both quoted and unquoted shapes.
//
// Two patterns redact ONLY a password segment, not the whole match:
// DB_URI_PASSWORD and URL_USERINFO keep the scheme://user: prefix and the
// @host suffix and replace only the middle group. The flat-marker loop
// can't do this, so they run as dedicated group-rebuild passes. They sit in
// the iteration order between SQUARE_ACCESS_TOKEN (last prefix pattern) and
// JWT (first structured-token pattern), mirroring the TS PATTERNS array. The
// ordering invariant is load-bearing: DB_URI_PASSWORD runs first so DB
// schemes redact with their specific marker, then URL_USERINFO (with the
// `[REDACTED:` skip) covers generic http/https/ftp userinfo without
// re-hitting an already-redacted DB password.

use lazy_static::lazy_static;
use napi_derive::napi;
use regex::Regex;
use std::borrow::Cow;
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

// Standard (flat-marker) patterns. Order MUST match the TS PATTERNS array in
// `src/security/secrets-sanitizer.ts` exactly — sequential semantics depend on
// more-specific patterns running before more-permissive ones (e.g. JWT before
// BEARER_TOKEN so a bearer-wrapped JWT redacts as `Bearer [REDACTED:JWT]`, not
// `[REDACTED:BEARER_TOKEN]`).
//
// Split into a HEAD group (prefix tokens, TS indices 0..=19, ending at
// SQUARE_ACCESS_TOKEN) and a TAIL group (structured tokens, TS indices
// 22..=24: JWT, BEARER_TOKEN, PRIVATE_KEY_PEM). Between the two run the
// group-preserving DB_URI_PASSWORD / URL_USERINFO passes (TS indices 20, 21).
// `sanitize_secrets` dispatches HEAD → DB/URL → TAIL → ENV_VAR in this order.
const STANDARD_PATTERNS_HEAD: &[(&str, &str)] = &[
    (
        "ANTHROPIC_API_KEY",
        r"sk-ant-(?:api|sid|admin)\d+-[A-Za-z0-9_-]{80,}",
    ),
    ("OPENROUTER_API_KEY", r"\bsk-or-v\d+-[A-Fa-f0-9]{32,}\b"),
    ("OPENAI_API_KEY", r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b"),
    ("AWS_ACCESS_KEY", r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    ("STRIPE_LIVE_KEY", r"\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b"),
    ("STRIPE_TEST_KEY", r"\b(?:sk|pk|rk)_test_[A-Za-z0-9]{24,}\b"),
    (
        "GITHUB_TOKEN",
        r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b",
    ),
    (
        "GITHUB_FINE_GRAINED_TOKEN",
        r"\bgithub_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9]{59,}\b",
    ),
    ("GOOGLE_API_KEY", r"\bAIza[A-Za-z0-9_-]{35}\b"),
    ("SLACK_TOKEN", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    (
        "SLACK_WEBHOOK_URL",
        r"\bhttps://hooks\.slack\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{20,}\b",
    ),
    (
        "DISCORD_BOT_TOKEN",
        r"\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b",
    ),
    (
        "DISCORD_WEBHOOK_URL",
        r"\bhttps://discord(?:app)?\.com/api/webhooks/\d{17,20}/[A-Za-z0-9_-]{60,}\b",
    ),
    ("TWILIO_ACCOUNT_SID", r"\bAC[a-f0-9]{32}\b"),
    ("TWILIO_AUTH_TOKEN", r"\bSK[a-f0-9]{32}\b"),
    (
        "SENDGRID_API_KEY",
        r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b",
    ),
    (
        "MAPBOX_TOKEN",
        r"\b(?:pk|sk)\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
    ),
    ("NPM_TOKEN", r"\bnpm_[A-Za-z0-9]{36}\b"),
    (
        "NOTION_SECRET",
        r"\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{45,})\b",
    ),
    ("SQUARE_ACCESS_TOKEN", r"\bEAAA[A-Za-z0-9_-]{60,}\b"),
    // Telegram bot token (bare, as in api.telegram.org/bot<token>/ URLs) and
    // HuggingFace token — mirror the two TS entries added after SQUARE.
    ("TELEGRAM_BOT_TOKEN", r"\d{8,12}:[A-Za-z0-9_-]{35}\b"),
    ("HUGGINGFACE_TOKEN", r"\bhf_[A-Za-z0-9]{34,}\b"),
];

const STANDARD_PATTERNS_TAIL: &[(&str, &str)] = &[
    (
        "JWT",
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
    ),
    ("BEARER_TOKEN", r"\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}=*"),
    (
        "PRIVATE_KEY_PEM",
        r"(?s)-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----.+?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----",
    ),
];

// Group-preserving patterns. Group 1 = scheme://user: prefix, group 2 =
// password, group 3 = `@`. Only group 2 is replaced; 1 and 3 are kept verbatim.
// `regex` has no lookbehind, so the prefix `\b` and the structure live in the
// pattern; the `(?!\[REDACTED:)` of the TS URL_USERINFO is emulated by the
// post-match `value_is_already_redacted` skip in `apply_url_userinfo`.
const DB_URI_PASSWORD_PATTERN: &str = r"\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps)://[^\s:@/]+:)([^@\s/]+)(@)";
// Unbounded scheme: this crate is linear (the TS checks the scheme with a
// lookbehind after "://" to stay linear in V8; same matches).
const URL_USERINFO_PATTERN: &str = r"\b([a-z][a-z0-9+.-]*://[^\s:@/]+:)([^@\s/]+)(@)";

const ENV_VAR_PATTERN: &str = r#"\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSPHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|TOKEN|CLIENT[_-]?SECRET|DATABASE[_-]?URL|CONNECTION[_-]?STRING|DSN)\s*=\s*(?P<value>"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"'\n]{8,})"#;

fn compile_group(patterns: &[(&'static str, &str)]) -> Vec<(&'static str, Regex, String)> {
    patterns
        .iter()
        .map(|(name, pat)| {
            let re = Regex::new(pat).unwrap_or_else(|e| panic!("compile {name}: {e}"));
            let marker = format!("[REDACTED:{name}]");
            (*name, re, marker)
        })
        .collect()
}

lazy_static! {
    /// Compile every standard pattern once at first use. Stored alongside the
    /// pre-built `[REDACTED:NAME]` marker String so the hot loop avoids
    /// `format!()` per match.
    static ref STANDARD_HEAD: Vec<(&'static str, Regex, String)> =
        compile_group(STANDARD_PATTERNS_HEAD);
    static ref STANDARD_TAIL: Vec<(&'static str, Regex, String)> =
        compile_group(STANDARD_PATTERNS_TAIL);

    static ref DB_URI_PASSWORD_REGEX: Regex =
        Regex::new(DB_URI_PASSWORD_PATTERN).expect("DB_URI_PASSWORD_PATTERN must compile");
    static ref URL_USERINFO_REGEX: Regex =
        Regex::new(URL_USERINFO_PATTERN).expect("URL_USERINFO_PATTERN must compile");

    static ref ENV_VAR_REGEX: Regex =
        Regex::new(ENV_VAR_PATTERN).expect("ENV_VAR_PATTERN must compile");
}

const ENV_VAR_MARKER: &str = "[REDACTED:ENV_VAR_SECRET]";
const DB_URI_PASSWORD_MARKER: &str = "[REDACTED:DB_URI_PASSWORD]";
const URL_USERINFO_MARKER: &str = "[REDACTED:URL_USERINFO]";

/// Mirror of the TS lookahead `(?!\[REDACTED:)`. The lookahead fires at the
/// position right after `\s*=\s*`, BEFORE quote consumption — so it only
/// rejects the unquoted, raw `[REDACTED:NAME]` shape. Quoted values whose
/// CONTENTS contain `[REDACTED:` still match in TS and are re-redacted
/// (e.g. `PASSWORD="[REDACTED:GITHUB_TOKEN]"` → `PASSWORD=[REDACTED:ENV_VAR_SECRET]`).
/// Do NOT add quoted-prefix branches here; they would break byte-parity.
fn value_is_already_redacted(value: &str) -> bool {
    value.starts_with("[REDACTED:")
}

/// Single-pattern replace with hit count. Returns `Cow::Borrowed(text)` and
/// hits=0 when the pattern doesn't match — zero allocation on the common
/// case where most patterns don't fire on a given input.
fn replace_with_count<'a>(text: &'a str, re: &Regex, marker: &str) -> (Cow<'a, str>, u32) {
    let mut iter = re.find_iter(text);
    let Some(first) = iter.next() else {
        return (Cow::Borrowed(text), 0);
    };

    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..first.start()]);
    out.push_str(marker);
    let mut last = first.end();
    let mut hits: u32 = 1;

    for m in iter {
        out.push_str(&text[last..m.start()]);
        out.push_str(marker);
        last = m.end();
        hits += 1;
    }
    out.push_str(&text[last..]);
    (Cow::Owned(out), hits)
}

/// ENV_VAR_SECRET pass — `regex` (no backtracking) plus a post-match value-
/// prefix check to emulate `(?!\[REDACTED:)`. Same zero-alloc fast path as
/// `replace_with_count` when nothing matches.
fn apply_env_var<'a>(text: &'a str) -> (Cow<'a, str>, u32) {
    let mut iter = ENV_VAR_REGEX.captures_iter(text).peekable();
    if iter.peek().is_none() {
        return (Cow::Borrowed(text), 0);
    }

    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut hits = 0u32;
    for caps in iter {
        let m = caps.get(0).expect("group 0 always present on a match");
        let value = caps.name("value").map(|v| v.as_str()).unwrap_or("");
        if value_is_already_redacted(value) {
            // Already redacted by an earlier pass — leave the span untouched.
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(ENV_VAR_MARKER);
        last = m.end();
        hits += 1;
    }
    out.push_str(&text[last..]);
    if hits == 0 {
        // ENV_VAR matched but every match was already-redacted — output is
        // identical to input, drop the allocation.
        return (Cow::Borrowed(text), 0);
    }
    (Cow::Owned(out), hits)
}

/// Group-preserving replace: keeps capture groups 1 and 3, replaces group 2
/// with `marker`. Mirrors the TS `replace: (_full, pre, _pw, at) =>
/// `${pre}MARKER${at}`` path. When `skip_if_redacted` is set (URL_USERINFO),
/// a match whose group 2 already starts with `[REDACTED:` is left untouched —
/// the byte-for-byte emulation of the TS `(?!\[REDACTED:)` lookahead. Same
/// zero-alloc fast path as `replace_with_count` when nothing matches.
fn apply_group_password<'a>(
    text: &'a str,
    re: &Regex,
    marker: &str,
    skip_if_redacted: bool,
) -> (Cow<'a, str>, u32) {
    let mut iter = re.captures_iter(text).peekable();
    if iter.peek().is_none() {
        return (Cow::Borrowed(text), 0);
    }

    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut hits = 0u32;
    for caps in iter {
        let m = caps.get(0).expect("group 0 always present on a match");
        let pre = caps.get(1).map(|g| g.as_str()).unwrap_or("");
        let pw = caps.get(2).map(|g| g.as_str()).unwrap_or("");
        let at = caps.get(3).map(|g| g.as_str()).unwrap_or("");
        if skip_if_redacted && value_is_already_redacted(pw) {
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(pre);
        out.push_str(marker);
        out.push_str(at);
        last = m.end();
        hits += 1;
    }
    out.push_str(&text[last..]);
    if hits == 0 {
        return (Cow::Borrowed(text), 0);
    }
    (Cow::Owned(out), hits)
}

/// Scan `input` for all 27 well-known secret formats (20 prefix + DB_URI_PASSWORD
/// + URL_USERINFO + 3 structured + ENV_VAR_SECRET) and replace each match with a
/// typed `[REDACTED:NAME]` marker. Returns the sanitized string plus a per-type
/// hit count (JSON-encoded to keep the napi ABI flat).
#[napi]
pub fn sanitize_secrets(input: String) -> SanitizeResultNapi {
    if input.is_empty() {
        return SanitizeResultNapi {
            sanitized: input,
            redactions_by_type_json: "{}".to_string(),
            total_redactions: 0,
        };
    }

    let mut counts: HashMap<&'static str, u32> = HashMap::new();
    let mut current: Cow<'_, str> = Cow::Borrowed(&input);

    for (name, re, marker) in STANDARD_HEAD.iter() {
        let (next, hits) = replace_with_count(&current, re, marker);
        if hits > 0 {
            counts.insert(*name, hits);
            current = Cow::Owned(next.into_owned());
        }
    }

    // DB_URI_PASSWORD then URL_USERINFO (group-preserving). Order mirrors the
    // TS PATTERNS array: DB schemes redact first with their specific marker,
    // then the generic URL pass skips any already-redacted password.
    let (after_db, db_hits) = apply_group_password(
        &current,
        &DB_URI_PASSWORD_REGEX,
        DB_URI_PASSWORD_MARKER,
        false,
    );
    if db_hits > 0 {
        counts.insert("DB_URI_PASSWORD", db_hits);
        current = Cow::Owned(after_db.into_owned());
    }
    let (after_url, url_hits) =
        apply_group_password(&current, &URL_USERINFO_REGEX, URL_USERINFO_MARKER, true);
    if url_hits > 0 {
        counts.insert("URL_USERINFO", url_hits);
        current = Cow::Owned(after_url.into_owned());
    }

    for (name, re, marker) in STANDARD_TAIL.iter() {
        let (next, hits) = replace_with_count(&current, re, marker);
        if hits > 0 {
            counts.insert(*name, hits);
            current = Cow::Owned(next.into_owned());
        }
    }

    let (after_env, env_hits) = apply_env_var(&current);
    if env_hits > 0 {
        counts.insert("ENV_VAR_SECRET", env_hits);
        current = Cow::Owned(after_env.into_owned());
    }

    let total: u32 = counts.values().sum();
    SanitizeResultNapi {
        sanitized: current.into_owned(),
        redactions_by_type_json: serde_json::to_string(&counts)
            .unwrap_or_else(|_| "{}".to_string()),
        total_redactions: total,
    }
}

/// Cheap probe: does `input` contain ANY secret pattern? Bails out on first
/// hit; no output string allocated.
///
/// For ENV_VAR_SECRET we have to walk matches (not just is_match) because a
/// match whose value is `[REDACTED:...]` doesn't actually count as a secret
/// per the TS semantics. Short-circuits on the first non-redacted match.
#[napi]
pub fn contains_secrets(input: String) -> bool {
    if input.is_empty() {
        return false;
    }
    for (_, re, _) in STANDARD_HEAD.iter().chain(STANDARD_TAIL.iter()) {
        if re.is_match(&input) {
            return true;
        }
    }
    // DB_URI_PASSWORD: any match is a secret. URL_USERINFO: a match counts
    // only if its password isn't already a `[REDACTED:` marker (mirrors the
    // TS inline `(?!\[REDACTED:)` which makes `.test()` false on such input).
    if DB_URI_PASSWORD_REGEX.is_match(&input) {
        return true;
    }
    for caps in URL_USERINFO_REGEX.captures_iter(&input) {
        let pw = caps.get(2).map(|g| g.as_str()).unwrap_or("");
        if !value_is_already_redacted(pw) {
            return true;
        }
    }
    for caps in ENV_VAR_REGEX.captures_iter(&input) {
        let value = caps.name("value").map(|v| v.as_str()).unwrap_or("");
        if !value_is_already_redacted(value) {
            return true;
        }
    }
    false
}
