// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Shell-output secrets sanitizer ──────────────────────────────
// The audit flagged that `shell_exec` returns raw stdout/stderr to
// the LLM context. A script like `echo $AWS_ACCESS_KEY_ID` or an
// accidental `curl -H "Authorization: Bearer $TOKEN"` dumps
// credentials straight into agent memory and cloud logs. This
// module scans strings for well-known secret formats and replaces
// each match with a typed redaction marker like
//   [REDACTED:ANTHROPIC_API_KEY]
// so the agent can still reason about "a secret was emitted here"
// without getting the raw value.
//
// Pure module — no I/O, no module-level state. Safe to call on
// every shell_exec return path; the regex pass is ~O(input×patterns)
// and the patterns are all distinctive prefixes so it runs in
// single-digit milliseconds on typical shell outputs.
//
// Design notes on false-positive control:
//   * Every pattern anchors on a distinctive prefix (`sk-ant-`,
//     `AKIA`, `sk_live_`, `AIza`, `ghp_`, etc.) rather than raw
//     entropy. A bare 40-char base64 string won't trigger —
//     "40-char base64" is too common in real shell output.
//   * The env-var pattern requires BOTH an uppercase key name
//     suffix matching a known-sensitive keyword AND a `=` AND a
//     non-trivial value, so `NODE_ENV=production` doesn't trip.
//   * JWT requires all three `eyJ...` base64url segments.
//   * PEM private keys match the full BEGIN/END frame, not just
//     the base64 body.

import { nativeContainsSecrets, nativeSanitizeSecrets } from "../native/index.js";

export interface SanitizeResult {
    /** The input text with all detected secrets replaced by typed markers. */
    sanitized: string;
    /** Number of redactions performed, keyed by secret type. */
    redactionsByType: Record<string, number>;
    /** Total redaction count (sum of redactionsByType). */
    totalRedactions: number;
}

// Native sanitizer is DEFAULT ON. Set ATLAS_NO_NATIVE_SANITIZER=true to force
// the TS fallback (e.g. for debugging or on a platform without the binary).
// Bench (scripts/bench-native.ts, re-measured Oct 2026) shows native at
// 1.9x–3.4x of TS on inputs from 1KB to 200KB (1.6x at 50B) with the
// sequential per-pattern Cow<&str> rewrite — zero allocation on no-match
// passes, one allocation per pattern that fires.
const NATIVE_DISABLED = process.env.ATLAS_NO_NATIVE_SANITIZER === "true";

interface Pattern {
    name: string;
    /** Must use the `g` flag — replaceAll is used for counting matches. */
    regex: RegExp;
    /**
     * Optional group-preserving replacement. When set, `_sanitizeSecretsTs`
     * calls this with the full match + capture groups instead of substituting
     * the flat `[REDACTED:NAME]` marker. Used by DB_URI_PASSWORD and
     * URL_USERINFO to redact ONLY the password segment while keeping the
     * scheme/user/host groups intact (e.g. `postgres://u:[REDACTED:...]@h`).
     * The Rust mirror reproduces this via a dedicated group-rebuild pass.
     */
    replace?: (full: string, ...groups: string[]) => string;
    /**
     * Optional: every match ends at or before the last match of this regex, so
     * the pass runs on that prefix only. Keeps PRIVATE_KEY_PEM linear: a BEGIN
     * with no END after it made the lazy body scan to the end of the text, once
     * per BEGIN. Output is unchanged (the Rust regex crate is linear already).
     */
    endsBy?: RegExp;
}

