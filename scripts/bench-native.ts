// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Cross-module bench harness for the Rust expansion plan (prancy-painting-reef).
//
// Modes:
//   --bench           Time TS vs Rust paths on representative inputs.
//   --parity-check    Assert outputs match within tolerance (CI gate).
//   --module=<name>   Run only one module (default: all).
//
// Output: writes `native/bench-results.json` with per-module timings.

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { __testOnlyBfsWithAdjacency, type ActivationResult } from "../src/memory/spreading-activation.js";
import { checkParity } from "../src/memory/spreading-activation.parity-helpers.js";
import { isNativeAvailable, nativeFindPii, nativeMaskCredentials, nativeSanitizeSecrets } from "../src/native/index.js";
import { _maskCredentialsTs } from "../src/security/credential-mask.js";
import { _findPiiTs } from "../src/security/pii-redactor.js";
import { adversarial } from "../src/security/redos-inputs.js";
import { _sanitizeSecretsTs, type SanitizeResult } from "../src/security/secrets-sanitizer.js";

interface Rel {
    entityId: number;
    entityName: string;
    weight: number;
}

interface BenchResult {
    module: string;
    case: string;
    tsMs: number;
    nativeMs: number;
    speedup: number;
    iterations: number;
}

const args = new Set(process.argv.slice(2));
const PARITY_ONLY = args.has("--parity-check");
const moduleFilter = (() => {
    for (const a of args) if (a.startsWith("--module=")) return a.slice("--module=".length);
    return null;
})();

const WARMUP = 100;
const ITERATIONS = PARITY_ONLY ? 1 : 5000;

const results: BenchResult[] = [];

function time(fn: () => unknown, iterations: number): number {
    for (let i = 0; i < Math.min(WARMUP, iterations); i++) fn();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    return performance.now() - start;
}

/**
 * Per-module parity callback: takes the TS and native return values and
 * returns null on parity (within whatever tolerance the module defines)
 * or a string describing the divergence. Modules MUST supply this if they
 * want to participate in `--parity-check`; without it, byte-equality JSON
 * compare is used as a default which is too strict for floating-point work.
 */
type ParityFn = (ts: unknown, native: unknown) => string | null;

function record(
    module: string,
    caseName: string,
    tsFn: () => unknown,
    nativeFn: () => unknown,
    parityFn?: ParityFn,
    iterations = ITERATIONS,
) {
    if (PARITY_ONLY) {
        // Each step (tsFn / nativeFn / parityFn) is wrapped so a thrown error
        // becomes a per-case "DIVERGED" record rather than killing the whole
        // bench mid-run. CI still sees exit-code 1 (set below); the next case
        // continues so we keep the per-case context.
        let failure: string | null;
        try {
            const ts = tsFn();
            const native = nativeFn();
            failure = parityFn
                ? parityFn(ts, native)
                : JSON.stringify(ts) === JSON.stringify(native)
                  ? null
                  : "JSON byte-equality mismatch (no parity callback supplied — supply one to allow tolerated divergence)";
        } catch (err) {
            failure = `threw during parity check: ${(err as Error)?.message ?? String(err)}`;
        }
        if (failure) {
            console.error(`[parity] ${module} / ${caseName} — DIVERGED`);
            console.error(`  ${failure}`);
            process.exitCode = 1;
        } else {
            console.log(`[parity] ${module} / ${caseName} — ok`);
        }
        return;
    }

    const tsMs = time(tsFn, iterations);
    const nativeMs = time(nativeFn, iterations);
    const speedup = tsMs / Math.max(nativeMs, 1e-6);
    results.push({ module, case: caseName, tsMs, nativeMs, speedup, iterations });
    console.log(
        `[${module}] ${caseName.padEnd(40)} ts=${tsMs.toFixed(2)}ms ` +
            `native=${nativeMs.toFixed(2)}ms speedup=${speedup.toFixed(2)}x`,
    );
}

const spreadingParity: ParityFn = (ts, native) => {
    const failures = checkParity(ts as ActivationResult[], native as ActivationResult[]);
    return failures ? JSON.stringify(failures) : null;
};

// ── Module: spreading-activation ────────────────

function buildLineGraph(n: number, weight = 0.95): Record<number, Rel[]> {
    const adj: Record<number, Rel[]> = {};
    for (let i = 1; i < n; i++) {
        adj[i] = [{ entityId: i + 1, entityName: `n${i + 1}`, weight }];
    }
    return adj;
}

