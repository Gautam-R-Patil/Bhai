// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Linear-time port of src/security/credential-mask.ts (`maskCredentials`) and
// src/security/pii-redactor.ts (`findPii`). Opt-in: ATLAS_NATIVE_PROTECT=true.
//
// Why Rust here: both run over the whole history on every LLM call, every tool
// result and every console line, and V8's backtracking regexes have no
// linear-time guarantee (maskCredentials was quadratic before the TS bounds).
// The `regex` crate is a finite automaton: linear in the input, always.
//
// Byte-identical to the TS, which works on UTF-16 code units, so this does too:
// the JS string comes in as UTF-16 and each code unit becomes ONE byte of a
// "haystack" the regexes run on: ASCII stays itself, a non-ASCII JS whitespace
// unit becomes 0x80, any other non-ASCII unit 0x81. Every pattern is ASCII-only
// (JS `\w`, `\d`, `\b` and `/i` are ASCII without the `u` flag), so matching on
// the haystack is matching on the JS string; offsets and `{m,n}` counts are in
// code units exactly as in JS, and output is rebuilt from the original units
// (lone surrogates included) and handed back as a UTF-16 JS string.
//
// `regex` has no lookarounds or backreferences. They are emulated after the
// match, retrying at the next start when JS would have backtracked away:
//   DIGEST_FIELD `\3` and COOKIE_VALUE `\2` (closing quote = opening quote);
//   CARD `(?<![\w./=:-])…(?![\w/=-]|\.\w)`, AADHAAR `(?<!\d)…\1…(?!\d)`,
//   UPI `(?<![\w.@-])…(?![\w.@-])` as small hand scanners;
//   OTP `(?<!\d)` / `(?!\d)` as pre/post checks; the COOKIE_HEADER cut regex
//   `,\s+(?![\w.-]+\s*=)(?!\d)` and the validators (secretShaped, basicShaped,
//   assignedSecret, providerShaped) as plain functions.
// No RegexSet prefilter: one over the rules' anchor words cost 0.8ms on 200KB,
// more than the rules it would skip (each has its own literal prefilter).
// Parity: src/security/pii-protect.parity.test.ts.

use lazy_static::lazy_static;
use napi::{Env, JsString};
use napi_derive::napi;
use regex::bytes::{Captures, Regex, RegexBuilder};

const MASK: &[u8] = b"[redacted]";
/// JS `\s` / `\S` on the haystack (0x80 = a non-ASCII JS whitespace unit).
const WS: &str = r"[\t\n\x0B\x0C\r \x80]";
const NWS: &str = r"[^\t\n\x0B\x0C\r \x80]";

fn re(pattern: &str) -> Regex {
    RegexBuilder::new(&pattern.replace(r"\s", WS).replace(r"\S", NWS))
        .unicode(false)
        .size_limit(64 << 20)
        .dfa_size_limit(64 << 20)
        .build()
        .expect("pii_protect pattern must compile")
}

const CREDENTIAL_WORDS: &str = r"pass(?:word|wd|phrase)|api[_-]?key|apikey|access[_-]?key|account[_-]?key|accountkey|storage[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|secret[_-]?key|client[_-]?secret|app[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|totp[_-]?(?:seed|secret)|otp[_-]?secret|credentials?";

