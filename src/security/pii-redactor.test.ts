// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { protect } from "./pii-vault.js";
import { luhnValid, redactPii, verhoeffValid } from "./pii-redactor.js";

// Deterministic PRNG so failures reproduce.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join("");

function card(): string {
    const body = pick(["4", "51", "52", "53", "60", "65", "37"]) + digits(14);
    const base = body.slice(0, 15);
    const check = [..."0123456789"].find((d) => luhnValid(base + d)) as string;
    const n = base + check;
    return pick([n, n.replace(/(\d{4})(?=\d)/g, "$1 "), n.replace(/(\d{4})(?=\d)/g, "$1-")]);
}
function aadhaar(): string {
    const base = String(2 + Math.floor(rand() * 8)) + digits(10);
    const n = base + ([..."0123456789"].find((d) => verhoeffValid(base + d)) as string);
    return pick([n, `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`, `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`]);
}
const upi = () => `${pick(["rahul", "priya.s", "dheeraj_k", "amit92", "neha.m"])}${digits(2)}@${pick(["okicici", "oksbi", "ybl", "paytm", "axl", "ibl", "okhdfcbank"])}`;
const otp = () => digits(pick([4, 6, 6, 8]));
const cookieVal = () => Array.from({ length: 24 }, () => pick([..."abcdef0123456789ABCDEFxyz"])).join("");

function transcript(): { text: string; secrets: string[] } {
    const c = card();
    const a = aadhaar();
    const u = upi();
    const o = otp();
    const k = cookieVal();
    const lines = [
        pick([`Pay with my card ${c}, expiry 08/29.`, `Card number: ${c}`, `use ${c} for the order`]),
        pick([`My Aadhaar is ${a}.`, `Aadhaar no ${a} for KYC`, `UID: ${a}`]),
        pick([`Send ₹450 to ${u}`, `UPI ID ${u}`, `pay ${u} please`]),
        pick([`Your OTP is ${o}. Do not share it.`, `${o} is your verification code for Swiggy`, `OTP: ${o}`, `Use one-time password ${o} to log in`]),
        pick([`Cookie: sessionid=${k}; theme=dark`, `Set-Cookie: auth_token=${k}; Path=/; HttpOnly`, `document.cookie = "csrftoken=${k}"`]),
    ];
    return { text: lines.sort(() => rand() - 0.5).join("\n"), secrets: [c, a, u, o, k] };
}

describe("PII redaction", () => {
    it("leaks nothing from 200 synthetic transcripts", () => {
        const leaks: string[] = [];
        for (let i = 0; i < 200; i++) {
            const { text, secrets } = transcript();
            const out = protect(text); // the full pipeline: PII handles + credential policy
            const outDigits = out.replace(/\D/g, "");
            for (const s of secrets) {
                const sd = s.replace(/\D/g, "");
                if (out.includes(s) || (sd.length >= 12 && outDigits.includes(sd))) leaks.push(`#${i}: ${s}`);
            }
        }
        expect(leaks).toEqual([]);
    });

    it("leaves ordinary numbers and addresses alone", () => {
        const keep = [
            "Order ID 123456789012 shipped",
            "Deliver to 12 MG Road, Bengaluru, PIN code 560001",
            "call me at 9876543210",
            "Total ₹1,249.00 incl. GST",
            "mail me at priya@gmail.com",
            "npm i eslint@next react@18",
            "HTTP error code 4040 from the API",
        ];
        for (const t of keep) expect(redactPii(t).text).toBe(t);
    });

    it("gives the same value the same handle across calls", () => {
        const handles = new Map<string, string>();
        const a = redactPii("OTP: 482913", handles).text;
        const b = redactPii("Typing OTP 482913 now", handles).text;
        expect(a).toBe("OTP: [OTP_1]");
        expect(b).toBe("Typing OTP [OTP_1] now");
    });
});
