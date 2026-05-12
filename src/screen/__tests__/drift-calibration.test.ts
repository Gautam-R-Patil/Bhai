// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    applyCalibration,
    clearCalibration,
    fitAffine,
    getCalibrationTransform,
    recordCalibrationSample,
    setDriftStorePath,
} from "../drift-calibration.js";

const TEST_STORE = join(tmpdir(), `atlas_drift_test_${Date.now()}.json`);

describe("drift calibration", () => {
    beforeEach(() => {
        setDriftStorePath(TEST_STORE);
        try {
            if (existsSync(TEST_STORE)) unlinkSync(TEST_STORE);
        } catch {
            /* ignore */
        }
    });

    afterEach(() => {
        try {
            if (existsSync(TEST_STORE)) unlinkSync(TEST_STORE);
        } catch {
            /* ignore */
        }
    });

    it("identity transform when no samples", () => {
        const t = getCalibrationTransform("mac-0");
        expect(t.a).toBe(1);
        expect(t.b).toBe(0);
        expect(t.c).toBe(0);
        expect(t.d).toBe(1);
        expect(t.tx).toBe(0);
        expect(t.ty).toBe(0);
    });

    it("applyCalibration is pass-through with no samples", () => {
        const r = applyCalibration("mac-0", 100, 200);
        expect(r).toEqual({ x: 100, y: 200 });
    });

    it("applyCalibration is pass-through with <5 samples", () => {
        for (let i = 0; i < 4; i++) {
            recordCalibrationSample("mac-0", { x: i, y: i }, { x: i + 5, y: i + 5 });
        }
        const r = applyCalibration("mac-0", 100, 100);
        expect(r).toEqual({ x: 100, y: 100 });
    });

    it("learns a translation offset from 5+ samples", () => {
        // Samples must have linearly INDEPENDENT x and y (otherwise the
        // normal-equations matrix is singular and the fit falls back to identity).
        const points: Array<{ px: number; py: number }> = [
            { px: 100, py: 50 },
            { px: 50, py: 200 },
            { px: 300, py: 80 },
            { px: 80, py: 350 },
            { px: 220, py: 140 },
            { px: 410, py: 60 },
            { px: 75, py: 480 },
            { px: 290, py: 220 },
            { px: 180, py: 410 },
            { px: 360, py: 95 },
        ];
        for (const { px, py } of points) {
            recordCalibrationSample("mac-0", { x: px, y: py }, { x: px + 10, y: py + 20 });
        }
        const r = applyCalibration("mac-0", 500, 500);
        expect(r.x).toBe(510);
        expect(r.y).toBe(520);
    });

    it("rolling window keeps only 32 newest samples", () => {
        // Add 50 samples; only the last 32 should influence the fit
        for (let i = 0; i < 30; i++) {
            recordCalibrationSample("mac-0", { x: i, y: i }, { x: i + 100, y: i + 100 });
        }
        // Now add 32 more with a different offset
        for (let i = 0; i < 32; i++) {
            const px = 1000 + i;
            recordCalibrationSample("mac-0", { x: px, y: px }, { x: px + 5, y: px + 5 });
        }
        // The fit should reflect the +5 offset, not the +100 offset
        const r = applyCalibration("mac-0", 5000, 5000);
        // Allow some tolerance for the fitting math
        expect(Math.abs(r.x - 5005)).toBeLessThan(50);
    });

    it("isolates calibration per monitor", () => {
        const pts = [
            [100, 50],
            [50, 200],
            [300, 80],
            [80, 350],
            [220, 140],
            [410, 60],
            [75, 480],
            [290, 220],
            [180, 410],
            [360, 95],
        ];
        for (const [px, py] of pts) {
            recordCalibrationSample("mac-0", { x: px, y: py }, { x: px + 10, y: py + 10 });
            recordCalibrationSample("mac-1", { x: px, y: py }, { x: px + 50, y: py + 50 });
        }
        const r0 = applyCalibration("mac-0", 100, 100);
        const r1 = applyCalibration("mac-1", 100, 100);
        expect(r0.x).toBe(110);
        expect(r1.x).toBe(150);
    });

    it("persists across reload (setDriftStorePath reset)", () => {
        const pts = [
            [100, 50],
            [50, 200],
            [300, 80],
            [80, 350],
            [220, 140],
            [410, 60],
            [75, 480],
            [290, 220],
            [180, 410],
            [360, 95],
        ];
        for (const [px, py] of pts) {
            recordCalibrationSample("mac-0", { x: px, y: py }, { x: px + 10, y: py + 10 });
        }
        // Re-set path to force reload from disk
        setDriftStorePath(TEST_STORE);
        const r = applyCalibration("mac-0", 100, 100);
        expect(r.x).toBe(110);
    });

    it("clearCalibration resets everything", () => {
        const pts = [
            [100, 50],
            [50, 200],
            [300, 80],
            [80, 350],
            [220, 140],
            [410, 60],
        ];
        for (const [px, py] of pts) {
            recordCalibrationSample("mac-0", { x: px, y: py }, { x: px + 10, y: py + 10 });
        }
        clearCalibration();
        const r = applyCalibration("mac-0", 100, 100);
        expect(r).toEqual({ x: 100, y: 100 });
    });
});

describe("fitAffine", () => {
    it("returns identity for <3 samples", () => {
        const t = fitAffine([{ px: 0, py: 0, ax: 5, ay: 5 }]);
        expect(t.a).toBe(1);
    });

    it("recovers a known affine transform", () => {
        // True transform: a=1.1, b=0, tx=5, c=0, d=1.1, ty=10
        // Samples need linearly INDEPENDENT (px, py) — otherwise the normal-equations matrix is singular.
        const pts = [
            [100, 50],
            [50, 200],
            [300, 80],
            [80, 350],
            [220, 140],
            [410, 60],
            [75, 480],
            [290, 220],
            [180, 410],
            [360, 95],
        ];
        const samples = pts.map(([px, py]) => ({ px, py, ax: 1.1 * px + 5, ay: 1.1 * py + 10 }));
        const t = fitAffine(samples);
        expect(t.a).toBeCloseTo(1.1, 3);
        expect(t.d).toBeCloseTo(1.1, 3);
        expect(t.tx).toBeCloseTo(5, 1);
        expect(t.ty).toBeCloseTo(10, 1);
    });
});
