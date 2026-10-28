// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Parity: native/src/pii_protect.rs vs the TS maskCredentials / findPii,
// byte for byte. Corpus: every string literal in credential-mask.test.ts,
// pii-redactor.test.ts and pii-vault.test.ts, pii-redactor.test.ts's seeded
// transcripts, the ReDoS adversarial set, and 5,000 seeded-random strings built
// from the patterns' own fragments plus digits, punctuation, Devanagari, emoji,
// non-ASCII whitespace and lone surrogates. Skipped when the binary lacks the
// exports (an old build, or a platform without one).

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeFindPii, nativeMaskCredentials } from "../native/index.js";
import { _maskCredentialsTs } from "./credential-mask.js";
import { _findPiiTs, luhnValid, verhoeffValid } from "./pii-redactor.js";
import { adversarial } from "./redos-inputs.js";

const HAS_NATIVE = (() => {
    try {
        return nativeMaskCredentials("password=x") !== null && nativeFindPii("x") !== null;
    } catch {
        return false;
    }
})();

/** Every string literal (cooked) in a source file. */
function literals(file: string): string[] {
    const src = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest);
    const out: string[] = [];
    const walk = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
        if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
        ts.forEachChild(n, walk);
    };
    walk(src);
    return out;
}

/** pii-redactor.test.ts's transcripts (same seed, same generator). */
function transcripts(count: number): string[] {
    let seed = 42;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join("");
    const card = () => {
        const base = (pick(["4", "51", "52", "53", "60", "65", "37"]) + digits(14)).slice(0, 15);
        const n = base + ([..."0123456789"].find((d) => luhnValid(base + d)) as string);
        return pick([n, n.replace(/(\d{4})(?=\d)/g, "$1 "), n.replace(/(\d{4})(?=\d)/g, "$1-")]);
    };
    const aadhaar = () => {
        const base = String(2 + Math.floor(rand() * 8)) + digits(10);
        const n = base + ([..."0123456789"].find((d) => verhoeffValid(base + d)) as string);
        return pick([n, `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`, `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`]);
    };
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        const c = card();
        const a = aadhaar();
        const u = `${pick(["rahul", "priya.s", "dheeraj_k", "amit92", "neha.m"])}${digits(2)}@${pick(["okicici", "oksbi", "ybl", "paytm", "axl", "ibl", "okhdfcbank"])}`;
        const o = digits(pick([4, 6, 6, 8]));
        const k = Array.from({ length: 24 }, () => pick([..."abcdef0123456789ABCDEFxyz"])).join("");
        out.push(
            [
                pick([`Pay with my card ${c}, expiry 08/29.`, `Card number: ${c}`, `use ${c} for the order`]),
                pick([`My Aadhaar is ${a}.`, `Aadhaar no ${a} for KYC`, `UID: ${a}`]),
                pick([`Send ₹450 to ${u}`, `UPI ID ${u}`, `pay ${u} please`]),
                pick([`Your OTP is ${o}. Do not share it.`, `${o} is your verification code for Swiggy`, `OTP: ${o}`, `Use one-time password ${o} to log in`]),
                pick([`Cookie: sessionid=${k}; theme=dark`, `Set-Cookie: auth_token=${k}; Path=/; HttpOnly`, `document.cookie = "csrftoken=${k}"`]),
            ]
                .sort(() => rand() - 0.5)
                .join("\n"),
        );
    }
    return out;
}

const FRAGMENTS = [
    // credential-mask anchors
    "password", "Password", "passwd", "api_key", "API-KEY", "apikey", "client_secret", "access_token", "id_token", "my_service_",
    "auth-token", "credentials", "totp_seed", "token", "secret", "=", ": ", ":", "=>", " = ", "'", '"', "`", "\\\"",
    "Authorization", "authorization: ", "Proxy-Authorization", "Bearer ", "bearer ", "Basic ", "Token ", "Digest ", "AWS4-HMAC-SHA256 ",
    "response=", 'response="', "nonce=", "cnonce=", "Signature=", "cookie", "Cookie: ", "cookie=", "Set-Cookie: ", "set-cookie:",
    "sid=", "; ", ", ", ", then retry", "Expires=Wed, 21 Oct", "sk-", "sk-proj-", "sk-ant-api03-", "ghp_", "github_pat_", "xoxb-",
    "AKIA", "ASIA", "AIza", "glpat-", "hf_", "npm_", "SG.", "sk_live_", "shpat_", "eyJ", "eyJhbGciOiJIUzI1NiJ9", ".",
    "-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----END PRIVATE KEY-----", "\n", "\r\n", "\t",
    "https://", "http://x.io/a?token=", "chrome-extension://", "://", "user:pw@", "\u0000U0\u0000", "\u0000U7\u0000", "[redacted]",
    "ZmFrZTpmYWtlcGFzcw==", "dTpw", "abc123def456ghi789", "FAKEtok3nAbc123xyz", "getKey(config)", "process.env.X", "$HOME", "/usr/bin",
    "true", "required", "null", "****", "(", ")", "{", "}", "[", "]", "/", "~", "+", "_", "-", "@", " ",
    // findPii anchors
    "4111 1111 1111 1111", "4111111111111111", "378282246310005", "5555-5555-5555-4444", "card ", "visa ", "cvv ", "expiry ",
    "2341 2341 2346", "234123412346", "9876543210", "@ybl", "@okaxis", "@oksbi", "@waxyz", "priya.s", "rahul42", "OTP", "otp: ",
    "one-time password ", "verification code ", "2fa code ", " is your OTP", " is the verification code", "is your", "document.cookie='",
    "document.cookie = \"", "file_", ".png", "/status/", "#", "$", "%20", " ", " ", "﻿", "\u0085", "　",
    "पासवर्ड", "कुकी", "₹", "🔑", "😀", "\ud83d", "\ude00", "é", "ſ", "K",
];