const PATTERNS: Pattern[] = [
    // ── API keys with distinctive prefixes ─────────────────────
    {
        name: "ANTHROPIC_API_KEY",
        // sk-ant-api01-..., sk-ant-sid01-..., sk-ant-admin01-...
        regex: /sk-ant-(?:api|sid|admin)\d+-[A-Za-z0-9_-]{80,}/g,
    },
    {
        name: "OPENROUTER_API_KEY",
        // sk-or-v1-<hex>. Listed before OPENAI_API_KEY so the generic
        // sk-… pattern doesn't swallow OpenRouter keys.
        regex: /\bsk-or-v\d+-[A-Fa-f0-9]{32,}\b/g,
    },
    {
        name: "OPENAI_API_KEY",
        // Legacy: sk-<48 chars>.  New project keys: sk-proj-<long>.
        // Anchored with \b so it doesn't match inside sk-ant- / sk_live_.
        regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
    },
    {
        name: "AWS_ACCESS_KEY",
        // AKIA/ASIA + 16 uppercase alphanumerics. 20 chars total.
        regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    },
    {
        name: "STRIPE_LIVE_KEY",
        regex: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b/g,
    },
    {
        name: "STRIPE_TEST_KEY",
        regex: /\b(?:sk|pk|rk)_test_[A-Za-z0-9]{24,}\b/g,
    },
    {
        name: "GITHUB_TOKEN",
        // ghp_ / gho_ / ghu_ / ghs_ / ghr_ + >=36 alnum.
        regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    },
    {
        name: "GITHUB_FINE_GRAINED_TOKEN",
        // github_pat_<alphanum_>_<hex>
        regex: /\bgithub_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9]{59,}\b/g,
    },
    {
        name: "GOOGLE_API_KEY",
        // AIza + 35 chars
        regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    },
    {
        name: "SLACK_TOKEN",
        // xoxa-, xoxb-, xoxp-, xoxr-, xoxs-
        regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    {
        name: "SLACK_WEBHOOK_URL",
        // Webhook URLs — distinct from xox tokens above
        regex: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}\b/g,
    },
    {
        name: "DISCORD_BOT_TOKEN",
        // 3-part base64 format: ID.timestamp.hmac, the first 2 segments
        // are long base64url so the whole thing is very distinctive.
        regex: /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g,
    },
    {
        name: "DISCORD_WEBHOOK_URL",
        // webhook/<id>/<token>
        regex: /\bhttps:\/\/discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,}\b/g,
    },
    {
        name: "TWILIO_ACCOUNT_SID",
        // AC + 32 hex chars
        regex: /\bAC[a-f0-9]{32}\b/g,
    },
    {
        name: "TWILIO_AUTH_TOKEN",
        // SK + 32 hex chars (API key SID format)
        regex: /\bSK[a-f0-9]{32}\b/g,
    },
    {
        name: "SENDGRID_API_KEY",
        // SG. + 22 base64url . 43 base64url
        regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    },
    {
        name: "MAPBOX_TOKEN",
        // pk.eyJ... or sk.eyJ... — JWT-like payload, prefixed distinctly
        regex: /\b(?:pk|sk)\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    },
    {
        name: "NPM_TOKEN",
        // npm_<36 chars>
        regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    },
    {
        name: "NOTION_SECRET",
        // Old: secret_<43 chars>. New: ntn_<45 chars>.
        regex: /\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{45,})\b/g,
    },
    {
        name: "SQUARE_ACCESS_TOKEN",
        // EAAA + 60 base64url chars
        regex: /\bEAAA[A-Za-z0-9_-]{60,}\b/g,
    },
    // Note on Cloudflare API tokens: they're 40 chars from a specific
    // alphabet but lack a distinctive prefix, so a standalone pattern
    // produces too many false positives. The BEARER_TOKEN and
    // ENV_VAR_SECRET patterns already catch them in the two real-world
    // shapes (Authorization: Bearer header, CF_API_TOKEN= env var).

    // ── Connection-string / URL userinfo passwords ────────────
    // These two redact ONLY the password segment between `:` and `@`,
    // keeping scheme://user: and @host intact so the agent can still
    // reason about which service. They use group-preserving `replace`
    // (the flat-marker loop can't keep capture groups). DB_URI_PASSWORD
    // MUST run before URL_USERINFO so the DB schemes redact with their
    // specific marker; URL_USERINFO then carries a `(?!\[REDACTED:)`
    // guard so it never double-redacts a DB password an earlier pass
    // already replaced.
    {
        name: "DB_URI_PASSWORD",
        // scheme://user:PASSWORD@host — redact group 2 only.
        regex: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:@/]+:)([^@\s/]+)(@)/g,
        replace: (_full, pre, _pw, at) => `${pre}[REDACTED:DB_URI_PASSWORD]${at}`,
    },
    {
        name: "URL_USERINFO",
        // Generic scheme://user:PASSWORD@host (http/https/ftp/etc.). The
        // `(?!\[REDACTED:)` after the colon stops this from re-matching a
        // DB password DB_URI_PASSWORD already turned into a marker.
        // The scheme is checked by a lookbehind after the literal "://", so
        // the scan only stops at "://" and looks back to the previous ":" at
        // most (linear; an unbounded scheme at the front rescanned "a-a-a-…"
        // from every word boundary: 2s at 40KB). No length bound on the
        // scheme. It stays outside the match, which leaves the output
        // unchanged: the replacement kept it verbatim, and a match always ends
        // at "@", which a scheme can't contain.
        regex: /(:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:)(?!\[REDACTED:)([^@\s/]+)(@)/g,
        replace: (_full, pre, _pw, at) => `${pre}[REDACTED:URL_USERINFO]${at}`,
    },

    // ── Standard structured tokens ─────────────────────────────
    {
        name: "JWT",
        // Header.Payload.Signature in base64url. Header starts with
        // eyJ (base64 of {"). Require all three segments non-empty.
        regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    },
    {
        name: "BEARER_TOKEN",
        // "Bearer <token>" with a ~meaningful token length. Matches
        // the whole "Bearer X" phrase so it's replaced cleanly.
        regex: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
    },

    // ── PEM private keys (full frame) ──────────────────────────
    {
        name: "PRIVATE_KEY_PEM",
        // [\s\S] to cross newlines. Lazy-match the body so adjacent
        // keys don't merge. We also accept the common variants
        // (plain, RSA, EC, DSA, OPENSSH, PGP).
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
        endsBy: /-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    },

    // ── Env-var-style secret assignments ───────────────────────
    // Matches NAME=value where NAME ends in a known-sensitive
    // keyword. Value must be at least 8 chars to skip placeholders
    // like SECRET= or PASSWORD=""
    //
    // The `[A-Z0-9_]*` (no leading `[A-Z]`) is deliberate: it lets
    // bare keyword assignments like TOKEN=xxx match with an empty
    // prefix, while still anchoring to a word boundary so mid-word
    // substrings like "someTOKENs" don't trigger.
    //
    // Suffix list covers the common env-var endings for secrets.
    // Standalone `TOKEN` catches GITHUB_TOKEN, ACCESS_TOKEN,
    // REFRESH_TOKEN, ID_TOKEN, CSRF_TOKEN, etc. — all real secrets.
    {
        name: "ENV_VAR_SECRET",
        // The `(?!\[REDACTED:)` lookahead prevents this pattern from
        // re-redacting a value that an earlier, more-specific pattern
        // already replaced (e.g. TOKEN=ghp_... first matches as
        // GITHUB_TOKEN, turning the value into `[REDACTED:GITHUB_TOKEN]`
        // — without the guard, ENV_VAR_SECRET would then match the
        // TOKEN=[REDACTED:...] sequence and overwrite the specific
        // marker with a generic one).
        regex: /\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSPHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|TOKEN|CLIENT[_-]?SECRET|DATABASE[_-]?URL|CONNECTION[_-]?STRING|DSN)\s*=\s*(?!\[REDACTED:)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"'\n]{8,})/g,
    },
];

