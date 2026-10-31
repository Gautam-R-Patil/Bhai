// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Property test for pii-vault's known-value masker: every char of every
// occurrence of every form of every stored value is masked, whatever other
// vault values sit next to it, overlap it or were stored before it. Checked
// against a slow reference (all occurrences by indexOf; mask longest-first,
// repeated until nothing is left) over seeded random vaults and texts.

import { describe, expect, it, vi } from "vitest";
import { knownForms, SHORT_FORM } from "../value-forms.js";

const HANDLE = /\[(?:CARD|AADHAAR|UPI|OTP|COOKIE)_\d+\]/g;
const WORD = /[\p{L}\p{N}]/u;

function rng(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function luhnCard(r: () => number): string {
    const d = [4, ...Array.from({ length: 14 }, () => Math.floor(r() * 10))];
    let sum = 0;
    for (let i = 0; i < 15; i++) {
        let x = d[14 - i];
        if (i % 2 === 0) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
        sum += x;
    }
    return [...d, (10 - (sum % 10)) % 10].join("");
}

type Occ = [start: number, end: number];

/** Every occurrence of a form in `text` (short forms as whole tokens), except those wholly inside issued handles. */
function occurrences(text: string, forms: string[], issued: Set<string>): Array<[...Occ, string]> {
    const inHandle = new Uint8Array(text.length);
    for (const m of text.matchAll(HANDLE)) if (issued.has(m[0])) inHandle.fill(1, m.index, m.index + m[0].length);
    const out: Array<[...Occ, string]> = [];
    for (const f of forms) {
        for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + 1)) {
            const e = i + f.length;
            if (f.length < SHORT_FORM && (WORD.test(text[i - 1] ?? "") || WORD.test(text[e] ?? ""))) continue;
            if (inHandle.subarray(i, e).every((b) => b === 1)) continue;
            out.push([i, e, f]);
        }
    }
    return out;
}

/** The slow reference: mask the longest occurrence, then look again, until nothing is left. */
function reference(text: string, forms: string[], handleOfForm: Map<string, string>, issued: Set<string>): string {
    for (;;) {
        const occ = occurrences(text, forms, issued);
        if (!occ.length) return text;
        const [s, e, f] = occ.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
        text = text.slice(0, s) + handleOfForm.get(f) + text.slice(e);
    }
}