function randomCorpus(count: number): string[] {
    let x = 0x2545f491;
    const rnd = () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) / 2 ** 32;
    };
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        let s = "";
        const parts = 1 + Math.floor(rnd() * 40);
        for (let p = 0; p < parts; p++) {
            const r = rnd();
            if (r < 0.55) s += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)];
            else if (r < 0.75) s += String(Math.floor(rnd() * 1e9)).slice(0, 1 + Math.floor(rnd() * 9));
            else if (r < 0.9) s += "ABCDEFabcdef0123456789+/=._-".slice(Math.floor(rnd() * 10), 10 + Math.floor(rnd() * 18));
            else s += "-_.:=/@ ;,\"'".charAt(Math.floor(rnd() * 12));
        }
        out.push(s);
    }
    return out;
}

/** Bounded counts ({1,255}, {0,500}, {1,1000}) are UTF-16 units in JS: probe each edge, emoji (two units) included. */
function edges(): string[] {
    const out: string[] = [];
    for (const n of [254, 255, 256, 498, 499, 500, 501, 998, 999, 1000, 1001]) {
        for (const fill of ["a", "😀", "a😀"]) {
            const run = fill.repeat(n).slice(0, n);
            out.push(
                `password=${run} x`,
                `password="${run}" x`,
                `api_key: '${run}'`,
                `cookie: "${run}"`,
                `cookie="${run}=1"`,
                `${run}@ybl`,
                `a${run}@okaxis pay`,
                `Cookie: ${run}, then retry`,
                `response="${run}" nonce=${run}`,
            );
        }
    }
    return out;
}

const CORPUS = [
    ...edges(),
    ...literals("./credential-mask.test.ts"),
    ...literals("./pii-redactor.test.ts"),
    ...literals("./pii-vault.test.ts"),
    ...literals("./__tests__/redos.test.ts"),
    ...transcripts(200),
    ...Object.values(adversarial(4_000)),
    ...Object.values(adversarial(40_000)),
    ...randomCorpus(Number(process.env.PII_PARITY_RANDOM ?? 5_000)), // PII_PARITY_RANDOM=200000 for a deeper local run
];

/** The input, TS and native output around their first difference. */
function firstDiff(t: string) {
    const a = _maskCredentialsTs(t);
    const b = nativeMaskCredentials(t) ?? "";
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const at = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
    return { input: at(t), ts: at(a), native: at(b) };
}

// CI's native job sets ATLAS_REQUIRE_NATIVE=true after building the binary, so a
// load failure there fails instead of skipping.
it.runIf(process.env.ATLAS_REQUIRE_NATIVE === "true")("the native binary is loaded (ATLAS_REQUIRE_NATIVE)", () => {
    expect(HAS_NATIVE).toBe(true);
});

describe.skipIf(!HAS_NATIVE)("pii_protect.rs parity", () => {
    it(`maskCredentials is byte-identical on ${CORPUS.length} inputs`, () => {
        const diverged = CORPUS.filter((t) => nativeMaskCredentials(t) !== _maskCredentialsTs(t));
        expect(diverged.slice(0, 5).map(firstDiff)).toEqual([]);
    });

    it(`findPii gives the same spans on ${CORPUS.length} inputs`, () => {
        const diverged = CORPUS.filter((t) => {
            const native = (nativeFindPii(t) ?? []).map(({ kind, start, end }) => ({ kind, start, end, value: t.slice(start, end) }));
            return JSON.stringify(native) !== JSON.stringify(_findPiiTs(t));
        });
        expect(diverged.slice(0, 5).map((t) => JSON.stringify(t.slice(0, 300)))).toEqual([]);
    });

    it("the masking-relevant corpus actually exercises the masker", () => {
        const masked = CORPUS.filter((t) => _maskCredentialsTs(t) !== t).length;
        const found = CORPUS.filter((t) => _findPiiTs(t).length > 0).length;
        expect(masked).toBeGreaterThan(1000);
        expect(found).toBeGreaterThan(500);
    });
});

describe("ATLAS_NATIVE_PROTECT dispatch", () => {
    afterEach(() => {
        vi.doUnmock("../native/index.js");
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("falls back to TS when the native call throws", async () => {
        vi.resetModules();
        vi.stubEnv("ATLAS_NATIVE_PROTECT", "true");
        vi.doMock("../native/index.js", () => ({
            nativeMaskCredentials: () => {
                throw new Error("boom");
            },
            nativeFindPii: () => {
                throw new Error("boom");
            },
        }));
        const { maskCredentials } = await import("./credential-mask.js");
        const { findPii } = await import("./pii-redactor.js");
        expect(maskCredentials("password=hunter2x")).toBe("password=[redacted]");
        expect(findPii("OTP: 482913").map((m) => m.value)).toEqual(["482913"]);
    });

    it.skipIf(!HAS_NATIVE)("routes to native when on, with the same answer", async () => {
        vi.resetModules();
        vi.stubEnv("ATLAS_NATIVE_PROTECT", "true");
        const { maskCredentials } = await import("./credential-mask.js");
        const { findPii } = await import("./pii-redactor.js");
        const t = "Authorization: Bearer FAKEtok3nAbc123xyz and card 4111 1111 1111 1111";
        expect(maskCredentials(t)).toBe(_maskCredentialsTs(t));
        expect(findPii(t)).toEqual(_findPiiTs(t));
    });
});