/** End of the last match of `re`, overlapping ones included ("-----END …-----END …-----" shares its dashes); -1 if none. */
function lastEnd(text: string, re: RegExp): number {
    let end = -1;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        end = m.index + m[0].length;
        re.lastIndex = m.index + 1;
    }
    return end;
}

/**
 * TS implementation of the sanitizer. The exported `sanitizeSecrets` routes
 * to native by default and falls back here when native is unavailable,
 * disabled via env, or the input is short enough that the FFI tax dominates.
 *
 * Zero-alloc fast path when `input` is empty or contains none of the
 * pattern anchors (the regex engine short-circuits on anchor misses).
 */
// Exported for parity-testing only; production callers use `sanitizeSecrets`.
export function _sanitizeSecretsTs(input: string): SanitizeResult {
    if (!input) {
        return { sanitized: input, redactionsByType: {}, totalRedactions: 0 };
    }

    let current = input;
    const counts: Record<string, number> = {};
    let total = 0;

    for (const { name, regex, replace, endsBy } of PATTERNS) {
        // `replace` with a function lets us count matches in one pass.
        let hits = 0;
        let tail = "";
        if (endsBy) {
            const end = lastEnd(current, endsBy);
            if (end < 0) continue;
            tail = current.slice(end);
            current = current.slice(0, end);
        }
        if (replace) {
            // Group-preserving pattern (DB_URI_PASSWORD / URL_USERINFO):
            // rebuild the match from its capture groups so only the
            // password segment is redacted.
            current = current.replace(regex, (full: string, ...args: unknown[]) => {
                // .replace passes (match, p1, p2, …, offset, string[, groups]).
                // Strip the trailing offset/string/groups; keep capture groups.
                const groups = args.filter((a) => typeof a === "string") as string[];
                hits++;
                return replace(full, ...groups);
            });
        } else {
            const marker = `[REDACTED:${name}]`;
            current = current.replace(regex, () => {
                hits++;
                return marker;
            });
        }
        current += tail;
        if (hits > 0) {
            counts[name] = hits;
            total += hits;
        }
    }

    return { sanitized: current, redactionsByType: counts, totalRedactions: total };
}

