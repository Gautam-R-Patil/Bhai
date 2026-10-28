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
    }, 5_000);

    it("returns null on impossible query when only AX tiers run", async () => {
        // Use a controlled AX dump (not the live screen) so the test is
        // deterministic — a real dump could fuzzy-match a live window title.
        const mkNode = (role: string, label: string, x: number) => ({
            role,
            label,
            value: null,
            x,
            y: 10,
            w: 50,
            h: 20,
            focusable: true,
            enabled: true,
            children: [],
        });
        const axDumpHint = {
            app: "TestApp",
            pid: 0,
            trusted: true,
            depth: 20,
            elapsedMs: 0,
            source: "swift" as const,
            root: {
                role: "AXWindow",
                label: "Test Window",
                value: null,
                x: 0,
                y: 0,
                w: 200,
                h: 100,
                focusable: false,
                enabled: true,
                children: [mkNode("AXButton", "Save", 10), mkNode("AXButton", "Cancel", 70)],
            },
        };
        const r = await findClickTarget("definitely_no_such_label_xyz123_impossible", {
            skipTiers: ["memory", "ui_tars", "omniparser", "cloud_grounding"],
            axDumpHint,
        });
        expect(r).toBeNull();
    }, 10_000);
});

describe("cloud_grounding tier", () => {
    // Minimal 1x1 PNG written to tmp (passes isSafeScreenshotPath + PNG header parse).
    const TINY_PNG = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
    );

    async function writeTmpPng(): Promise<string> {
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { promises: fs } = await import("node:fs");
        const p = join(tmpdir(), `atlas_cg_test_${Date.now()}.png`);
        await fs.writeFile(p, TINY_PNG);
        return p;
    }

    // Mock LLM returning a grounding JSON response.
    const mockLLM = {
        chat: async () => ({
            choices: [{ message: { content: '{"x": 42, "y": 84, "confidence": 0.9}' } }],
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    it("fires on standard tier when local tiers are skipped, returns coords", async () => {
        const png = await writeTmpPng();
        const r = await findClickTarget("the Save button", {
            screenshotPath: png,
            forceProfile: "standard",
            skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser"],
            screenDims: { width: 100, height: 100, scale: 1, monitorId: "test", originX: 0, originY: 0 },
            llm: mockLLM,
        });
        expect(r).not.toBeNull();
        expect(r?.source).toBe("cloud_grounding");
        expect(r?.triedTiers).toContain("cloud_grounding");
    });

    it("does NOT fire when no llm client is provided", async () => {
        const png = await writeTmpPng();
        const r = await findClickTarget("the Save button", {
            screenshotPath: png,
            forceProfile: "standard",
            skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser"],
        });
        expect(r).toBeNull();
    });

    it("is disabled by ATLAS_NO_CLOUD_GROUNDING", async () => {
        const png = await writeTmpPng();
        const prev = process.env.ATLAS_NO_CLOUD_GROUNDING;
        process.env.ATLAS_NO_CLOUD_GROUNDING = "true";
        try {
            const r = await findClickTarget("the Save button", {
                screenshotPath: png,
                forceProfile: "standard",
                skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser"],
                llm: mockLLM,
            });
            expect(r).toBeNull();
        } finally {
            if (prev === undefined) delete process.env.ATLAS_NO_CLOUD_GROUNDING;
            else process.env.ATLAS_NO_CLOUD_GROUNDING = prev;
        }
    });
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
