// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.
//
// Parity + timing for scripts/dump_ax_bin: per-attribute walk (default) vs the
// batched walk (ATLAS_AX_BATCH=true). Compares every node and field of both modes
// (rule: compareRuns in src/screen/ax-batch-parity.ts)
// and prints the median wall time of 5 interleaved runs each.
//
//   npx tsx scripts/ax-parity.ts            # Finder, Chrome, System Settings, Terminal (if running)
//   npx tsx scripts/ax-parity.ts --hang     # also SIGSTOP a hidden TextEdit and time the dump
//
// Exits 1 on a parity failure or when the hang test misses its budget.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { median, parityRuns, pidOf, runDump } from "../src/screen/ax-batch-parity.js";
import type { AxNode } from "../src/screen/ax-dump.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "dump_ax_bin");
const TARGETS = ["Finder", "Google Chrome", "System Settings", "Terminal"];
const RUNS = 5;

const countNodes = (n: AxNode): number => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);

function parityAndTiming(name: string, pid: number): boolean {
    let r = parityRuns(BIN, pid, RUNS);
    // The UI is live: confirm a failure once before trusting it.
    if (!r.cmp.ok) r = parityRuns(BIN, pid, RUNS);
    const { cmp } = r;
    const l = median(r.legacy.map((d) => d.ms));
    const b = median(r.batched.map((d) => d.ms));
    console.log(
        `${name.padEnd(16)} pid=${pid} nodes=${countNodes(r.batched[0].raw.root)} rows=${r.batched[0].flat.length} ` +
            `${cmp.ratio === 1 ? "identical" : `${(cmp.ratio * 100).toFixed(2)}% identical, ${cmp.live} live`}` +
            `${cmp.countOk ? "" : " COUNT-MISMATCH"}` +
            `  legacy=${l.toFixed(0)}ms batch=${b.toFixed(0)}ms  ${(l / b).toFixed(2)}x  saved=${(l - b).toFixed(0)}ms  ${cmp.ok ? "PASS" : "FAIL"}`,
    );
    for (const d of cmp.diffs.slice(0, 5)) console.log(`  ${d}`);
    return cmp.ok;
}

function hangTest(): boolean {
    const wasRunning = pidOf("TextEdit") !== null;
    if (!wasRunning) execFileSync("open", ["-g", "-j", "-a", "TextEdit"]);
    let pid: number | null = null;
    for (let i = 0; i < 50 && !pid; i++) {
        pid = pidOf("TextEdit");
        if (!pid) execFileSync("sleep", ["0.1"]);
    }
    if (!pid) throw new Error("TextEdit did not start");
    execFileSync("sleep", ["1"]); // let it register with the AX server
    const timeoutMs = 1000;
    let ok = true;
    process.kill(pid, "SIGSTOP");
    try {
        for (const batch of [false, true]) {
            const r = runDump(BIN, pid, batch, { ATLAS_AX_MSG_TIMEOUT_MS: String(timeoutMs) });
            // Two timeouts in a row end the walk (one slow call does not).
            const budget = 2 * timeoutMs + 400;
            const pass = r.raw.partial === true && r.ms <= budget;
            ok &&= pass;
            console.log(
                `hang (${batch ? "batch " : "legacy"})  pid=${pid} ${r.ms.toFixed(0)}ms partial=${r.raw.partial ?? false}  budget=${budget}ms  ${pass ? "PASS" : "FAIL"}`,
            );
        }
    } finally {
        process.kill(pid, "SIGCONT");
        if (!wasRunning) process.kill(pid, "SIGTERM");
    }
    return ok;
}

let ok = true;
for (const name of TARGETS) {
    const pid = pidOf(name);
    if (!pid) {
        console.log(`${name.padEnd(16)} not running, skipped`);
        continue;
    }
    ok = parityAndTiming(name, pid) && ok;
}
if (process.argv.includes("--hang")) ok = hangTest() && ok;
process.exit(ok ? 0 : 1);
