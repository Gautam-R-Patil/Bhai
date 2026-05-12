// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { type ClickTarget, findClickTarget, formatCascadeResult } from "../perception-router.js";

describe("findClickTarget — tier gating + fallthrough", () => {
    it("returns null when all tiers skipped and no screenshot", async () => {
        const r = await findClickTarget("Save", {
            skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser", "ui_tars"],
        });
        expect(r).toBeNull();
    });

    it("respects skipTiers — returns null when none can run", async () => {
        const r = await findClickTarget("anything", {
            skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser", "ui_tars"],
        });
        expect(r).toBeNull();
    });

    it("respects forceProfile=lite (skips ML tiers even with screenshot)", async () => {
        const r = await findClickTarget("nonsense_query_xyz_no_such_label", {
            screenshotPath: "/tmp/does_not_exist.png",
            forceProfile: "lite",
            skipTiers: ["memory", "ax_exact", "ax_fuzzy"],
        });
        expect(r).toBeNull();
    }, { timeout: 5_000 });

    it("returns null on impossible query when only AX tiers run", async () => {
        const r = await findClickTarget("definitely_no_such_label_xyz123_impossible", {
            skipTiers: ["memory", "ui_tars", "omniparser"],
        });
        expect(r).toBeNull();
    }, { timeout: 10_000 });
});

describe("formatCascadeResult", () => {
    it("renders 'no hit' message when null", () => {
        expect(formatCascadeResult(null)).toContain("no tier reached threshold");
    });

    it("renders a successful target with all metadata", () => {
        const target: ClickTarget = {
            x: 412,
            y: 318,
            confidence: 0.92,
            source: "ax_exact",
            elapsedMsByTier: { ax_exact: 120 },
            totalMs: 135,
            triedTiers: ["memory", "ax_exact"],
            matchedElementId: 5,
            matchedLabel: "Save Document",
        };
        const s = formatCascadeResult(target);
        expect(s).toContain("source=ax_exact");
        expect(s).toContain("confidence=0.92");
        expect(s).toContain("(412,318)");
        expect(s).toContain("ax_exact");
        expect(s).toContain('label="Save Document"');
    });

    it("truncates long labels to 40 chars", () => {
        const target: ClickTarget = {
            x: 0,
            y: 0,
            confidence: 1,
            source: "ax_fuzzy",
            elapsedMsByTier: {},
            totalMs: 0,
            triedTiers: [],
            matchedLabel: "x".repeat(100),
        };
        const s = formatCascadeResult(target);
        const labelPart = s.match(/label="([^"]+)"/);
        expect(labelPart?.[1].length).toBeLessThanOrEqual(40);
    });
});
