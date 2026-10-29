// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

        it("redacts Slack webhook URLs", () => {
            const input =
                "hook: https://hooks.slack.com/services/T12345678/B98765432/abcdefghijklmnopqrstuvwx";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.SLACK_WEBHOOK_URL).toEqual(1);
            expect(sanitized).toContain("[REDACTED:SLACK_WEBHOOK_URL]");
        });
    });

    describe("Discord tokens", () => {
        it("redacts Discord bot tokens (3-part format)", () => {
            // Mx{23-27}.y{6-7}.z{27+}
            const token =
                "MTE1NjU3MTIxMjEyMTIxMjEyMQ.Gabcde.0123456789abcdefghijklmnopqrstuvwxyz1";
            const { redactionsByType } = sanitizeSecrets(`bot: ${token}`);
            expect(redactionsByType.DISCORD_BOT_TOKEN).toEqual(1);
        });

        it("redacts Discord webhook URLs", () => {
            const input =
                "webhook: https://discord.com/api/webhooks/12345678901234567890/" +
                "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyzabcdefg";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.DISCORD_WEBHOOK_URL).toEqual(1);
        });

        it("redacts Discord webhook URLs on discordapp.com domain too", () => {
            const input =
                "https://discordapp.com/api/webhooks/12345678901234567890/" +
                "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyzabcdefg";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.DISCORD_WEBHOOK_URL).toEqual(1);
        });
    });

    describe("Twilio credentials", () => {
        it("redacts Twilio Account SID (AC + 32 hex)", () => {
            const input = "sid: AC" + "a".repeat(32);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.TWILIO_ACCOUNT_SID).toEqual(1);
        });

        it("redacts Twilio API key SID (SK + 32 hex)", () => {
            const input = "key: SK" + "b".repeat(32);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.TWILIO_AUTH_TOKEN).toEqual(1);
        });

        it("does NOT match AC followed by non-hex", () => {
            // Hex is [a-f0-9]; uppercase G-Z excluded.
            expect(sanitizeSecrets("ACGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG").totalRedactions).toEqual(
                0,
            );
        });
    });

    describe("SendGrid API keys", () => {
        it("redacts SG.<22>.<43> format", () => {
            const input =
                "sg: SG." + "a".repeat(22) + "." + "b".repeat(43);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.SENDGRID_API_KEY).toEqual(1);
        });
    });

    describe("Mapbox tokens", () => {
        it("redacts pk.eyJ... public tokens", () => {
            const input = "pk.eyJabcdefg.signaturepart";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.MAPBOX_TOKEN).toEqual(1);
        });

        it("redacts sk.eyJ... secret tokens", () => {
            const input = "sk.eyJpayload.signature";
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.MAPBOX_TOKEN).toEqual(1);
        });

        it("does NOT confuse a JWT (3 segments) with a Mapbox token (2 segments)", () => {
            // JWT has 3 base64url segments starting with eyJ.
            // Mapbox has pk./sk. + 2 segments.
            // The Mapbox pattern only fires on 2-segment pk./sk. inputs.
            const jwt =
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxw";
            const { redactionsByType } = sanitizeSecrets(jwt);
            expect(redactionsByType.JWT).toEqual(1);
            expect(redactionsByType.MAPBOX_TOKEN).toBeUndefined();
        });
    });

    describe("NPM tokens", () => {
        it("redacts npm_ prefixed tokens", () => {
            const input = "token: npm_" + "A".repeat(36);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.NPM_TOKEN).toEqual(1);
        });
    });

    describe("Notion secrets", () => {
        it("redacts old-style secret_ prefix", () => {
            const input = "key: secret_" + "a".repeat(43);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.NOTION_SECRET).toEqual(1);
        });

        it("redacts new-style ntn_ prefix", () => {
            const input = "key: ntn_" + "a".repeat(45);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.NOTION_SECRET).toEqual(1);
        });
    });

    describe("Square access tokens", () => {
        it("redacts EAAA... tokens", () => {
            const input = "EAAA" + "a".repeat(60);
            const { redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.SQUARE_ACCESS_TOKEN).toEqual(1);
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

    describe("DB connection-string passwords", () => {
        it("redacts ONLY the password in a postgres URI, keeping scheme/user/host", () => {
            const input = "postgres://appuser:s3cr3tPw@db.internal:5432/mydb";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.DB_URI_PASSWORD).toEqual(1);
            expect(sanitized).toEqual(
                "postgres://appuser:[REDACTED:DB_URI_PASSWORD]@db.internal:5432/mydb",
            );
            expect(sanitized).not.toContain("s3cr3tPw");
        });

        it("redacts mysql, mongodb+srv, redis, and amqps schemes", () => {
            for (const uri of [
                "mysql://root:rootpass123@127.0.0.1:3306/app",
                "mongodb+srv://svc:M0ng0Secret@cluster0.abcde.mongodb.net/test",
                "redis://default:redisPass99@cache.host:6379",
                "amqps://guest:rabbitpw1234@broker.host:5671/vhost",
            ]) {
                const { redactionsByType } = sanitizeSecrets(uri);
                expect(redactionsByType.DB_URI_PASSWORD).toEqual(1);
            }
        });

        it("does NOT redact a DB URI with no password (user@host)", () => {
            const input = "postgres://appuser@db.internal:5432/mydb";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("Generic URL userinfo", () => {
        it("redacts ONLY the password in an https userinfo URL", () => {
            const input = "fetch https://alice:tok3nValue@example.com/path ok";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.URL_USERINFO).toEqual(1);
            expect(sanitized).toContain("https://alice:[REDACTED:URL_USERINFO]@example.com/path");
            expect(sanitized).not.toContain("tok3nValue");
        });

        it("redacts DB password as DB_URI_PASSWORD and http one as URL_USERINFO in one string", () => {
            const input =
                "db postgres://u:dbSecretPw@h/db and api https://svc:apiTok123@api.example.com/v1";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.DB_URI_PASSWORD).toEqual(1);
            expect(redactionsByType.URL_USERINFO).toEqual(1);
            expect(sanitized).toContain("postgres://u:[REDACTED:DB_URI_PASSWORD]@h/db");
            expect(sanitized).toContain("https://svc:[REDACTED:URL_USERINFO]@api.example.com/v1");
        });

        it("does NOT re-redact an already-redacted DB password (idempotent guard)", () => {
            const input = "postgres://u:[REDACTED:DB_URI_PASSWORD]@h/db";
            const { sanitized, redactionsByType } = sanitizeSecrets(input);
            expect(redactionsByType.URL_USERINFO).toBeUndefined();
            expect(sanitized).toEqual(input);
        });

        it("does NOT match a bare email (no scheme://)", () => {
            const input = "contact user@host.com for info";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });

        it("does NOT match a URL with no userinfo password", () => {
            const input = "open https://example.com/page now";
            const { totalRedactions } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
        });
    });

    describe("Env-var DB/DSN suffix expansion", () => {
        it("redacts DATABASE_URL= assignments", () => {
            const input = "DATABASE_URL=postgres://u:longpasswordvalue@host:5432/db";
            const { sanitized } = sanitizeSecrets(input);
            // DB_URI_PASSWORD fires first, then ENV_VAR_SECRET wraps the whole value.
            expect(sanitized).toContain("[REDACTED:");
            expect(sanitized).not.toContain("longpasswordvalue");
        });

        it("redacts CONNECTION_STRING= and DSN= assignments", () => {
            const conn = sanitizeSecrets(
                'CONNECTION_STRING="Server=db;Database=app;User Id=sa;Password=verysecret123;"',
            );
            expect(conn.redactionsByType.ENV_VAR_SECRET).toEqual(1);
            const dsn = sanitizeSecrets("DSN=postgresql://svc:dsnPasswordHere@host/db");
            expect(dsn.sanitized).not.toContain("dsnPasswordHere");
            expect(dsn.totalRedactions).toBeGreaterThan(0);
        });

        it("does NOT redact a benign SITE_URL=https://host/page (no userinfo)", () => {
            const input = "SITE_URL=https://example.com/page";
            const { totalRedactions, sanitized } = sanitizeSecrets(input);
            expect(totalRedactions).toEqual(0);
            expect(sanitized).toEqual(input);
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
