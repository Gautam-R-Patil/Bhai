// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.
//
// dump_ax_bin: the batched walk (ATLAS_AX_BATCH=true) must flatten to the same
// elements as the per-attribute walk. Live against Finder, so it skips off macOS,
// when the helper isn't built (npm run build:ax), or without Accessibility permission.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getScriptsDir } from "../../config/paths.js";
import { compareRuns, parityRuns, pidOf, runDump } from "../ax-batch-parity.js";
import type { AxFlatElement } from "../ax-dump.js";

const BIN = join(getScriptsDir(), "dump_ax_bin");

function liveTarget(): number | null {
    if (process.platform !== "darwin" || !existsSync(BIN)) return null;
    const pid = pidOf("Finder");
    if (!pid) return null;
    const probe = spawnSync(BIN, ["--pid", String(pid), "--depth", "1"], { encoding: "utf8" });
    return probe.stdout?.startsWith("error|") ? null : pid;
}

const el = (role: string, label: string, x: number): AxFlatElement => ({
    id: 0,
    role,
    label,
    value: "",
    bbox: { x, y: 0, w: 10, h: 10 },
    center: { x: x + 5, y: 5 },
    focusable: false,
    enabled: true,
    path: [],
    depth: 0,
});

describe("compareRuns (parity rule)", () => {
    it("passes identical runs", () => {
        const a = [el("AXButton", "OK", 0), el("AXLink", "Home", 20)];
        expect(compareRuns([a, a], [a, a]).ok).toBe(true);
    });

    it("fails a row where both modes are stable and disagree", () => {
        const l = [el("AXButton", "OK", 0)];
        const b = [el("AXButton", "Cancel", 0)];
        const r = compareRuns([l, l], [b, b]);
        expect(r.ok).toBe(false);
        expect(r.diffs).toHaveLength(1);
    });

    it("allows a row that moves between runs of the same mode (live UI)", () => {
        const rows = (x: number) => [
            ...Array.from({ length: 199 }, (_, i) => el("AXButton", `b${i}`, i)),
            el("AXImage", "badge", x),
        ];
        const r = compareRuns([rows(300), rows(300)], [rows(301), rows(302)]);
        expect(r.live).toBe(1);
        expect(r.ok).toBe(true);
    });

    it("fails when the two modes never produce the same element count", () => {
        const a = [el("AXButton", "OK", 0)];
        expect(compareRuns([a], [[...a, el("AXButton", "More", 20)]]).countOk).toBe(false);
    });
});

const pid = liveTarget();

describe.skipIf(pid === null)("dump_ax_bin batched vs per-attribute walk (live Finder)", () => {
    it("flattens to the same elements", { timeout: 120_000 }, () => {
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
