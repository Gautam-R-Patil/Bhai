// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// ReDoS guard for the protect() pipeline. Before the fixes in
// credential-mask.ts and secrets-sanitizer.ts, maskCredentials("a-".repeat(n/2))
// took 1.5s at 20KB and 9s at 40KB (quadratic): it runs over the whole history
// on every LLM call, every tool result and every console line.
//
// Timings are CPU time (process.cpuUsage), best of 3, so a loaded CI box can't
// fail them; a quadratic regression is 100x over these bounds, not 2x.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { maskCredentials } from "../credential-mask.js";
import { findPii, redactPii } from "../pii-redactor.js";
import { adversarial } from "../redos-inputs.js";
import { _containsSecretsTs, _sanitizeSecretsTs, sanitizeSecrets } from "../secrets-sanitizer.js";

// protect() with its memo off (runs 2 and 3 of cpuMs would be memo hits) and a
// full vault (500 values), so maskKnownValues' one big regex runs every time.
let protect: (s: string) => string;
beforeAll(async () => {
    vi.stubEnv("BHAI_NO_PROTECT_CACHE", "true");
    vi.resetModules();
    const vault = await import("../pii-vault.js");
    vi.unstubAllEnvs();
    const filled = vault.protect(Array.from({ length: 500 }, (_, i) => `OTP: ${200000 + i}`).join("\n"));
    expect(filled).toContain("[OTP_500]");
    protect = (s) => vault.protect(s);
});

const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

function cpuMs(fn: () => unknown): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
        const t0 = process.cpuUsage();
        fn();
        const u = process.cpuUsage(t0);
        best = Math.min(best, (u.user + u.system) / 1000);
    }
    return best;
}

const FNS: Record<string, (s: string) => unknown> = {
    maskCredentials,
    findPii,
    redactPii: (s) => redactPii(s),
    protect: (s) => protect(s),
    protectKnownValue: (s) => protect(`${s} 200123`), // a vault value in it too
    sanitizeSecretsTs: _sanitizeSecretsTs,
    containsSecretsTs: _containsSecretsTs,
};

function slow(n: number, limitMs: number, inputs = adversarial(n)): string[] {
    const out: string[] = [];
    for (const [name, input] of Object.entries(inputs)) {
        for (const [fn, f] of Object.entries(FNS)) {
            const ms = cpuMs(() => f(input));
            if (ms > limitMs) out.push(`${fn}(${name} × ${input.length}) = ${ms.toFixed(1)}ms`);
        }
    }
    return out;
}

describe("protect() pipeline is linear on adversarial input", () => {
    it("every function finishes each 40KB input in <25ms", () => {
        expect(slow(40_000, 25)).toEqual([]);
    });

    it("every function finishes each 200KB input in <120ms", () => {
        expect(slow(200_000, 120)).toEqual([]);
    });

    it("stays linear when the input also holds a key word or a URL (the sweeps can't be skipped)", () => {
        // Each sweep is linear here too (quadratic was seconds).
        const n = 200_000;
        const inputs = {
            "a- + password": `${rep("a-", n)} password=FAKEpw123`,
            "id- + id_token": `${rep("id-", n)} id_token=FAKEtok123`,
            "x. + ://": `${rep("x.", n)}://u:p@h`,
            "a- + ://": `${rep("a-", n)}://u:p@h`, // the scheme lookbehind's one long look back
            "a.:// ×": rep(`${"a.".repeat(500)}://u:`, n),
            "x_id_token=": rep("x_id_token=", n),
            "PEM BEGIN× + END": `-----END PRIVATE KEY-----\n${rep("-----BEGIN PRIVATE KEY-----\n", n)}`,
        };
        expect(slow(n, 400, inputs)).toEqual([]);
    });
});

describe("linear time costs no real credential (no length bounds)", () => {
    it("key names of any length are still masked", () => {
        for (const t of [
            "my_service_name_api_key=FAKEsecret123",
            "MY_SERVICE_NAME_API_KEY=FAKEsecret123",
            `${"a".repeat(200)}_service_api_key=FAKEsecret123`,
            `my_${"x".repeat(70)}_password=FAKEsecret123`,
            `${"x-".repeat(100)}password=FAKEsecret123`,
            "acme-prod-eu-west-1-billing-client-secret: FAKEsecret1234567",
            "google_oauth_web_client_id_token=FAKEsecret123",
            "a1_b2_c3_d4_e5_f6_g7_h8_i9_id_token=FAKEsecret123", // 9 segments
            `${"s1-".repeat(40)}id_token=FAKEsecret123`,
        ]) {
            expect(maskCredentials(t), t).not.toContain("FAKEsecret");
        }
        expect(maskCredentials("valid_token=FAKEsecret123")).toContain("FAKEsecret"); // not "val" + "id_token"
        expect(maskCredentials("xid_token=FAKEsecret123")).toContain("FAKEsecret");
    });

    it("userinfo passwords behind a scheme of any length are redacted (TS and the default native path)", () => {
        const t = "abcdefghijklmnopqrstuvwxyzabcdefgh://admin:S3cretPassw0rd@db.internal:5432/x";
        const want = "abcdefghijklmnopqrstuvwxyzabcdefgh://admin:[REDACTED:URL_USERINFO]@db.internal:5432/x";
        expect(_sanitizeSecretsTs(t).sanitized).toBe(want);
        expect(sanitizeSecrets(t).sanitized).toBe(want);
        expect(_sanitizeSecretsTs(`x ${"a".repeat(300)}://u:FAKEpw99@h`).sanitized).toContain("[REDACTED:URL_USERINFO]");
    });

    it("URLs with long schemes are still parked whole, and userinfo passwords still redacted", () => {
        const url = "chrome-extension://abcdefghijklmnop/popup.html?password=keep-me-123";
        expect(maskCredentials(`open ${url} now`)).toBe(`open ${url} now`);
        expect(_sanitizeSecretsTs("git+ssh://deploy:FAKEpw99@github.com/x").sanitized).toBe(
            "git+ssh://deploy:[REDACTED:URL_USERINFO]@github.com/x",
        );
        expect(_sanitizeSecretsTs("x postgres://u:FAKEpw99@db/app").sanitized).toBe(
            "x postgres://u:[REDACTED:DB_URI_PASSWORD]@db/app",
        );
    });

    it("PEM blocks are masked whatever stray BEGIN lines surround them", () => {
        const pem = "-----BEGIN PRIVATE KEY-----\nFAKEMIIBVQIBADAN\n-----END PRIVATE KEY-----";
        for (const t of [pem, `-----BEGIN PRIVATE KEY-----\n${pem}\n-----BEGIN PRIVATE KEY-----\ntail`]) {
            expect(maskCredentials(t)).not.toContain("FAKEMIIBVQIBADAN");
            expect(_sanitizeSecretsTs(t).sanitized).not.toContain("FAKEMIIBVQIBADAN");
            expect(_containsSecretsTs(t)).toBe(true);
        }
        expect(_containsSecretsTs("-----BEGIN PRIVATE KEY-----\nno end")).toBe(false);
        // END lines that share their dashes: the last one still bounds the pass.
        const shared = "-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----END PRIVATE KEY-----";
        expect(_sanitizeSecretsTs(shared).sanitized).toBe("[REDACTED:PRIVATE_KEY_PEM]");
        expect(_containsSecretsTs(shared)).toBe(true);
    });
});
