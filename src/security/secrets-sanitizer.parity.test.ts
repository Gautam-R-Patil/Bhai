// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Phase 1.1 parity test — Rust sanitizer vs TS sanitizer, byte-for-byte equal.
//
// Compares the production TS impl (`_sanitizeSecretsTs`) directly against the
// native FFI binding (`nativeSanitizeSecrets`) on a battery of reference
// inputs covering every pattern. If these diverge, the wrapper's native path
// would emit different output than the fallback — a silent correctness bug.

import { describe, expect, it } from "vitest";
import { isNativeAvailable, nativeContainsSecrets, nativeSanitizeSecrets } from "../native/index.js";
import { _containsSecretsTs, _sanitizeSecretsTs } from "./secrets-sanitizer.js";

const REFERENCE_INPUTS: Array<{ name: string; input: string }> = [
    { name: "empty", input: "" },
    { name: "benign-short", input: "hello world" },
    {
        name: "benign-long",
        input: [
            "total 48",
            "drwxr-xr-x  5 user  staff   160 Jan  1 12:00 src",
            "-rw-r--r--  1 user  staff  2048 Jan  1 12:00 README.md",
            "/home/user/project/node_modules",
            "error: command not found: foobar",
            "commit a0ac7970e3c8f9b2d4e6 at HEAD",
            "id=550e8400-e29b-41d4-a716-446655440000",
        ].join("\n"),
    },
    { name: "aws-key", input: "aws key AKIAIOSFODNN7EXAMPLE in log" },
    { name: "openai-key", input: `key is sk-proj-${"A".repeat(80)} ok` },
    { name: "openrouter-key", input: `key sk-or-v1-${"a".repeat(64)} end` },
    { name: "github-token", input: `export TOKEN=ghp_${"A".repeat(36)} and done` },
    { name: "github-fine-grained", input: `pat: github_pat_11ABCDEFG0123456789ABC_${"A".repeat(59)}` },
    {
        name: "stripe-multiple",
        input: `live sk_live_${"a".repeat(24)} and pk_live_${"b".repeat(24)}`,
    },
    { name: "stripe-test", input: `sk_test_${"1".repeat(24)} in fixtures` },
    { name: "anthropic-key", input: `token: sk-ant-sid01-${"a".repeat(90)} end` },
    { name: "google-api-key", input: `key=AIza${"X".repeat(35)} end` },
    {
        name: "slack-webhook",
        input: "hook: https://hooks.slack.com/services/T12345678/B98765432/abcdefghijklmnopqrstuvwx",
    },
    { name: "slack-token", input: "xoxb-1234-567890-abcdefghijklmno" },
    {
        name: "discord-bot-token",
        input: "bot: MTE1NjU3MTIxMjEyMTIxMjEyMQ.Gabcde.0123456789abcdefghijklmnopqrstuvwxyz1",
    },
    { name: "twilio-sid", input: `sid: AC${"a".repeat(32)}` },
    { name: "twilio-token", input: `key: SK${"b".repeat(32)}` },
    { name: "sendgrid", input: `sg: SG.${"a".repeat(22)}.${"b".repeat(43)}` },
    { name: "mapbox-pk", input: "pk.eyJabcdefg.signaturepart" },
    { name: "npm-token", input: `token: npm_${"A".repeat(36)}` },
    { name: "notion-old", input: `key: secret_${"a".repeat(43)}` },
    { name: "notion-new", input: `key: ntn_${"a".repeat(45)}` },
    { name: "square", input: `EAAA${"a".repeat(60)}` },
    {
        name: "jwt",
        input: "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c done",
    },
    {
        name: "bearer",
        input: "Authorization: Bearer abc123def456ghi789jkl012mno345pqr678",
    },
    {
        name: "pem-private-key",
        input: [
            "before",
            "-----BEGIN PRIVATE KEY-----",
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...",
            "-----END PRIVATE KEY-----",
            "after",
        ].join("\n"),
    },
    { name: "pem-rsa", input: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----" },
    {
        name: "env-var-secret",
        input: 'DB_PASSWORD="mysecretpassword" CLIENT_SECRET=abc123xyz456',
    },
    {
        name: "env-var-already-redacted (lookahead guard, unquoted)",
        input: "TOKEN=[REDACTED:GITHUB_TOKEN] PASSWORD=actualsecret12345",
    },
    // Pass 1 redacts `ghp_...` inside the quotes, leaving
    // `PASSWORD="[REDACTED:GITHUB_TOKEN]"`. The TS lookahead `(?!\[REDACTED:)`
    // fires at the position right after `=`, sees `"` (not `[`), passes —
    // and the quoted-value alternative re-redacts the whole quoted span as
    // ENV_VAR_SECRET. The Rust post-filter must NOT block this; only the
    // unquoted `[REDACTED:` immediate-after-`=` form should be skipped.
    {
        name: "env-var-quoted-redacted (double-quoted, lookahead passes)",
        input: `PASSWORD="ghp_${"A".repeat(36)}"`,
    },
    {
        name: "env-var-quoted-redacted (single-quoted, lookahead passes)",
        input: `SECRET='ghp_${"B".repeat(36)}'`,
    },
    {
        name: "env-var-direct-quoted-redacted (already-redacted inside quotes)",
        input: 'SECRET="[REDACTED:GITHUB_TOKEN]"',
    },
    {
        name: "multi-secret",
        input: ["aws: AKIAIOSFODNN7EXAMPLE", `github: ghp_${"A".repeat(36)}`, `stripe: sk_live_${"A".repeat(24)}`].join(
            "\n",
        ),
    },
    {
        name: "long-mixed-input (above FFI crossover)",
        input:
            "Lorem ipsum dolor sit amet ".repeat(20) +
            "AKIAIOSFODNN7EXAMPLE " +
            "consectetur adipiscing elit ".repeat(20) +
            `ghp_${"A".repeat(36)} ` +
            "sed do eiusmod tempor incididunt ".repeat(20),
    },
    // Pattern-ordering collisions: confirms the FFI preserves the precedence
    // ordering between competing patterns. If a future refactor reorders the
    // Rust PATTERNS vec but not the TS PATTERNS array (or vice versa), these
    // tests catch the divergence.
    {
        // pk.eyJ... is also a syntactic JWT (3 base64url segments after eyJ).
        // MAPBOX_TOKEN runs BEFORE JWT in the table — confirm via parity.
        name: "ordering: mapbox token shadows JWT match",
        input: `pk.eyJ${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`,
    },
    {
        // sk-ant-... could in theory match OPENAI_API_KEY's `\bsk-...` prefix.
        // ANTHROPIC_API_KEY runs BEFORE OPENAI_API_KEY — both inputs in one
        // string forces the table to demonstrate ordering.
        name: "ordering: anthropic and openai keys coexist",
        input: `anthropic: sk-ant-api01-${"a".repeat(80)} and openai: sk-proj-${"b".repeat(80)} end`,
    },
    {
        // The canonical contained-pattern case: BEARER_TOKEN's alphabet
        // includes every char of a JWT body, so a naïve single-alternation
        // approach would let BEARER_TOKEN swallow the entire JWT span. TS
        // runs JWT (index 21) before BEARER_TOKEN (index 22), redacts the
        // JWT first, and BEARER_TOKEN then fails because `[` is not in its
        // alphabet. Expected output: `Authorization: Bearer [REDACTED:JWT]`.
        // This fixture was added after a real bug where the Rust port used
        // a single alternation regex and produced `[REDACTED:BEARER_TOKEN]`
        // — see secrets_sanitizer.rs module docstring for the back-story.
        name: "ordering: bearer-wrapped JWT redacts as JWT not BEARER",
        input:
            "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    },
];

describe("Secrets-sanitizer Rust ↔ TS parity (Phase 1.1)", () => {
    if (!isNativeAvailable()) {
        it.skip("native module unavailable — skipping parity tests", () => {});
        return;
    }

    for (const { name, input } of REFERENCE_INPUTS) {
        it(`sanitize: ${name} — byte-identical`, () => {
            const ts = _sanitizeSecretsTs(input);
            const raw = nativeSanitizeSecrets(input);
            expect(raw, "native call returned null").not.toBeNull();
            const native = {
                sanitized: raw!.sanitized,
                redactionsByType: JSON.parse(raw!.redactionsByTypeJson) as Record<string, number>,
                totalRedactions: raw!.totalRedactions,
            };
            expect(native.sanitized).toBe(ts.sanitized);
            expect(native.totalRedactions).toBe(ts.totalRedactions);
            expect(native.redactionsByType).toEqual(ts.redactionsByType);
        });
    }

    it("containsSecrets: TS and native agree on positive cases", () => {
        const positives = [
            "AKIAIOSFODNN7EXAMPLE",
            `ghp_${"A".repeat(36)}`,
            "Authorization: Bearer abc123def456ghi789jkl012mno345",
        ];
        for (const p of positives) {
            expect(nativeContainsSecrets(p), `native missed: ${p}`).toBe(true);
            expect(_containsSecretsTs(p), `ts missed: ${p}`).toBe(true);
        }
    });

    it("containsSecrets: TS and native agree on negative cases", () => {
        const negatives = [
            "",
            "hello world",
            "foo bar baz",
            "NODE_ENV=production DEBUG=true",
            "commit a0ac7970e3c8f9b2d4e6 at HEAD",
        ];
        for (const n of negatives) {
            expect(nativeContainsSecrets(n), `native false-positive: ${n}`).toBe(false);
            expect(_containsSecretsTs(n), `ts false-positive: ${n}`).toBe(false);
        }
    });
});
