// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// protect() pipeline bench (pii-vault.ts), no vitest:
//   b4  a 20-iteration agent turn: the history grows by an assistant call and a
//       4KB tool result per iteration and protectMessages() runs over all of it
//       each time (what src/llm.ts does before every LLM call). Empty vault.
//   b5  protect() on a fresh 200KB tool result with 500 values in the vault.
//   b6  one console line through log-redaction (sanitizeSecrets + protect) with
//       500 values in the vault.
//
//   npx tsx scripts/bench-protect.ts            # all
//   BHAI_NO_PROTECT_CACHE=true npx tsx …       # memo off (S3 kill switch)
// Times are CPU time (process.cpuUsage), median of the runs.

import "../src/config/env-compat.js"; // first: .env + ATLAS_* → BHAI_* mirror
import { protect, protectMessages } from "../src/security/pii-vault.js";
import { sanitizeSecrets } from "../src/security/secrets-sanitizer.js";

let seed = 42;
const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
};
const WORDS =
    "the order page shows a button labelled continue and a search box with results for flights hotels price total tax delivery address name email status ok error loading retry".split(
        " ",
    );
function prose(n: number): string {
    let s = "";
    while (s.length < n) {
        const w = WORDS[Math.floor(rnd() * WORDS.length)];
        s +=
            rnd() < 0.05 ? `${w} https://example.com/p/${Math.floor(rnd() * 1e5)} ` : rnd() < 0.08 ? `${w}\n` : `${w} `;
    }
    return s.slice(0, n);
}

function cpu(fn: () => void): number {
    const t0 = process.cpuUsage();
    fn();
    const u = process.cpuUsage(t0);
    return (u.user + u.system) / 1000;
}
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

type Msg = Parameters<typeof protectMessages>[0][number];

// ── b4: growing history, empty vault ────────────────────────
function b4(): number {
    const history: Msg[] = [
        { role: "system", content: prose(2000) },
        { role: "user", content: "book the cheapest flight to Goa next friday and tell me the total" },
    ];
    const results = Array.from({ length: 20 }, () => prose(4000));
    return cpu(() => {
        for (let i = 0; i < 20; i++) {
            history.push({
                role: "assistant",
                content: "",
                tool_calls: [{ id: `c${i}`, function: { name: "browser_extract" } }],
            });
            history.push({ role: "tool", tool_call_id: `c${i}`, content: results[i] });
            protectMessages(history);
        }
    });
}

function luhnCard(i: number): string {
    const body = `4${String(100000000000000 + i * 7919).slice(-14)}`;
    for (let d = 0; d < 10; d++) {
        const n = body + d;
        let sum = 0;
        for (let k = 0; k < n.length; k++) {
            let x = n.charCodeAt(n.length - 1 - k) - 48;
            if (k % 2 === 1) {
                x *= 2;
                if (x > 9) x -= 9;
            }
            sum += x;
        }
        if (sum % 10 === 0) return n.replace(/(\d{4})(?=\d)/g, "$1 ");
    }
    return body;
}

function fillVault(n: number) {
    for (let i = 0; i < n; i++) {
        const k = i % 3;
        protect(
            k === 0
                ? `Your OTP is ${String(100000 + i * 37).slice(0, 6)}`
                : k === 1
                  ? `card ${luhnCard(i)}`
                  : `pay user${i}@okaxis`,
        );
    }
}

// ── b5: 200KB with 500 values ───────────────────────────────
function b5(): number[] {
    const out: number[] = [];
    for (let r = 0; r < 7; r++) {
        const text = `${r} ${prose(200_000)}`;
        out.push(cpu(() => protect(text)));
    }
    return out;
}

// ── b6: one log line with 500 values ────────────────────────
function b6(): number {
    const lines = Array.from(
        { length: 20_000 },
        (_, i) => `🔧 [tool] sub_agent=a${i % 7} role=browser | browser_click ok in ${i % 900}ms (iteration ${i})`,
    );
    const ms = cpu(() => {
        for (const l of lines) protect(sanitizeSecrets(l).sanitized);
    });
    return (ms * 1000) / lines.length; // µs per line
}

const b4Runs: number[] = [];
for (let r = 0; r < 5; r++) b4Runs.push(b4());
console.log(`b4 growing history (20 iterations, empty vault): ${median(b4Runs).toFixed(1)}ms`);
fillVault(500);
console.log(`b5 protect(200KB), 500 vault values: ${median(b5()).toFixed(1)}ms`);
b6(); // warm
console.log(`b6 log line, 500 vault values: ${b6().toFixed(1)}µs`);
