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
import { __testOnlyBfsWithAdjacency } from "../src/memory/spreading-activation.js";
import { isNativeAvailable } from "../src/native/index.js";

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
    for (let i = 0; i < WARMUP; i++) fn();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    return performance.now() - start;
}

function record(module: string, caseName: string, tsFn: () => unknown, nativeFn: () => unknown) {
    if (PARITY_ONLY) {
        const ts = tsFn();
        const native = nativeFn();
        const tsJson = JSON.stringify(ts);
        const nativeJson = JSON.stringify(native);
        if (tsJson !== nativeJson) {
            console.error(`[parity] ${module} / ${caseName} — DIVERGED`);
            console.error(`  TS:     ${tsJson}`);
            console.error(`  NATIVE: ${nativeJson}`);
            process.exitCode = 1;
        } else {
            console.log(`[parity] ${module} / ${caseName} — ok`);
        }
        return;
    }

    const tsMs = time(tsFn, ITERATIONS);
    const nativeMs = time(nativeFn, ITERATIONS);
    const speedup = tsMs / Math.max(nativeMs, 1e-6);
    results.push({ module, case: caseName, tsMs, nativeMs, speedup, iterations: ITERATIONS });
    console.log(
        `[${module}] ${caseName.padEnd(40)} ts=${tsMs.toFixed(2)}ms ` +
            `native=${nativeMs.toFixed(2)}ms speedup=${speedup.toFixed(2)}x`,
    );
}

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
        );
    }
}

// ── Run ─────────────────────────────────────────

console.log(`Native available: ${isNativeAvailable()}`);
if (!isNativeAvailable()) {
    console.error("Native module not loaded — cannot run bench. Did you `npm run build:native`?");
    process.exit(1);
}

benchSpreading();
// Future phases append more modules here (sanitizer, json-extract, …).

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
