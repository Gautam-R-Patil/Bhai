// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.
//
// Parity helpers for dump_ax_bin's per-attribute walk (default) vs its batched walk
// (ATLAS_AX_BATCH=true). Shared by scripts/ax-parity.ts and ax-batch.parity.test.ts.
// Not used at runtime.

import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { type AxDump, type AxFlatElement, flattenInteractive } from "./ax-dump.js";

export function pidOf(name: string): number | null {
    try {
        const out = execFileSync("pgrep", ["-x", name], { encoding: "utf8" }).trim().split("\n")[0];
        return out ? Number(out) : null;
    } catch {
        return null;
    }
}

export interface TimedDump {
    ms: number;
    raw: AxDump & { partial?: boolean };
    flat: AxFlatElement[];
}

/** Runs the helper once, with ATLAS_AX_BATCH set to "true" or removed. Throws on `error|…`. */
export function runDump(bin: string, pid: number, batch: boolean, extraEnv: Record<string, string> = {}): TimedDump {
    const env = { ...process.env, ...extraEnv };
    delete env.ATLAS_AX_BATCH;
    if (batch) env.ATLAS_AX_BATCH = "true";
    const t0 = performance.now();
    const r = spawnSync(bin, ["--pid", String(pid)], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const ms = performance.now() - t0;
    const out = (r.stdout ?? "").trim();
    if (out.startsWith("error|") || r.status !== 0) throw new Error(`dump_ax_bin: ${out || r.stderr}`);
    const raw = JSON.parse(out) as TimedDump["raw"];
    return { ms, raw, flat: flattenInteractive({ ...raw, elapsedMs: 0, source: "swift" }) };
}

const row = (e: AxFlatElement) => JSON.stringify([e.role, e.label, e.value, e.bbox]);
export const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

export interface ParityResult {
    ok: boolean;
    countOk: boolean;
    ratio: number; // identical rows / rows
    live: number;
    diffs: string[];
}

/**
 * Compares several legacy dumps with several batched dumps of the same app, restricted
 * to the runs whose element count both modes produced. Per row index:
 *   identical  some batched run equals some legacy run exactly
 *   live       no match, but the row varies between runs of the same mode
 *              (a badge animating, a list settling, a clock ticking)
 *   diff       both modes are stable and disagree: a real batching bug
 * Pass: no diffs and >=99% of rows identical or live.
 */
export function compareRuns(legacy: AxFlatElement[][], batched: AxFlatElement[][]): ParityResult {
    const lens = batched.map((b) => b.length).filter((n) => legacy.some((l) => l.length === n));
    if (lens.length === 0) return { ok: false, countOk: false, ratio: 0, live: 0, diffs: [] };
    const len = median(lens);
    const ls = legacy.filter((l) => l.length === len).map((l) => l.map(row));
    const bs = batched.filter((b) => b.length === len).map((b) => b.map(row));
    let identical = 0;
    let live = 0;
    const diffs: string[] = [];
    for (let i = 0; i < len; i++) {
        const lset = new Set(ls.map((l) => l[i]));
        const bset = new Set(bs.map((b) => b[i]));
        if ([...bset].some((r) => lset.has(r))) identical++;
        else if (lset.size > 1 || bset.size > 1) live++;
        else diffs.push(`#${i}\n    legacy ${[...lset][0]}\n    batch  ${[...bset][0]}`);
    }
    const total = Math.max(len, 1);
    return {
        ok: diffs.length === 0 && (identical + live) / total >= 0.99,
        countOk: true,
        ratio: identical / total,
        live,
        diffs,
    };
}

/** Interleaves `runs` legacy and batched dumps and compares them. */
export function parityRuns(bin: string, pid: number, runs: number) {
    const legacy: TimedDump[] = [];
    const batched: TimedDump[] = [];
    for (let i = 0; i < runs; i++) {
        legacy.push(runDump(bin, pid, false));
        batched.push(runDump(bin, pid, true));
    }
    const cmp = compareRuns(
        legacy.map((d) => d.flat),
        batched.map((d) => d.flat),
    );
    return { legacy, batched, cmp };
}
