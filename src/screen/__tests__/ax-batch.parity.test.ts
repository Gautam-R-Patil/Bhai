// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.
//
// dump_ax_bin: the batched walk (default; ATLAS_NO_AX_BATCH=true turns it off) must produce the same tree as
// the per-attribute walk. The rule (compareRuns) is unit-tested here on every run. The
// live check dumps Finder, so it depends on the UI: it runs only with
// ATLAS_AX_LIVE_TESTS=true on a Mac with the helper built (npm run build:ax) and
// Accessibility permission.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getScriptsDir } from "../../config/paths.js";
import { compareRuns, nodeRows, parityRuns, pidOf, runDump } from "../ax-batch-parity.js";
import type { AxNode } from "../ax-dump.js";

const BIN = join(getScriptsDir(), "dump_ax_bin");

function liveTarget(): number | null {
    if (process.env.ATLAS_AX_LIVE_TESTS !== "true") return null;
    if (process.platform !== "darwin" || !existsSync(BIN)) return null;
    const pid = pidOf("Finder");
    if (!pid) return null;
    const probe = spawnSync(BIN, ["--pid", String(pid), "--depth", "1"], { encoding: "utf8", timeout: 10_000 });
    return probe.status === 0 && !probe.stdout?.startsWith("error|") ? pid : null;
}

const node = (role: string, label: string, x: number, extra: Partial<AxNode> = {}): AxNode => ({
    role,
    label,
    value: null,
    x,
    y: 0,
    w: 10,
    h: 10,
    focusable: false,
    enabled: true,
    children: [],
    ...extra,
});
const tree = (...kids: AxNode[]) => nodeRows(node("AXWindow", "W", 0, { children: kids }));

describe("compareRuns (parity rule)", () => {
    it("passes identical runs", () => {
        const a = tree(node("AXButton", "OK", 0), node("AXLink", "Home", 20));
        expect(compareRuns([a, a], [a, a]).ok).toBe(true);
    });

    it("fails a row where both modes are stable and disagree", () => {
        const l = tree(node("AXButton", "OK", 0));
        const b = tree(node("AXButton", "Cancel", 0));
        const r = compareRuns([l, l], [b, b]);
        expect(r.ok).toBe(false);
        expect(r.diffs).toHaveLength(1);
    });

    it("checks fields flattenInteractive drops: subrole, focused, enabled", () => {
        const l = tree(node("AXButton", "OK", 0, { subrole: "AXCloseButton", focusable: false }));
        for (const extra of [{ subrole: "AXZoomButton" }, { focusable: true }, { enabled: false }]) {
            const b = tree(node("AXButton", "OK", 0, { subrole: "AXCloseButton", focusable: false, ...extra }));
            expect(compareRuns([l, l], [b, b]).diffs).toHaveLength(1);
        }
    });

    it("checks non-interactive nodes (an unlabeled group)", () => {
        const l = tree(node("AXGroup", "", 0));
        const b = tree(node("AXGroup", "", 0, { value: "x" }));
        expect(compareRuns([l, l], [b, b]).ok).toBe(false);
    });

    it("allows a row that moves between runs of the same mode (live UI)", () => {
        const rows = (x: number) =>
            tree(...Array.from({ length: 199 }, (_, i) => node("AXButton", `b${i}`, i)), node("AXImage", "badge", x));
        const r = compareRuns([rows(300), rows(300)], [rows(301), rows(302)]);
        expect(r.live).toBe(1);
        expect(r.ok).toBe(true);
    });

    it("a live field does not cover a stable field that disagrees on the same row", () => {
        // x moves between legacy runs (live), but the batched role is wrong and stable.
        const l1 = tree(node("AXImage", "badge", 300));
        const l2 = tree(node("AXImage", "badge", 301));
        const b = tree(node("AXButton", "badge", 302));
        const r = compareRuns([l1, l2], [b, b]);
        expect(r.diffs).toHaveLength(1);
        expect(r.ok).toBe(false);
    });

    it("fails when the two modes never produce the same node count", () => {
        const a = tree(node("AXButton", "OK", 0));
        expect(compareRuns([a], [tree(node("AXButton", "OK", 0), node("AXButton", "More", 20))]).countOk).toBe(false);
    });

    it("fails when some batched runs lose part of the tree, even if one is whole", () => {
        const full = tree(node("AXButton", "A", 0), node("AXButton", "B", 20), node("AXButton", "C", 40));
        const cut = tree(node("AXButton", "A", 0));
        const r = compareRuns([full, full, full], [full, cut, cut]);
        expect(r.countOk).toBe(false);
        expect(r.ok).toBe(false);
    });
});

const pid = liveTarget();

describe.skipIf(pid === null)("dump_ax_bin batched vs per-attribute walk (live Finder, ATLAS_AX_LIVE_TESTS)", () => {
    it("produces the same tree", { timeout: 120_000 }, () => {
        let r = parityRuns(BIN, pid as number, 3);
        if (!r.cmp.ok) r = parityRuns(BIN, pid as number, 3); // live UI: confirm once
        expect(r.cmp.diffs).toEqual([]);
        expect(r.cmp.ok).toBe(true);
    });

    it("omits partial for a responsive app in both modes", () => {
        expect(runDump(BIN, pid as number, false).raw.partial).toBeUndefined();
        expect(runDump(BIN, pid as number, true).raw.partial).toBeUndefined();
    });
});
