// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { beforeEach, describe, expect, it } from "vitest";
import {
    clampToMonitor,
    clearScreenDimensionsCache,
    percentageToScreen,
    type ScreenDimensions,
    scaleImageToScreen,
} from "../screen-dimensions.js";

const primary: ScreenDimensions = {
    width: 1440,
    height: 900,
    scale: 2,
    monitorId: "mac-0",
    originX: 0,
    originY: 0,
};

const secondaryRight: ScreenDimensions = {
    width: 1920,
    height: 1080,
    scale: 1,
    monitorId: "mac-1",
    originX: 1440,
    originY: 0,
};

const secondaryLeft: ScreenDimensions = {
    width: 1280,
    height: 800,
    scale: 1,
    monitorId: "mac-2",
    originX: -1280,
    originY: 0,
};

describe("clampToMonitor", () => {
    beforeEach(() => clearScreenDimensionsCache());

    it("returns input when point lies inside primary screen", () => {
        expect(clampToMonitor(500, 400, primary)).toEqual({ x: 500, y: 400 });
    });

    it("clamps points past the right edge", () => {
        expect(clampToMonitor(2000, 400, primary)).toEqual({ x: 1439, y: 400 });
    });

    it("clamps points past the bottom edge", () => {
        expect(clampToMonitor(500, 2000, primary)).toEqual({ x: 500, y: 899 });
    });

    it("clamps negative points to monitor origin", () => {
        expect(clampToMonitor(-100, -50, primary)).toEqual({ x: 0, y: 0 });
    });

    it("respects monitor with non-zero origin (right-side secondary)", () => {
        expect(clampToMonitor(1500, 500, secondaryRight)).toEqual({ x: 1500, y: 500 });
        expect(clampToMonitor(5000, 500, secondaryRight)).toEqual({ x: 3359, y: 500 });
    });

    it("respects monitor with negative origin (left-side secondary)", () => {
        expect(clampToMonitor(-1000, 400, secondaryLeft)).toEqual({ x: -1000, y: 400 });
        expect(clampToMonitor(-5000, 400, secondaryLeft)).toEqual({ x: -1280, y: 400 });
    });

    it("rounds non-integer coordinates", () => {
        expect(clampToMonitor(500.4, 400.6, primary)).toEqual({ x: 500, y: 401 });
    });
});

describe("scaleImageToScreen", () => {
    it("scales 1280px image coords up to a 1440-point primary screen", () => {
        const result = scaleImageToScreen({ rawX: 640, rawY: 450, imageWidth: 1280, dims: primary });
        expect(result.x).toBe(720);
        expect(result.y).toBe(506);
        expect(result.scaleFactor).toBeCloseTo(1.125, 3);
    });

    it("returns raw coords when raw=true", () => {
        const result = scaleImageToScreen({ rawX: 640, rawY: 450, imageWidth: 1280, dims: primary, raw: true });
        expect(result).toEqual({ x: 640, y: 450, scaleFactor: 1 });
    });

    it("returns raw coords when imageWidth is 0 (avoids NaN)", () => {
        const result = scaleImageToScreen({ rawX: 640, rawY: 450, imageWidth: 0, dims: primary });
        expect(result).toEqual({ x: 640, y: 450, scaleFactor: 1 });
    });

    it("scales correctly for a wider 1920px Windows screen", () => {
        const winScreen: ScreenDimensions = { ...primary, width: 1920, height: 1080 };
        const result = scaleImageToScreen({ rawX: 960, rawY: 540, imageWidth: 1920, dims: winScreen });
        expect(result.x).toBe(960);
        expect(result.y).toBe(540);
        expect(result.scaleFactor).toBe(1);
    });

    it("offsets coords by monitor origin for secondary screens", () => {
        const result = scaleImageToScreen({ rawX: 960, rawY: 540, imageWidth: 1920, dims: secondaryRight });
        expect(result.x).toBe(1440 + 960);
        expect(result.y).toBe(540);
    });

    it("clamps out-of-bounds coords to monitor", () => {
        const result = scaleImageToScreen({ rawX: 9999, rawY: 9999, imageWidth: 1280, dims: primary });
        expect(result.x).toBe(1439);
        expect(result.y).toBe(899);
    });

    it("never produces unscaled output when imageWidth matches screen width", () => {
        const result = scaleImageToScreen({ rawX: 100, rawY: 100, imageWidth: 1440, dims: primary });
        expect(result.scaleFactor).toBe(1);
        expect(result.x).toBe(100);
        expect(result.y).toBe(100);
    });
});

describe("percentageToScreen", () => {
    it("maps 0..1 to the full screen extent (clamped to width-1)", () => {
        expect(percentageToScreen({ percentX: 0, percentY: 0, dims: primary })).toEqual({ x: 0, y: 0 });
        // 1.0 clamps to last valid pixel = width-1
        expect(percentageToScreen({ percentX: 1, percentY: 1, dims: primary })).toEqual({ x: 1439, y: 899 });
        expect(percentageToScreen({ percentX: 0.5, percentY: 0.5, dims: primary })).toEqual({ x: 720, y: 450 });
    });

    it("clamps inputs above 1 and below 0 (max valid pixel = width-1)", () => {
        // 1.5 clamps to 1.0, which maps to origin+width=1440, then clampToMonitor caps at width-1=1439.
        expect(percentageToScreen({ percentX: 1.5, percentY: -0.2, dims: primary })).toEqual({ x: 1439, y: 0 });
    });

    it("maps percent=1.0 to the LAST valid pixel (not one past)", () => {
        expect(percentageToScreen({ percentX: 1, percentY: 1, dims: primary })).toEqual({ x: 1439, y: 899 });
    });

    it("respects monitor origin", () => {
        expect(percentageToScreen({ percentX: 0.5, percentY: 0.5, dims: secondaryRight })).toEqual({
            x: 1440 + 960,
            y: 540,
        });
        expect(percentageToScreen({ percentX: 0, percentY: 0, dims: secondaryLeft })).toEqual({ x: -1280, y: 0 });
    });

    it("rounds fractional coordinates to nearest pixel", () => {
        const odd: ScreenDimensions = { ...primary, width: 1001, height: 1001 };
        // 0.333 * 1001 = 333.333 → 333; 0.667 * 1001 = 667.667 → 668
        expect(percentageToScreen({ percentX: 0.333, percentY: 0.667, dims: odd })).toEqual({ x: 333, y: 668 });
    });
});

describe("regression: bug fixes from Phase 0 audit", () => {
    it("Bug-1 reproduces: scale factor 1.0 when scale data is missing", () => {
        const result = scaleImageToScreen({ rawX: 480, rawY: 360, imageWidth: 1280, dims: primary });
        expect(result.x).not.toBe(480);
        expect(result.x).toBe(540);
    });

    it("Bug-3 reproduces: click on secondary-right monitor does NOT land on primary", () => {
        const result = scaleImageToScreen({ rawX: 100, rawY: 100, imageWidth: 1920, dims: secondaryRight });
        expect(result.x).toBeGreaterThanOrEqual(1440);
    });

    it("Bug-3 reproduces: click on secondary-left monitor does NOT land on primary", () => {
        const result = scaleImageToScreen({ rawX: 100, rawY: 100, imageWidth: 1280, dims: secondaryLeft });
        expect(result.x).toBeLessThan(0);
    });
});
