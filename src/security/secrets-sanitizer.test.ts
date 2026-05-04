// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { sanitizeSecrets, containsSecrets } from "./secrets-sanitizer.js";

describe("sanitizeSecrets", () => {
    describe("Anthropic API keys", () => {
        it("redacts sk-ant-api01 keys", () => {
            const input =
                "ANTHROPIC_API_KEY=sk-ant-api03-AbcDef1234567890AbcDef1234567890AbcDef1234567890AbcDef1234567890AbcDef1234567890AbC_12-XyzAbc";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(sanitized).not.toContain("sk-ant-api03-");
            expect(sanitized).toContain("[REDACTED:");
            // Either the env-var matcher or the anthropic matcher will fire first.
            const anyRedaction =
                (redactionsByType.ANTHROPIC_API_KEY ?? 0) + (redactionsByType.ENV_VAR_SECRET ?? 0);
            expect(anyRedaction).toBeGreaterThan(0);
        });

        it("redacts sk-ant-sid admin keys even without env-var context", () => {
            const input = "token: sk-ant-sid01-" + "a".repeat(90) + " end";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:ANTHROPIC_API_KEY]");
            expect(redactionsByType.ANTHROPIC_API_KEY).toEqual(1);
        });
    });

    describe("OpenAI API keys", () => {
        it("redacts sk-proj-... project keys", () => {
            const input = "key is sk-proj-" + "A".repeat(80) + " ok";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:OPENAI_API_KEY]");
            expect(redactionsByType.OPENAI_API_KEY).toEqual(1);
        });

        it("redacts legacy sk-<48 char> keys", () => {
            const input = "old key: sk-" + "A".repeat(48) + " end";
            const { sanitized } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:OPENAI_API_KEY]");
            expect(sanitized).not.toContain("sk-AAAAA");
        });

        it("does NOT match sk_live_ (stripe) as openai", () => {
            // sk_live_ has underscore, openai regex requires dash after sk.
            const input = "stripe: sk_live_abcd1234567890abcd1234567890 end";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:STRIPE_LIVE_KEY]");
            expect(redactionsByType.STRIPE_LIVE_KEY).toEqual(1);
            expect(redactionsByType.OPENAI_API_KEY).toBeUndefined();
        });
    });

    describe("AWS keys", () => {
        it("redacts AKIA access keys", () => {
            const input = "aws key AKIAIOSFODNN7EXAMPLE in log";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:AWS_ACCESS_KEY]");
            expect(redactionsByType.AWS_ACCESS_KEY).toEqual(1);
        });

        it("redacts ASIA temporary access keys", () => {
            const input = "temp: ASIAY34FZKBOKMUTVV7A";
            const { sanitized } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:AWS_ACCESS_KEY]");
        });

        it("does not match arbitrary 20-char uppercase strings", () => {
            const input = "SOMEOTHERSTRING12345 is fine";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("Stripe keys", () => {
        it("redacts sk_live_, pk_live_, rk_live_", () => {
            const input =
                "live sk_live_1234567890abcdef12345678 and pk_live_abc123abc123abc123abc123";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.STRIPE_LIVE_KEY).toEqual(2);
        });

        it("redacts sk_test_ separately from live keys", () => {
            const input = "sk_test_1234567890abcdef12345678 in fixtures";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.STRIPE_TEST_KEY).toEqual(1);
            expect(redactionsByType.STRIPE_LIVE_KEY).toBeUndefined();
        });
    });

    describe("GitHub tokens", () => {
        it("redacts ghp_ classic tokens", () => {
            const input = "export TOKEN=ghp_" + "A".repeat(36) + " and done";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(sanitized).toContain("[REDACTED:GITHUB_TOKEN]");
            expect(redactionsByType.GITHUB_TOKEN).toEqual(1);
        });

        it("redacts all 5 prefix variants", () => {
            const base = "A".repeat(36);
            const input = `ghp_${base} gho_${base} ghu_${base} ghs_${base} ghr_${base}`;
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.GITHUB_TOKEN).toEqual(5);
        });

        it("redacts github_pat fine-grained tokens", () => {
            const input =
                "pat: github_pat_11ABCDEFG0123456789ABC_" + "A".repeat(59);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.GITHUB_FINE_GRAINED_TOKEN).toEqual(1);
        });
    });

    describe("Google API keys", () => {
        it("redacts AIza-prefixed keys (exactly 39 chars total = AIza + 35)", () => {
            // Real Google API keys are AIza + exactly 35 chars = 39 chars.
            const input = "key=AIza" + "X".repeat(35) + " end";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.GOOGLE_API_KEY).toEqual(1);
            expect(sanitized).toContain("[REDACTED:GOOGLE_API_KEY]");
        });

        it("does not match AIza + shorter-than-35-char tail", () => {
            const input = "AIza" + "X".repeat(20);
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("Slack tokens", () => {
        it("redacts xoxb bot tokens", () => {
            const input = "xoxb-1234-567890-abcdefghijklmno";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.SLACK_TOKEN).toEqual(1);
        });
    });

    describe("Bearer tokens", () => {
        it("redacts Bearer <token>", () => {
            const input = 'Authorization: Bearer abc123def456ghi789jkl012mno345pqr678';
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.BEARER_TOKEN).toEqual(1);
            expect(sanitized).toContain("Authorization: [REDACTED:BEARER_TOKEN]");
        });

        it("redacts case-insensitive bearer keyword", () => {
            const input = "bearer abc123def456ghi789jkl012mno345";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.BEARER_TOKEN).toEqual(1);
        });

        it("does not match short Bearer tokens (< 20 chars)", () => {
            const input = "Bearer abc123";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("JWTs", () => {
        it("redacts a standard 3-segment JWT", () => {
            const jwt =
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
            const input = `token=${jwt} done`;
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.JWT).toEqual(1);
            expect(sanitized).toContain("[REDACTED:JWT]");
        });

        it("redacts multiple JWTs in one string", () => {
            const jwt = "eyJabcdefg.eyJpayload12.signaturehash";
            const { redactionsByType } = sanitizeSecrets(`${jwt} and ${jwt}`);
            expect(redactionsByType.JWT).toEqual(2);
        });
    });

    describe("PEM private keys", () => {
        it("redacts a plain PRIVATE KEY block including body + frame", () => {
            const input = [
                "before",
                "-----BEGIN PRIVATE KEY-----",
                "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...",
                "-----END PRIVATE KEY-----",
                "after",
            ].join("\n");
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.PRIVATE_KEY_PEM).toEqual(1);
            expect(sanitized).not.toContain("MIIEvQ");
            expect(sanitized).not.toContain("BEGIN PRIVATE KEY");
            expect(sanitized).toContain("before\n[REDACTED:PRIVATE_KEY_PEM]\nafter");
        });

        it("handles RSA PRIVATE KEY variant", () => {
            const input =
                "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.PRIVATE_KEY_PEM).toEqual(1);
        });

        it("handles OPENSSH variant", () => {
            const input =
                "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.PRIVATE_KEY_PEM).toEqual(1);
        });

        it("redacts two adjacent keys separately (lazy body)", () => {
            const key =
                "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----";
            const { redactionsByType } = sanitizeSecrets(`${key}\n${key}`);
            expect(redactionsByType.PRIVATE_KEY_PEM).toEqual(2);
        });
    });

    describe("Env-var assignments", () => {
        it("redacts TOKEN=value when value is non-trivial", () => {
            const input = "export GITHUB_TOKEN=secretvalue1234567890abc";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            // Either env-var matcher or (if value matches a prefix) the token matcher.
            expect(redactionsByType.ENV_VAR_SECRET ?? 0).toBeGreaterThanOrEqual(1);
            expect(sanitized).toContain("[REDACTED:");
        });

        it("redacts SECRET and PASSWORD keys", () => {
            const input = 'DB_PASSWORD="mysecretpassword" CLIENT_SECRET=abc123xyz456';
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.ENV_VAR_SECRET).toEqual(2);
        });

        it("does NOT redact NODE_ENV=production (not a sensitive name)", () => {
            const input = "NODE_ENV=production DEBUG=true VERBOSE=1";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });

        it("does NOT redact secrets with value < 8 chars (placeholder guard)", () => {
            const input = "TOKEN= SECRET='' PASSWORD=abc";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("no false positives on benign text", () => {
        it("passes through ordinary command output", () => {
            const input = [
                "total 48",
                "drwxr-xr-x  5 user  staff   160 Jan  1 12:00 src",
                "-rw-r--r--  1 user  staff  2048 Jan  1 12:00 README.md",
                "/home/user/project/node_modules",
                "error: command not found: foobar",
            ].join("\n");
            const { totalRedactions, sanitized } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
            expect(sanitized).toEqual(input);
        });

        it("passes through git commit hashes unchanged", () => {
            const input = "commit a0ac7970e3c8f9b2d4e6 at HEAD";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });

        it("passes through UUIDs unchanged", () => {
            const input = "id=550e8400-e29b-41d4-a716-446655440000";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("edge cases", () => {
        it("returns empty input unchanged without allocating", () => {
            const result = sanitizeSecrets("");
            expect(result.sanitized).toEqual("");
            expect(result.totalRedactions).toEqual(0);
            expect(Object.keys(result.redactionsByType)).toHaveLength(0);
        });

        it("handles multiple secret types in one string", () => {
            const input = [
                "aws: AKIAIOSFODNN7EXAMPLE",
                "github: ghp_" + "A".repeat(36),
                "stripe: sk_live_" + "A".repeat(24),
            ].join("\n");
            const { redactionsByType, totalRedactions } = sanitizeSecrets(input);
            expect(redactionsByType.AWS_ACCESS_KEY).toEqual(1);
            expect(redactionsByType.GITHUB_TOKEN).toEqual(1);
            expect(redactionsByType.STRIPE_LIVE_KEY).toEqual(1);
            expect(totalRedactions).toEqual(3);
        });

        it("redaction markers use a consistent format", () => {
            const { sanitized } = sanitizeSecrets("AKIAIOSFODNN7EXAMPLE");
            expect(sanitized).toMatch(/^\[REDACTED:[A-Z_]+\]$/);
        });

        it("does not mutate the input string (pure function)", () => {
            const input = "AKIAIOSFODNN7EXAMPLE";
            const original = input;
            sanitizeSecrets(input);
            // Strings are immutable in JS but validate via identity of the binding
            expect(input).toEqual(original);
        });
    });
});

describe("containsSecrets", () => {
    it("returns true when any pattern matches", () => {
        expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    });

    it("returns false for benign text", () => {
        expect(containsSecrets("hello world\nfoo bar\nbaz")).toBe(false);
    });

    it("returns false for empty input", () => {
        expect(containsSecrets("")).toBe(false);
    });

    it("is idempotent across repeated calls (no g-flag state leak)", () => {
        const input = "AKIAIOSFODNN7EXAMPLE";
        // Two calls in a row — the second would return false if we forgot
        // to reset regex.lastIndex (since g-flag regex carries state).
        expect(containsSecrets(input)).toBe(true);
        expect(containsSecrets(input)).toBe(true);
    });
});