lazy_static! {
    static ref URL_SPAN: Regex = re(r#"(?i)\b[a-z][a-z0-9+.\-]{0,30}://[^\s"'<>]+"#);
    static ref URL_SLOT: Regex = re(r"\x00U(\d+)\x00");
    static ref PEM: Regex = re(r"(?s)-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z]+ )?PRIVATE KEY-----");
    static ref DIGEST_FIELD: Regex = re(r#"(?i)\b(response|nonce|cnonce)(\s*=\s*)("?)([A-Za-z0-9+/=]{12,})"#);
    static ref SIGV4_SIGNATURE: Regex = re(r"\b(Signature=)([A-Za-z0-9]{8,})");
    static ref AUTH_HEADER: Regex = re(r#"(?i)\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(Basic|Bearer|Token|Negotiate|NTLM)\s+)?([A-Za-z0-9+/=._~\-]{4,})"#);
    static ref FREE_SCHEME: Regex = re(r"(?i)\b(bearer|basic)(\s+)([A-Za-z0-9+/=._~\-]{4,})");
    static ref COOKIE_HEADER: Regex = re(r"(?i)\b(set-cookie|cookie)(\s*:\s*)([^\r\n]+)");
    // COOKIE_VALUE without its `\2`: the closing quote is checked after the match.
    static ref COOKIE_VALUE: Regex = re(r#"(?i)(["']?\bcookie["']?\s*[:=]\s*)(["'`])([^"'`\r\n]{1,1000})|(\bcookie=)([^\s"'`,;&]{6,})"#);
    static ref ASSIGNMENT: Regex = re(&format!(
        r#"(?i)(["']?(?:{CREDENTIAL_WORDS}|id[_\-]?token)s?\b["']?)(\s*(?::|=|=>)\s*)("[^"\r\n]{{0,500}}"|'[^'\r\n]{{0,500}}'|`[^`\r\n]{{0,500}}`|[^\s,;}}\]"'`]{{1,500}})"#
    ));
    static ref PROVIDER_KEY: Regex = re(r"\b(?:sk-(?:proj-|ant-(?:api\d{2}-)?|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9\-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_\-]{30,}|glpat-[A-Za-z0-9_\-]{16,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|shp(?:at|ss|ca)_[A-Za-z0-9]{16,})\b");
    static ref SK_PREFIX: Regex = re(r"^sk-(?:proj-|ant-(?:api\d{2}-)?|svcacct-|admin-)?");
    static ref JWT: Regex = re(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b");

    // findPii
    static ref CARD_WORD: Regex = re(r"(?i)\b(?:card|visa|master ?card|rupay|amex|credit|debit|cc|cvv|expiry)\b");
    static ref UPI_PSP: Regex = re(r"(?i)^(?:ybl|ibl|axl|paytm|upi|apl|yapl|ptyes|ptaxis|pthdfc|ptsbi|icici|sbi|hdfcbank|axisbank|axisb|kotak|idfcbank|idfcfirst|indus|federal|fbl|rbl|aubank|jupiteraxis|freecharge|airtel|jio|slc|ikwik|abfspay|barodampay|cnrb|unionbank|pnb|boi|mahb|kbl|okicici|oksbi|okaxis|okhdfcbank|ok[a-z]+|wa[a-z]+|pt[a-z]+)$");
    static ref JS_COOKIE: Regex = re(r#"(?i)\bdocument\.cookie\s*=\s*["'`]([^"'`\r\n]+)"#);
    // OTP_RE's first alternative up to its keyword, run on the ASCII-lowercased
    // haystack (= JS /i): as `(?i)` the case variants defeat the literal prefilter
    // (2ms on 200KB, 45µs this way). The gap and code are scanned by hand.
    static ref OTP_WORD: Regex = re(r"\b(?:otp|one[- ]time (?:password|code|pin)|verification code|security code|passcode|login code|auth(?:entication)? code|2fa code)\b");
    static ref OTP_BEFORE_WORD: Regex = re(r"(?i)(\d{4,8})[^0-9\n]{0,16}?\b(?:is your|is the)\s+(?:otp|one[- ]time (?:password|code)|verification code|login code|security code|passcode)\b");
}

// ── Text: original UTF-16 units + the matching haystack ─────────

fn is_js_space(c: u16) -> bool {
    matches!(
        c,
        0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

struct Text {
    u: Vec<u16>,
    h: Vec<u8>,
}

impl Text {
    fn new(units: Vec<u16>) -> Self {
        let h = units
            .iter()
            .map(|&c| match c {
                0..=0x7F => c as u8,
                c if is_js_space(c) => 0x80,
                _ => 0x81,
            })
            .collect();
        Text { u: units, h }
    }
    fn with_capacity(n: usize) -> Self {
        Text {
            u: Vec::with_capacity(n),
            h: Vec::with_capacity(n),
        }
    }
    fn len(&self) -> usize {
        self.h.len()
    }
    fn push_range(&mut self, src: &Text, a: usize, b: usize) {
        self.u.extend_from_slice(&src.u[a..b]);
        self.h.extend_from_slice(&src.h[a..b]);
    }
    fn push_ascii(&mut self, s: &[u8]) {
        self.u.extend(s.iter().map(|&b| b as u16));
        self.h.extend_from_slice(s);
    }
}

/// JS `text.replace(globalRegex, callback)`. `f` writes a replacement into its
/// buffer and returns true, or returns false to keep the match as it was. The
/// text is copied only once a match is actually replaced.
fn replace_all<F>(src: Text, re: &Regex, mut f: F) -> Text
where
    F: FnMut(&Text, &Captures, &mut Text) -> bool,
{
    replace_checked(src, re, |src, caps, rep| {
        let end = caps.get(0).expect("group 0").end();
        Step::Take {
            end,
            replaced: f(src, caps, rep),
        }
    })
}

/// What a match that needs a post-check does.
enum Step {
    /// The match (ending at `end`) holds: the replacement was written (true) or it stays (false).
    Take { end: usize, replaced: bool },
    /// JS would have backtracked away from this start: search again from start + 1.
    Retry,
}

/// `replace_all` for patterns whose lookaround/backreference is checked after the match.
fn replace_checked<F>(src: Text, re: &Regex, mut f: F) -> Text
where
    F: FnMut(&Text, &Captures, &mut Text) -> Step,
{
    let mut out: Option<Text> = None;
    let mut rep = Text::with_capacity(64);
    let (mut last, mut pos) = (0, 0);
    while pos <= src.len() {
        let Some(caps) = re.captures_at(&src.h, pos) else {
            break;
        };
        let start = caps.get(0).expect("group 0").start();
        rep.u.clear();
        rep.h.clear();
        match f(&src, &caps, &mut rep) {
            Step::Take { end, replaced } => {
                if replaced {
                    let o = out.get_or_insert_with(|| Text::with_capacity(src.len() + 64));
                    o.push_range(&src, last, start);
                    o.u.extend_from_slice(&rep.u);
                    o.h.extend_from_slice(&rep.h);
                    last = end;
                }
                pos = end;
            }
            Step::Retry => pos = start + 1,
        }
    }
    match out {
        None => src,
        Some(mut o) => {
            o.push_range(&src, last, src.len());
            o
        }
    }
}

// ── Validators (credential-mask.ts) ─────────────────────────────

fn is_ws(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ' | 0x80)
}
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}
fn is_quote(b: u8) -> bool {
    matches!(b, b'"' | b'\'' | b'`')
}
fn has_paren(s: &[u8]) -> bool {
    s.iter().any(|&b| b == b'(' || b == b')')
}
fn eq_any_ci(s: &[u8], words: &[&str]) -> bool {
    words.iter().any(|w| s.eq_ignore_ascii_case(w.as_bytes()))
}
fn starts_ci(s: &[u8], p: &str) -> bool {
    s.len() >= p.len() && s[..p.len()].eq_ignore_ascii_case(p.as_bytes())
}
fn js_trim(s: &[u8]) -> &[u8] {
    let a = s.iter().position(|&b| !is_ws(b)).unwrap_or(s.len());
    let b = s.iter().rposition(|&b| !is_ws(b)).map_or(a, |i| i + 1);
    &s[a..b]
}

/// `/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/`: an a.b.c reference.
fn dotted_ident(s: &[u8]) -> bool {
    let mut parts = 0;
    for seg in s.split(|&b| b == b'.') {
        parts += 1;
        let Some((&first, rest)) = seg.split_first() else {
            return false;
        };
        if !(first.is_ascii_alphabetic() || first == b'_' || first == b'$') {
            return false;
        }
        if !rest.iter().all(|&b| is_word(b) || b == b'$') {
            return false;
        }
    }
    parts >= 2
}

/// `v.replace(/^["'`]|["'`]$/g, "")`
fn strip_quotes(v: &[u8]) -> &[u8] {
    let mut a = 0;
    let mut b = v.len();
    if b > 0 && is_quote(v[0]) {
        a = 1;
    }
    if b >= 2 && is_quote(v[b - 1]) {
        b -= 1;
    }
    &v[a..b.max(a)]
}

fn secret_shaped(v: &[u8]) -> bool {
    let s = strip_quotes(v);
    if s.len() < 6 || s == MASK {
        return false;
    }
    if eq_any_ci(
        s,
        &[
            "true",
            "false",
            "null",
            "none",
            "undefined",
            "required",
            "optional",
            "missing",
            "invalid",
            "incorrect",
            "expired",
            "hidden",
            "redacted",
            "bearer",
            "basic",
        ],
    ) {
        return false;
    }
    if s.len() < 20 && s.iter().all(|b| b.is_ascii_alphabetic()) {
        return false; // a word
    }
    if matches!(s[0], b'.' | b'/' | b'~' | b'$') || starts_ci(s, "http:") || starts_ci(s, "https:")
    {
        return false; // a path, URL or $VAR
    }
    if has_paren(s) || dotted_ident(s) {
        return false; // a call or a.b.c reference
    }
    if s.iter().any(|&b| is_ws(b)) {
        return false; // prose (a value with whitespace is never all [A-Za-z0-9+/=._-])
    }
    if s.len() <= 8 && s.iter().all(|b| b.is_ascii_digit()) {
        return false; // a small number
    }
    s.iter().any(|&b| !b.is_ascii_alphabetic()) || s.len() >= 20
}

/// Node's `Buffer.from(v, "base64")` for a string of the base64 alphabet:
/// 6 bits per char, whole bytes only, stopping at the padding.
fn base64_decode(v: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in v {
        let d = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => break,
        };
        acc = (acc << 6) | d as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Basic credentials are base64 of "user:pass" — even a short one ("dTpw").
fn basic_shaped(v: &[u8]) -> bool {
    let body = v.iter().position(|&b| b == b'=').unwrap_or(v.len());
    if body == 0
        || !v[..body]
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        || !v[body..].iter().all(|&b| b == b'=')
    {
        return false;
    }
    let d = base64_decode(&v[..body]);
    // /^[\x21-\x7e]+:[\x20-\x7e]*$/
    if !d.iter().all(|&b| (0x20..=0x7e).contains(&b)) {
        return false;
    }
    match d.iter().skip(1).position(|&b| b == b':') {
        Some(i) => !d[..i + 1].contains(&b' '),
        None => false,
    }
}

/// A credential-named value worth masking (quoted values always, bare ones by shape).
fn assigned_secret(sep: &[u8], value: &[u8]) -> bool {
    if value.first().is_some_and(|&b| is_quote(b)) {
        let inner = if value.len() >= 2 {
            &value[1..value.len() - 1]
        } else {
            &value[0..0]
        };
        return !inner.is_empty()
            && inner != MASK
            && !inner.iter().all(|&b| b == b'*')
            && !has_paren(inner);
    }
    if value
        .first()
        .is_some_and(|&b| matches!(b, b'.' | b'/' | b'~' | b'$'))
        || has_paren(value)
        || eq_any_ci(value, &["true", "false", "null", "undefined", "none"])
    {
        return false;
    }
    if dotted_ident(value) {
        return false;
    }
    if sep.windows(2).any(|w| w[0] == b':' && is_ws(w[1])) {
        let alpha = value.strip_suffix(b".").unwrap_or(value);
        if !alpha.is_empty() && alpha.iter().all(|b| b.is_ascii_alphabetic()) {
            return false;
        }
        return value.len() >= 10 && secret_shaped(value);
    }
    true
}

/// "sk-hynix-ddr5-kit-2026" is a product slug; a key has a long mixed run.
fn provider_shaped(k: &[u8]) -> bool {
    if !k.starts_with(b"sk-") {
        return true;
    }
    let rest = &k[SK_PREFIX.find(k).map_or(0, |m| m.end())..];
    let mut run = 0;
    let long_run = rest.iter().any(|&b| {
        run = if b.is_ascii_alphanumeric() {
            run + 1
        } else {
            0
        };
        run >= 16
    });
    long_run && k.iter().any(|b| b.is_ascii_digit())
}

/// Where `/,\s+(?![\w.-]+\s*=)(?!\d)/` first matches in a cookie header's rest.
fn cookie_cut(rest: &[u8]) -> Option<usize> {
    let n = rest.len();
    for i in 0..n {
        if rest[i] != b',' {
            continue;
        }
        let k = rest[i + 1..].iter().take_while(|&&b| is_ws(b)).count();
        if k == 0 {
            continue;
        }
        if k >= 2 {
            return Some(i); // backtracking \s+ by one lands on whitespace, where both lookaheads pass
        }
        let j = i + 2;
        if j < n && rest[j].is_ascii_digit() {
            continue;
        }
        let r = rest[j..]
            .iter()
            .take_while(|&&b| is_word(b) || b == b'.' || b == b'-')
            .count();
        if r > 0 {
            let e = j + r + rest[j + r..].iter().take_while(|&&b| is_ws(b)).count();
            if e < n && rest[e] == b'=' {
                continue;
            }
        }
        return Some(i);
    }
    None
}

/// `/[\w.-]\s*=\s*\S/.test(value)`
fn has_pairs(v: &[u8]) -> bool {
    (0..v.len()).filter(|&e| v[e] == b'=').any(|e| {
        let a = e - v[..e].iter().rev().take_while(|&&b| is_ws(b)).count();
        let named = a > 0 && (is_word(v[a - 1]) || v[a - 1] == b'.' || v[a - 1] == b'-');
        named && v[e + 1..].iter().any(|&b| !is_ws(b))
    })
}

fn span(caps: &Captures, i: usize) -> Option<(usize, usize)> {
    caps.get(i).map(|m| (m.start(), m.end()))
}

// ── maskCredentials ─────────────────────────────────────────────

pub fn mask_credentials_units(units: &[u16]) -> Vec<u16> {
    if units.len() < 6 {
        return units.to_vec();
    }
    let mut t = Text::new(units.to_vec());
    let mut urls: Vec<Vec<u16>> = Vec::new();

    // Park URLs so no rule touches them, then put them back.
    {
        t = replace_all(t, &URL_SPAN, |src, caps, o| {
            let m = caps.get(0).expect("group 0");
            urls.push(src.u[m.start()..m.end()].to_vec());
            o.push_ascii(format!("\0U{}\0", urls.len() - 1).as_bytes());
            true
        });
    }
    {
        t = replace_all(t, &PEM, |_, _, o| {
            o.push_ascii(MASK);
            true
        });
    }
    {
        t = replace_checked(t, &DIGEST_FIELD, |src, caps, o| {
            let (q0, q1) = span(caps, 3).expect("quote group");
            let mut end = caps.get(0).expect("group 0").end();
            if q1 > q0 {
                if src.h.get(end) != Some(&b'"') {
                    return Step::Retry; // `\3`: a quoted value must close with the quote
                }
                end += 1;
            }
            let (k0, k1) = span(caps, 1).expect("key");
            let (s0, s1) = span(caps, 2).expect("sep");
            o.push_range(src, k0, k1);
            o.push_range(src, s0, s1);
            o.push_range(src, q0, q1);
            o.push_ascii(MASK);
            o.push_range(src, q0, q1);
            Step::Take {
                end,
                replaced: true,
            }
        });
    }
    {
        t = replace_all(t, &SIGV4_SIGNATURE, |src, caps, o| {
            let (a, b) = span(caps, 1).expect("key");
            o.push_range(src, a, b);
            o.push_ascii(MASK);
            true
        });
    }
    {
        t = replace_all(t, &AUTH_HEADER, |src, caps, o| {
            let (v0, v1) = span(caps, 4).expect("value");
            let value = &src.h[v0..v1];
            if value == MASK || value.eq_ignore_ascii_case(b"Digest") || starts_ci(value, "AWS4-") {
                return false;
            }
            let scheme = span(caps, 3);
            let ok = match scheme {
                Some((a, b)) if src.h[a..b].eq_ignore_ascii_case(b"basic") => {
                    basic_shaped(value) || secret_shaped(value)
                }
                Some(_) => secret_shaped(value),
                None => secret_shaped(value) || basic_shaped(value),
            };
            if !ok {
                return false;
            }
            let (k0, k1) = span(caps, 1).expect("key");
            let (s0, s1) = span(caps, 2).expect("sep");
            o.push_range(src, k0, k1);
            o.push_range(src, s0, s1);
            if let Some((a, b)) = scheme {
                o.push_range(src, a, b);
                o.push_ascii(b" ");
            }
            o.push_ascii(MASK);
            true
        });
    }
    {
        t = replace_all(t, &FREE_SCHEME, |src, caps, o| {
            let (a, b) = span(caps, 1).expect("scheme");
            let (v0, v1) = span(caps, 3).expect("value");
            let value = &src.h[v0..v1];
            let basic = src.h[a..b].eq_ignore_ascii_case(b"basic");
            if value == MASK
                || !(if basic {
                    basic_shaped(value)
                } else {
                    secret_shaped(value)
                })
            {
                return false;
            }
            let (s0, s1) = span(caps, 2).expect("space");
            o.push_range(src, a, b);
            o.push_range(src, s0, s1);
            o.push_ascii(MASK);
            true
        });
    }
    {
        t = replace_all(t, &COOKIE_HEADER, |src, caps, o| {
            let (r0, r1) = span(caps, 3).expect("rest");
            let rest = &src.h[r0..r1];
            if rest.starts_with(MASK) {
                return false;
            }
            let cut = cookie_cut(rest).unwrap_or(rest.len());
            let value = &rest[..cut];
            if !(has_pairs(value) || secret_shaped(js_trim(value))) {
                return false;
            }
            let (k0, k1) = span(caps, 1).expect("key");
            let (s0, s1) = span(caps, 2).expect("sep");
            o.push_range(src, k0, k1);
            o.push_range(src, s0, s1);
            o.push_ascii(MASK);
            o.push_range(src, r0 + cut, r1);
            true
        });
        t = replace_checked(t, &COOKIE_VALUE, |src, caps, o| {
            let m = caps.get(0).expect("group 0");
            if let Some((q0, q1)) = span(caps, 2) {
                // `\2`: the run must end at the same quote it opened with.
                if src.h.get(m.end()) == Some(&src.h[q0]) {
                    let (i0, i1) = span(caps, 3).expect("inner");
                    let inner = &src.h[i0..i1];
                    let end = m.end() + 1;
                    if !(inner.contains(&b'=') || secret_shaped(inner)) {
                        return Step::Take {
                            end,
                            replaced: false,
                        };
                    }
                    let (l0, l1) = span(caps, 1).expect("lead");
                    o.push_range(src, l0, l1);
                    o.push_range(src, q0, q1);
                    o.push_ascii(MASK);
                    o.push_range(src, q0, q1);
                    return Step::Take {
                        end,
                        replaced: true,
                    };
                }
                // JS then tries the second alternative at this same start.
                return match bare_cookie_at(&src.h, m.start()) {
                    Some(end) => bare_cookie(src, m.start(), end, o),
                    None => Step::Retry,
                };
            }
            bare_cookie(src, m.start(), m.end(), o)
        });
    }
    {
        t = replace_checked(t, &ASSIGNMENT, |src, caps, o| {
            let (k0, k1) = span(caps, 1).expect("key");
            // `(?<![A-Za-z0-9])id[_-]?token`: "valid_token" is not "val" + "id_token".
            // No credential word starts with "id", and a key that starts with a
            // quote has the quote before its "id", so only k0 needs the check.
            if k0 > 0 && starts_ci(&src.h[k0..k1], "id") && src.h[k0 - 1].is_ascii_alphanumeric() {
                return Step::Retry;
            }
            let (s0, s1) = span(caps, 2).expect("sep");
            let (v0, v1) = span(caps, 3).expect("value");
            let end = caps.get(0).expect("group 0").end();
            if !assigned_secret(&src.h[s0..s1], &src.h[v0..v1]) {
                return Step::Take {
                    end,
                    replaced: false,
                };
            }
            o.push_range(src, k0, k1);
            o.push_range(src, s0, s1);
            if is_quote(src.h[v0]) {
                o.push_range(src, v0, v0 + 1);
                o.push_ascii(MASK);
                o.push_range(src, v0, v0 + 1);
            } else {
                o.push_ascii(MASK);
            }
            Step::Take {
                end,
                replaced: true,
            }
        });
    }
    {
        t = replace_all(t, &PROVIDER_KEY, |src, caps, o| {
            let m = caps.get(0).expect("group 0");
            if !provider_shaped(&src.h[m.start()..m.end()]) {
                return false;
            }
            o.push_ascii(MASK);
            true
        });
    }
    {
        t = replace_all(t, &JWT, |_, _, o| {
            o.push_ascii(MASK);
            true
        });
    }
    // Always, as in TS: a "\0U<n>\0" the input already held is restored too.
    if t.h.contains(&0) {
        t = replace_all(t, &URL_SLOT, |src, caps, o| {
            let (a, b) = span(caps, 1).expect("index");
            // `urls[Number(i)]`: an index with no URL becomes "undefined", as in JS.
            let url = std::str::from_utf8(&src.h[a..b])
                .ok()
                .and_then(|d| d.parse::<usize>().ok())
                .and_then(|i| urls.get(i));
            match url {
                Some(u) => {
                    o.u.extend_from_slice(u);
                    o.h.extend(Text::new(u.clone()).h);
                }
                None => o.push_ascii(b"undefined"),
            }
            true
        });
    }
    t.u
}

/// End of `\bcookie=[^\s"'`,;&]{6,}` when it matches at `at`.
fn bare_cookie_at(h: &[u8], at: usize) -> Option<usize> {
    if (at > 0 && is_word(h[at - 1])) || !starts_ci(&h[at..], "cookie=") {
        return None;
    }
    let v = at + 7;
    let run = h[v..]
        .iter()
        .take_while(|&&b| !is_ws(b) && !b"\"'`,;&".contains(&b))
        .count();
    (run >= 6).then_some(v + run)
}

fn bare_cookie(src: &Text, start: usize, end: usize, o: &mut Text) -> Step {
    if !secret_shaped(&src.h[start + 7..end]) {
        return Step::Take {
            end,
            replaced: false,
        };
    }
    o.push_range(src, start, start + 7);
    o.push_ascii(MASK);
    Step::Take {
        end,
        replaced: true,
    }
}

// ── findPii ─────────────────────────────────────────────────────

pub fn luhn_valid(digits: &[u8]) -> bool {
    let mut sum = 0u32;
    for (i, &c) in digits.iter().rev().enumerate() {
        let mut d = (c - b'0') as u32;
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum.is_multiple_of(10)
}

const VD: [[u8; 10]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP: [[u8; 10]; 8] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

pub fn verhoeff_valid(digits: &[u8]) -> bool {
    let mut c = 0usize;
    for (i, &d) in digits.iter().rev().enumerate() {
        c = VD[c][VP[i % 8][(d - b'0') as usize] as usize] as usize;
    }
    c == 0
}

fn digits_of(s: &[u8]) -> Vec<u8> {
    s.iter().copied().filter(u8::is_ascii_digit).collect()
}
fn all_digits(s: &[u8]) -> bool {
    s.iter().all(u8::is_ascii_digit)
}

/// `/^\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}$|^\d{4}([ -])\d{6}\2\d{5}$/`
fn card_grouped(m: &[u8]) -> bool {
    let sep = |i: usize| m.get(i).copied().filter(|&b| b == b' ' || b == b'-');
    let four = (16..=22).contains(&m.len())
        && all_digits(&m[..4])
        && sep(4).is_some()
        && all_digits(&m[5..9])
        && m[9] == m[4]
        && all_digits(&m[10..14])
        && m[14] == m[4]
        && all_digits(&m[15..]);
    let amex = m.len() == 17
        && all_digits(&m[..4])
        && sep(4).is_some()
        && all_digits(&m[5..11])
        && m[11] == m[4]
        && all_digits(&m[12..]);
    four || amex
}

struct Found {
    kind: &'static str,
    start: usize,
    end: usize,
}

/// `(?<![\w./=:-])(?:\d[ -]?){12,18}\d(?![\w/=-]|\.\w)`, then the card checks.
fn find_cards(h: &[u8], out: &mut Vec<Found>) {
    let n = h.len();
    let mut s = 0;
    while s < n {
        if !h[s].is_ascii_digit() || (s > 0 && (is_word(h[s - 1]) || b"./=:-".contains(&h[s - 1])))
        {
            s += 1;
            continue;
        }
        // Digits from s, single ' '/'-' between two digits allowed; at most 19.
        let mut ends = [0usize; 19];
        let mut count = 0;
        let mut i = s;
        loop {
            i += 1;
            ends[count] = i;
            count += 1;
            if count == 19 {
                break;
            }
            if i < n && h[i].is_ascii_digit() {
                continue;
            }
            if i + 1 < n && (h[i] == b' ' || h[i] == b'-') && h[i + 1].is_ascii_digit() {
                i += 1;
                continue;
            }
            break;
        }
        // Greedy: the longest digit count whose end passes the lookahead.
        let after_ok = |e: usize| match h.get(e) {
            None => true,
            Some(&b) if is_word(b) || b"/=-".contains(&b) => false,
            Some(&b'.') => !h.get(e + 1).is_some_and(|&b| is_word(b)),
            _ => true,
        };
        let end = (13..=count)
            .rev()
            .map(|c| ends[c - 1])
            .find(|&e| after_ok(e));
        let Some(e) = end else {
            s += 1;
            continue;
        };
        let m = &h[s..e];
        let d = digits_of(m);
        let iin = matches!(d[0], b'4' | b'6')
            || (d[0] == b'3' && matches!(d[1], b'4' | b'7'))
            || (d[0] == b'5' && (b'1'..=b'5').contains(&d[1]))
            || (d[0] == b'2' && (b'2'..=b'7').contains(&d[1]));
        if luhn_valid(&d) && iin {
            let near = &h[s.saturating_sub(40)..s];
            if card_grouped(m) || d.len() == 15 || d.len() == 16 || CARD_WORD.is_match(near) {
                out.push(Found {
                    kind: "CARD",
                    start: s,
                    end: e,
                });
            }
        }
        s = e;
    }
}

/// `(?<!\d)[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?!\d)`, grouped or Verhoeff-valid.
fn find_aadhaar(h: &[u8], out: &mut Vec<Found>) {
    let n = h.len();
    let digits_at = |a: usize, k: usize| a + k <= n && all_digits(&h[a..a + k]);
    let mut s = 0;
    while s < n {
        if !(b'2'..=b'9').contains(&h[s])
            || (s > 0 && h[s - 1].is_ascii_digit())
            || !digits_at(s + 1, 3)
        {
            s += 1;
            continue;
        }
        let p = s + 4;
        let grouped = p < n && (h[p] == b' ' || h[p] == b'-');
        let end = if grouped {
            (digits_at(p + 1, 4) && h.get(p + 5) == Some(&h[p]) && digits_at(p + 6, 4))
                .then_some(s + 14)
        } else {
            digits_at(p, 8).then_some(s + 12)
        };
        match end.filter(|&e| !h.get(e).is_some_and(u8::is_ascii_digit)) {
            Some(e) => {
                if grouped || verhoeff_valid(&h[s..e]) {
                    out.push(Found {
                        kind: "AADHAAR",
                        start: s,
                        end: e,
                    });
                }
                s = e;
            }
            None => s += 1,
        }
    }
}

/// `(?<![\w.@-])[a-zA-Z0-9][\w.-]{1,255}@(?:PSPS)(?![\w.@-])`, from each '@'
/// back: a match's start can only be the start of the id run before its '@'.
fn find_upi(h: &[u8], out: &mut Vec<Found>) {
    let id_char = |b: u8| is_word(b) || b == b'.' || b == b'-';
    let mut done = 0; // matches don't overlap: JS resumes after the last one
    for at in (0..h.len()).filter(|&i| h[i] == b'@') {
        let r = h[done..at]
            .iter()
            .rev()
            .take_while(|&&b| id_char(b))
            .count();
        let s = at - r;
        // r - 1 id chars after the first, which must be alphanumeric with no id char, '@' or match before it.
        if !(2..=256).contains(&r)
            || !h[s].is_ascii_alphanumeric()
            || (s > 0 && (id_char(h[s - 1]) || h[s - 1] == b'@'))
        {
            continue;
        }
        let w = h[at + 1..].iter().take_while(|&&b| is_word(b)).count();
        let e = at + 1 + w;
        if w > 0 && !h.get(e).is_some_and(|b| b".@-".contains(b)) && UPI_PSP.is_match(&h[at + 1..e])
        {
            out.push(Found {
                kind: "UPI",
                start: s,
                end: e,
            });
            done = e;
        }
    }
}

/// An OTP match: (match start, code start, code end, match end).
type Otp = (usize, usize, usize, usize);

fn digit_run(h: &[u8], at: usize) -> usize {
    h[at..].iter().take_while(|b| b.is_ascii_digit()).count()
}

/// `\b(?:words)\b[^0-9\n]{0,24}?(?<!\d)(\d{4,8})(?!\d)` at or after `pos`. The lazy
/// gap can't pass a digit, so the code is the first digit run within 24 chars.
fn next_otp_after_word(h: &[u8], lower: &[u8], mut pos: usize) -> Option<Otp> {
    while let Some(m) = OTP_WORD.find_at(lower, pos) {
        let gap = h[m.end()..]
            .iter()
            .take(25)
            .position(|&b| b.is_ascii_digit() || b == b'\n');
        if let Some(c0) = gap.map(|g| m.end() + g).filter(|&c| h[c].is_ascii_digit()) {
            let n = digit_run(h, c0);
            if (4..=8).contains(&n) {
                return Some((m.start(), c0, c0 + n, c0 + n));
            }
        }
        pos = m.start() + 1;
    }
    None
}

/// `(?<!\d)(\d{4,8})(?!\d)[^0-9\n]{0,16}?\b(?:is your|is the)\s+(?:…)\b` at or after `pos`.
fn next_otp_before_word(h: &[u8], mut pos: usize) -> Option<Otp> {
    while pos <= h.len() {
        let caps = OTP_BEFORE_WORD.captures_at(h, pos)?;
        let m = caps.get(0).expect("group 0");
        let (c0, c1) = span(&caps, 1).expect("code");
        // The gap holds no digit, so the code is followed by a non-digit already.
        if c0 == 0 || !h[c0 - 1].is_ascii_digit() {
            return Some((m.start(), c0, c1, m.end()));
        }
        pos = m.start() + 1;
    }
    None
}

fn find_otps(h: &[u8], out: &mut Vec<Found>) {
    let lower = h.to_ascii_lowercase();
    // The two alternatives can't both match at one start (one starts with a word,
    // the other with 4+ digits; "2fa" has one), so the leftmost of the two wins.
    // Each side is searched again only when the last pick passed its candidate;
    // once a side finds nothing it stays done (re-searching it was quadratic).
    let mut pos = 0;
    let mut a = next_otp_after_word(h, &lower, 0);
    let mut b = next_otp_before_word(h, 0);
    loop {
        if a.is_some_and(|x| x.0 < pos) {
            a = next_otp_after_word(h, &lower, pos);
        }
        if b.is_some_and(|x| x.0 < pos) {
            b = next_otp_before_word(h, pos);
        }
        let pick = match (a, b) {
            (Some(x), Some(y)) => Some(if x.0 <= y.0 { x } else { y }),
            (x, y) => x.or(y),
        };
        let Some((_, c0, c1, end)) = pick else { break };
        out.push(Found {
            kind: "OTP",
            start: c0,
            end: c1,
        });
        pos = end;
    }
}

pub fn find_pii_units(units: &[u16]) -> Vec<(String, u32, u32)> {
    let h = Text::new(units.to_vec()).h;
    let mut out = Vec::new();
    find_cards(&h, &mut out);
    find_aadhaar(&h, &mut out);
    find_upi(&h, &mut out);
    for caps in JS_COOKIE.captures_iter(&h) {
        let (a, b) = span(&caps, 1).expect("value");
        out.push(Found {
            kind: "COOKIE",
            start: a,
            end: b,
        });
    }
    find_otps(&h, &mut out);
    // Keep the earliest, then longest, of overlapping matches (stable, as in JS).
    out.sort_by(|x, y| x.start.cmp(&y.start).then(y.end.cmp(&x.end)));
    let mut kept: Vec<Found> = Vec::new();
    for f in out {
        if kept.last().is_none_or(|k| f.start >= k.end) {
            kept.push(f);
        }
    }
    kept.into_iter()
        .map(|f| (f.kind.to_string(), f.start as u32, f.end as u32))
        .collect()
}

// ── napi ────────────────────────────────────────────────────────

fn units_of(text: JsString) -> napi::Result<Vec<u16>> {
    let mut u: Vec<u16> = text.into_utf16()?.into();
    u.pop(); // napi's trailing NUL
    Ok(u)
}

/// `maskCredentials` (credential-mask.ts), byte-identical, linear time.
#[napi]
pub fn native_mask_credentials(env: Env, text: JsString) -> napi::Result<JsString> {
    let utf16 = text.into_utf16()?;
    let units = &utf16[..utf16.len().saturating_sub(1)]; // napi's trailing NUL
    let out = mask_credentials_units(units);
    // Nothing masked (most text): hand the same JS string back, no copy.
    if out == units {
        return Ok(utf16.into_value());
    }
    env.create_string_utf16(&out)
}

#[napi(object)]
pub struct PiiSpan {
    pub kind: String,
    /// UTF-16 code-unit offsets, as `PiiMatch.start` / `end`.
    pub start: u32,
    pub end: u32,
}

/// `findPii` (pii-redactor.ts), same spans in the same order.
#[napi]
pub fn native_find_pii(text: JsString) -> napi::Result<Vec<PiiSpan>> {
    let units = units_of(text)?;
    Ok(find_pii_units(&units)
        .into_iter()
        .map(|(kind, start, end)| PiiSpan { kind, start, end })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(s: &str) -> String {
        String::from_utf16(&mask_credentials_units(
            &s.encode_utf16().collect::<Vec<_>>(),
        ))
        .unwrap()
    }

    #[test]
    fn masks_and_keeps() {
        assert_eq!(mask("password=hunter"), "password=[redacted]");
        assert_eq!(
            mask("Cookie: a=1, then retry"),
            "Cookie: [redacted], then retry"
        );
        assert_eq!(mask("password: required"), "password: required");
        let url = "https://user:pw-fake@example.com/path?token=abc123def456";
        assert_eq!(mask(url), url);
        assert_eq!(mask("Basic dTpw rejected"), "Basic [redacted] rejected");
    }

    #[test]
    fn checksums() {
        assert!(luhn_valid(b"4111111111111111"));
        assert!(!luhn_valid(b"4111111111111112"));
        assert!(verhoeff_valid(b"234123412346"));
    }
}