function buildDenseGraph(n: number, fanout = 5): Record<number, Rel[]> {
    const adj: Record<number, Rel[]> = {};
    for (let i = 1; i <= n; i++) {
        const edges: Rel[] = [];
        for (let j = 0; j < fanout; j++) {
            const target = ((i + j) % n) + 1;
            if (target !== i) edges.push({ entityId: target, entityName: `n${target}`, weight: 0.7 + j * 0.05 });
        }
        adj[i] = edges;
    }
    return adj;
}

function benchSpreading() {
    if (moduleFilter && moduleFilter !== "spreading") return;

    const cases: Array<{
        name: string;
        seeds: Array<{ entityId: number; energy: number; via: string }>;
        adj: Record<number, Rel[]>;
    }> = [
        { name: "5-node line", seeds: [{ entityId: 1, energy: 1.0, via: "s" }], adj: buildLineGraph(5) },
        {
            name: "50-node dense",
            seeds: [
                { entityId: 1, energy: 1.0, via: "s" },
                { entityId: 25, energy: 0.8, via: "s2" },
            ],
            adj: buildDenseGraph(50, 5),
        },
        { name: "150-node dense", seeds: [{ entityId: 1, energy: 1.0, via: "s" }], adj: buildDenseGraph(150, 5) },
        {
            name: "500-node dense (caps at 150 activated)",
            seeds: [{ entityId: 1, energy: 1.0, via: "s" }],
            adj: buildDenseGraph(500, 5),
        },
    ];

    for (const c of cases) {
        record(
            "spreading",
            c.name,
            () => __testOnlyBfsWithAdjacency(c.seeds, c.adj, "ts"),
            () => __testOnlyBfsWithAdjacency(c.seeds, c.adj, "native"),
            spreadingParity,
        );
    }
}

// ── Module: secrets-sanitizer ───────────────────

function buildShellOutput(sizeBytes: number, numSecrets: number): string {
    const filler =
        "drwxr-xr-x  5 user  staff   160 Jan  1 12:00 src\n" +
        "commit a0ac7970e3c8f9b2d4e6 at HEAD\n" +
        "id=550e8400-e29b-41d4-a716-446655440000\n";
    const secrets = [
        "AKIAIOSFODNN7EXAMPLE",
        `ghp_${"A".repeat(36)}`,
        `sk_live_${"a".repeat(24)}`,
        "Authorization: Bearer abc123def456ghi789jkl012mno345pqr678",
        `key=AIza${"X".repeat(35)}`,
    ];
    let out = "";
    while (out.length < sizeBytes) out += filler;
    out = out.slice(0, sizeBytes);
    for (let i = 0; i < numSecrets; i++) {
        const insertAt = Math.floor((out.length / Math.max(numSecrets, 1)) * i);
        out = out.slice(0, insertAt) + " " + secrets[i % secrets.length] + " " + out.slice(insertAt);
    }
    return out;
}

const sanitizerParity: ParityFn = (ts, native) => {
    const tsR = ts as SanitizeResult;
    const naR = native as SanitizeResult;
    if (tsR.sanitized !== naR.sanitized) {
        return `sanitized differs (ts=${tsR.sanitized.length}c native=${naR.sanitized.length}c)`;
    }
    if (tsR.totalRedactions !== naR.totalRedactions) {
        return `totalRedactions ts=${tsR.totalRedactions} native=${naR.totalRedactions}`;
    }
    const tsKeys = Object.keys(tsR.redactionsByType).sort();
    const naKeys = Object.keys(naR.redactionsByType).sort();
    if (tsKeys.join(",") !== naKeys.join(",")) {
        return `redactionsByType keys differ: ts=[${tsKeys.join(",")}] native=[${naKeys.join(",")}]`;
    }
    for (const k of tsKeys) {
        if (tsR.redactionsByType[k] !== naR.redactionsByType[k]) {
            return `${k} count ts=${tsR.redactionsByType[k]} native=${naR.redactionsByType[k]}`;
        }
    }
    return null;
};