describe("known-value masking property", () => {
    it("masks every char of every form occurrence (seeded, thousands of cases)", async () => {
        vi.stubEnv("BHAI_NO_PROTECT_CACHE", "true");
        const r = rng(0x5eed);
        const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
        const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
        const SEPS = ["", "", " ", ":", "=", "-", "x", "9", "1", "\n", "é", "_"];
        let cases = 0;
        let overlapping = 0;
        const failures: string[] = [];

        for (let round = 0; round < 30; round++) {
            vi.resetModules();
            const vault = await import("../pii-vault.js");
            const group = (c: string) => (r() < 0.5 ? c : c.replace(/(\d{4})(?=\d)/g, "$1 "));
            const cards = [group(luhnCard(r)), group(luhnCard(r))];
            const digits = cards[0].replace(/\D/g, "");
            // Values built to overlap the cards and each other.
            const wanted: Array<[seed: string, value: string]> = [];
            for (const c of cards) wanted.push([`card ${c}`, c]);
            for (let i = int(1, 3); i > 0; i--) {
                const n = int(4, 8);
                const otp = pick([
                    () => String(int(1, 99)).concat(digits).slice(0, n), // starts before the card
                    () => digits.slice(-n), // the card's tail
                    () => digits.slice(int(0, 8)).slice(0, n), // inside the card
                ])();
                wanted.push([`Your OTP is ${otp}`, otp]);
            }
            for (let i = int(1, 4); i > 0; i--) {
                const v = pick([
                    () => `${pick(["q=", "zz=", "x", ""])}${cards[0].slice(0, int(3, 12))}`,
                    () => cards[0].slice(int(4, 12)) + pick(["", " 9", "x"]),
                    () => Array.from({ length: int(1, 4) }, () => pick(["1", "4", "x", "=", " ", "9"])).join("").trim() || "x",
                ])();
                wanted.push([`document.cookie = "${v}"`, v]);
            }
            wanted.sort((a, b) => b[1].length - a[1].length); // longer first: a seed is not masked by a shorter known value

            const handleOfValue = new Map<string, string>();
            for (const [seed] of wanted) {
                for (const h of vault.protect(seed, { credentials: false }).match(HANDLE) ?? [])
                    if (!handleOfValue.has(vault.reveal(h))) handleOfValue.set(vault.reveal(h), h);
            }
            const issued = new Set(handleOfValue.values());
            const handleOfForm = new Map<string, string>();
            for (const [v, h] of handleOfValue) for (const [f] of knownForms(v)) if (!handleOfForm.has(f)) handleOfForm.set(f, h);
            const forms = [...handleOfForm.keys()];
            const values = [...handleOfValue.keys()];

            for (let t = 0; t < 150; t++) {
                const parts: string[] = [];
                for (let k = int(1, 6); k > 0; k--) {
                    const v = pick(values);
                    parts.push(
                        pick([
                            () => pick(knownForms(v))[0],
                            () => pick(knownForms(v))[0],
                            () => v.slice(int(0, v.length - 1), int(1, v.length)), // a piece of one
                            () => pick([...issued]),
                            () => `[OTP_${int(1, 99999)}]`, // handle-shaped, maybe never issued
                        ])(),
                        pick(SEPS),
                    );
                }
                const text = parts.join("");
                cases++;
                const occ = occurrences(text, forms, issued);
                if (occ.some((a) => occ.some((b) => a !== b && a[0] < b[1] && b[0] < a[1] && a[2] !== b[2]))) overlapping++;

                // 1. Every occurrence lies inside a span that is rewritten to handles only.
                const spans = vault.knownValueSpans(text);
                for (const [s, e, f] of occ) {
                    const span = spans.find(([a, b]) => a <= s && e <= b);
                    const rewritten = span && span[2] !== text.slice(span[0], span[1]) && span[2].replace(HANDLE, "") === "";
                    if (!rewritten) failures.push(`${JSON.stringify(text)}: "${f}" at ${s} not masked (vault ${JSON.stringify(values)})`);
                }
                // 2. Nothing in the output that the reference would still mask.
                const out = vault.maskKnownValues(text);
                if (reference(out, forms, handleOfForm, issued) !== out)
                    failures.push(`${JSON.stringify(text)} → ${JSON.stringify(out)} still holds a form (vault ${JSON.stringify(values)})`);
                if (failures.length > 5) break;
            }
        }
        vi.unstubAllEnvs();
        expect(failures).toEqual([]);
        expect(cases).toBeGreaterThan(4000);
        expect(overlapping).toBeGreaterThan(200); // the generator really makes overlaps
    }, 60_000);

    it("a short value starting before a stored card doesn't take part of it", async () => {
        vi.resetModules();
        const { protect } = await import("../pii-vault.js");
        expect(protect("pay with 4111 1111 1111 1111 now")).toBe("pay with [CARD_1] now");
        expect(protect("Your OTP is 904111")).toBe("Your OTP is [OTP_1]");
        expect(protect("ref:904111 1111 1111 1111 end")).toBe("ref:[OTP_1][CARD_1] end");
        expect(protect('document.cookie = "zz=4111 1111"', { credentials: false })).toBe('document.cookie = "[COOKIE_1]"');
        expect(protect("zz=4111 1111 1111 1111")).toBe("[COOKIE_1][CARD_1]");
        expect(protect("Your OTP is 1234")).toBe("Your OTP is [OTP_2]");
        expect(protect("card 4111111111111111")).toBe("card [CARD_2]");
        expect(protect("12344111111111111111")).toBe("[OTP_2][CARD_2]"); // glued "1234" stands alone once the card is masked
    });
});