/**
 * Scan `input` for well-known secret formats and replace each match with a
 * typed marker like `[REDACTED:ANTHROPIC_API_KEY]`.
 *
 * Routes through the native Rust impl by default — bench shows native at
 * 1.9x–3.4x of TS across input sizes from 1KB to 200KB. Force the TS
 * fallback with `ATLAS_NO_NATIVE_SANITIZER=true` (debugging / missing binary).
 * Native and TS paths are byte-identical (parity battery in
 * `secrets-sanitizer.parity.test.ts`); falls back to TS on any native error.
 */
export function sanitizeSecrets(input: string): SanitizeResult {
    if (!input) {
        return { sanitized: input, redactionsByType: {}, totalRedactions: 0 };
    }

    if (!NATIVE_DISABLED) {
        try {
            const r = nativeSanitizeSecrets(input);
            if (r) {
                return {
                    sanitized: r.sanitized,
                    redactionsByType: JSON.parse(r.redactionsByTypeJson) as Record<string, number>,
                    totalRedactions: r.totalRedactions,
                };
            }
        } catch {
            // Fall through to TS impl on any native error.
        }
    }
    return _sanitizeSecretsTs(input);
}

/**
 * Lightweight `has-any-secret?` probe without mutating the input.
 * Useful for metrics: count how often a tool emits sanitizable
 * content without paying the copy cost.
 */
// Exported for parity-testing only.
export function _containsSecretsTs(input: string): boolean {
    if (!input) return false;
    for (const { regex, endsBy } of PATTERNS) {
        let text = input;
        if (endsBy) {
            const end = lastEnd(input, endsBy);
            if (end < 0) continue;
            text = input.slice(0, end);
        }
        // Reset lastIndex — regexes with the `g` flag carry state
        // across .test() calls, so stateless use needs this reset.
        regex.lastIndex = 0;
        if (regex.test(text)) return true;
    }
    return false;
}

export function containsSecrets(input: string): boolean {
    if (!input) return false;
    if (!NATIVE_DISABLED) {
        try {
            const r = nativeContainsSecrets(input);
            if (r !== null) return r;
        } catch {
            // Fall through to TS.
        }
    }
    return _containsSecretsTs(input);
}