function benchSanitizer() {
    if (moduleFilter && moduleFilter !== "sanitizer") return;

    const cases: Array<{ name: string; size: number; secrets: number }> = [
        { name: "50B  / 0 secrets (below FFI crossover)", size: 50, secrets: 0 },
        { name: "150B / 0 secrets (at FFI crossover)", size: 150, secrets: 0 },
        { name: "1KB  / 0 secrets", size: 1024, secrets: 0 },
        { name: "1KB  / 1 secret", size: 1024, secrets: 1 },
        { name: "10KB / 0 secrets", size: 10240, secrets: 0 },
        { name: "10KB / 5 secrets", size: 10240, secrets: 5 },
        { name: "100KB / 10 secrets", size: 102400, secrets: 10 },
        { name: "200KB / 20 secrets", size: 204800, secrets: 20 },
    ];

    for (const c of cases) {
        const input = buildShellOutput(c.size, c.secrets);
        const runTs = () => _sanitizeSecretsTs(input);
        const runNative = () => {
            const r = nativeSanitizeSecrets(input);
            if (!r) throw new Error("native unavailable");
            return {
                sanitized: r.sanitized,
                redactionsByType: JSON.parse(r.redactionsByTypeJson) as Record<string, number>,
                totalRedactions: r.totalRedactions,
            } as SanitizeResult;
        };
        record("sanitizer", c.name, runTs, runNative, sanitizerParity, c.size > 50_000 ? 500 : ITERATIONS);
    }
}

// ── Module: protect (credential-mask.ts / pii-redactor.ts vs pii_protect.rs) ──

/** A tool result: page prose with URLs, a few credentials, cards, OTPs and UPI IDs. */
function buildToolResult(size: number): string {
    const filler = [
        "The order page shows a Continue button and a search box with 24 results. ",
        "Open https://shop.example.com/cart?item=8812&ref=home to check out. ",
        '{"status":"ok","total":"₹1,249.00","eta":"2 days","items":[{"id":"sku-4410","qty":1}]} ',
        "Delivery to 12 MG Road, Bengaluru 560001; call 9876543210. ",
    ];
    const secrets = [
        "Authorization: Bearer FAKEtok3nAbc123xyz456 ",
        "password=hunter2-fake ",
        "Card number: 4111 1111 1111 1111 ",
        "Your OTP is 482913. ",
        "pay priya.s42@okaxis ",
        "Cookie: sessionid=FAKEsess4455aa; theme=dark\n",
    ];
    let out = "";
    for (let i = 0; out.length < size; i++) {
        out += i % 7 === 6 ? secrets[Math.floor(i / 7) % secrets.length] : filler[i % filler.length];
    }
    return out.slice(0, size);
}

function benchProtect() {
    if (moduleFilter && moduleFilter !== "protect") return;
    if (!nativeMaskCredentials("password=x")) {
        console.log("[protect] skipped: this native build has no nativeMaskCredentials (npm run build:native)");
        return;
    }
    const exact: ParityFn = (ts, native) => (JSON.stringify(ts) === JSON.stringify(native) ? null : "outputs differ");
    const spans = (t: string) => () =>
        (nativeFindPii(t) ?? []).map(({ kind, start, end }) => ({ kind, start, end, value: t.slice(start, end) }));
    const cases: Array<{ name: string; input: string; iterations: number }> = [
        { name: "1KB tool result", input: buildToolResult(1024), iterations: 5000 },
        { name: "10KB tool result", input: buildToolResult(10 * 1024), iterations: 1000 },
        { name: "200KB tool result", input: buildToolResult(200 * 1024), iterations: 50 },
        {
            name: "adversarial 40KB (a-a-… + password=)",
            input: `${adversarial(40_000)["a-"]} password=FAKEpw123`,
            iterations: 50,
        },
        { name: "adversarial 40KB (x.x.… + ://)", input: `${adversarial(40_000)["x."]}://u:p@h`, iterations: 50 },
        {
            name: "adversarial 200KB (a-a-… + password=)",
            input: `${adversarial(200_000)["a-"]} password=FAKEpw123`,
            iterations: 10,
        },
    ];
    for (const c of cases) {
        const ts = () => _maskCredentialsTs(c.input);
        record("mask_credentials", c.name, ts, () => nativeMaskCredentials(c.input), exact, c.iterations);
    }
    for (const c of cases) {
        record("find_pii", c.name, () => _findPiiTs(c.input), spans(c.input), exact, c.iterations);
    }
}

// ── Run ─────────────────────────────────────────

console.log(`Native available: ${isNativeAvailable()}`);
if (!isNativeAvailable()) {
    console.error("Native module not loaded — cannot run bench. Did you `npm run build:native`?");
    process.exit(1);
}

benchSpreading();
benchSanitizer();
benchProtect();
// Future phases append more modules here (json-extract, smart-truncate, …).

if (!PARITY_ONLY && results.length > 0) {
    const summary = {
        recordedAt: new Date().toISOString(),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        results,
    };
    writeFileSync("./native/bench-results.json", JSON.stringify(summary, null, 2));
    console.log(`\nWrote ./native/bench-results.json (${results.length} cases)`);
}
