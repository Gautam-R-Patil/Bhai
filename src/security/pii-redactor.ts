// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Finds personal secrets that the API-key sanitizer (secrets-sanitizer.ts)
// doesn't cover: payment cards, Aadhaar numbers, UPI IDs, one-time codes and
// cookie values. Checksums (Luhn, Verhoeff) keep order IDs and phone numbers
// from being mistaken for cards or Aadhaar numbers.
//
// Pure module. `findPii` reports spans; `redactPii` swaps each value for a
// handle such as [CARD_1] and returns the originals so a caller can put them
// back where the user meant them to go (see pii-vault.ts).

import { nativeFindPii } from "../native/index.js";

export type PiiKind = "CARD" | "AADHAAR" | "UPI" | "OTP" | "COOKIE";

export interface PiiMatch {
    kind: PiiKind;
    start: number;
    end: number;
    value: string;
}

export function luhnValid(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = digits.charCodeAt(digits.length - 1 - i) - 48;
        if (i % 2 === 1) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
    }
    return sum % 10 === 0;
}

// Verhoeff tables (the Aadhaar checksum).
const VD = [
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
const VP = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
    let c = 0;
    for (let i = 0; i < digits.length; i++) {
        c = VD[c][VP[i % 8][digits.charCodeAt(digits.length - 1 - i) - 48]];
    }
    return c === 0;
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");

// Cards: 13–19 digits, optionally grouped by single spaces or dashes.
// Not glued to a word, path, URL or key=value ("file_1761234567002.png", "/status/1849…").
const CARD_RE = /(?<![\w./=:-])(?:\d[ -]?){12,18}\d(?![\w/=-]|\.\w)/g;
const CARD_IIN = /^(?:3[47]|4|5[1-5]|2[2-7]|6)/;
const CARD_WORD = /\b(?:card|visa|master ?card|rupay|amex|credit|debit|cc|cvv|expiry)\b/i;
// Aadhaar: 12 digits starting 2–9, contiguous or grouped 4-4-4.
const AADHAAR_RE = /(?<!\d)[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?!\d)/g;
// UPI virtual payment address: handle@psp, for known PSP handles only — a
// generic name@word would also catch npm specs like eslint@next.
const UPI_PSPS =
    "ybl|ibl|axl|paytm|upi|apl|yapl|ptyes|ptaxis|pthdfc|ptsbi|icici|sbi|hdfcbank|axisbank|axisb|kotak|idfcbank|idfcfirst|indus|federal|fbl|rbl|aubank|jupiteraxis|freecharge|airtel|jio|slc|ikwik|abfspay|barodampay|cnrb|unionbank|pnb|boi|mahb|kbl|okicici|oksbi|okaxis|okhdfcbank|ok[a-z]+|wa[a-z]+|pt[a-z]+";
const UPI_RE = new RegExp(`(?<![\\w.@-])[a-zA-Z0-9][\\w.-]{1,255}@(?:${UPI_PSPS})(?![\\w.@-])`, "gi");
// One-time codes: 4–8 digits near a word that says it's a code.
const OTP_RE =
    /\b(?:otp|one[- ]time (?:password|code|pin)|verification code|security code|passcode|login code|auth(?:entication)? code|2fa code)\b[^0-9\n]{0,24}?(?<!\d)(\d{4,8})(?!\d)|(?<!\d)(\d{4,8})(?!\d)[^0-9\n]{0,16}?\b(?:is your|is the)\s+(?:otp|one[- ]time (?:password|code)|verification code|login code|security code|passcode)\b/gi;
// Cookies: header lines, and session-like name=value pairs.
// Cookies and other credentials are masked by structure in pii-vault.protect()
// (credential-mask.ts); the loose patterns that lived here also hit
// prose such as "cookie: invalid format".
// The one form the policy doesn't cover: a script setting a cookie.
const JS_COOKIE_RE = /\bdocument\.cookie\s*=\s*["'`]([^"'`\r\n]+)/gi;

// ATLAS_NATIVE_PROTECT=true: the linear-time Rust port (native/src/pii_protect.rs),
// same spans (pii-protect.parity.test.ts); any native error falls back to TS.
const NATIVE_PROTECT = process.env.ATLAS_NATIVE_PROTECT === "true";

export function findPii(text: string): PiiMatch[] {
    if (NATIVE_PROTECT && text) {
        try {
            const spans = nativeFindPii(text);
            if (spans !== null)
                return spans.map((s) => ({
                    kind: s.kind as PiiKind,
                    start: s.start,
                    end: s.end,
                    value: text.slice(s.start, s.end),
                }));
        } catch {
            // fall through to TS
        }
    }
    return _findPiiTs(text);
}

/** The TS implementation; exported for the parity test. */
export function _findPiiTs(text: string): PiiMatch[] {
    const out: PiiMatch[] = [];
    const add = (kind: PiiKind, start: number, value: string) =>
        out.push({ kind, start, end: start + value.length, value });

    for (const m of text.matchAll(CARD_RE)) {
        const d = onlyDigits(m[0]);
        if (d.length < 13 || d.length > 19 || !luhnValid(d) || !CARD_IIN.test(d)) continue;
        // Grouped 4-4-4-4 / 4-6-5 is card-shaped; a bare 15-16 digit run with a card
        // prefix is too. Other lengths (13-digit ms timestamps, 17-19-digit
        // snowflake IDs) need a card word nearby — ~1 in 10 random numbers pass Luhn.
        const grouped = /^\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}$|^\d{4}([ -])\d{6}\2\d{5}$/.test(m[0]);
        const near = text.slice(Math.max(0, m.index - 40), m.index);
        if (grouped || d.length === 15 || d.length === 16 || CARD_WORD.test(near)) add("CARD", m.index, m[0]);
    }
    for (const m of text.matchAll(AADHAAR_RE)) {
        // Grouped 4-4-4 is Aadhaar-shaped on its own; a bare 12-digit run must
        // also pass the checksum (it could be an order or account number).
        if (m[1] || verhoeffValid(onlyDigits(m[0]))) add("AADHAAR", m.index, m[0]);
    }
    for (const m of text.matchAll(UPI_RE)) add("UPI", m.index, m[0]);
    for (const m of text.matchAll(JS_COOKIE_RE)) add("COOKIE", m.index + m[0].length - m[1].length, m[1]);
    for (const m of text.matchAll(OTP_RE)) {
        const code = m[1] ?? m[2];
        const at = m.index + (m[1] ? m[0].lastIndexOf(code) : m[0].indexOf(code));
        add("OTP", at, code);
    }

    // Keep the earliest, then longest, of overlapping matches.
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: PiiMatch[] = [];
    for (const m of out) if (!kept.length || m.start >= kept[kept.length - 1].end) kept.push(m);
    return kept;
}

/**
 * Replace every match with a stable handle ([CARD_1], [OTP_2] …). The same value
 * gets the same handle across calls when the same `handles` map is passed in.
 */
const handleCounters = new WeakMap<Map<string, string>, Partial<Record<PiiKind, number>>>();

export function redactPii(
    text: string,
    handles: Map<string, string> = new Map(),
): { text: string; handles: Map<string, string> } {
    const matches = findPii(text);
    if (!matches.length) return { text, handles };
    let out = "";
    let pos = 0;
    for (const m of matches) {
        let handle = handles.get(m.value);
        if (!handle) {
            // A per-map counter that only goes up: counting live handles reused a
            // number after the vault evicted old values, so reveal() could return
            // a different value than the one the model was talking about.
            const c = handleCounters.get(handles) ?? {};
            const n = (c[m.kind] ?? 0) + 1;
            c[m.kind] = n;
            handleCounters.set(handles, c);
            handle = `[${m.kind}_${n}]`;
            handles.set(m.value, handle);
        }
        out += text.slice(pos, m.start) + handle;
        pos = m.end;
    }
    return { text: out + text.slice(pos), handles };
}
