// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import type { FaceTrack } from "../../analyze/face-track.js";
import { computeAutoCrop } from "../auto-crop.js";

function makeTrack(overrides: Partial<FaceTrack> = {}): FaceTrack {
    return {
        videoPath: "/fake/clip.mp4",
        fps: 30,
        width: 1920,
        height: 1080,
        frames: [],
        ...overrides,
    };
}

describe("computeAutoCrop — dimensions", () => {
    it("9:16 cropW = floor(inputHeight * 9/16), cropH = inputHeight", () => {
        const track = makeTrack({
            frames: [{ t: 0.0, faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, { targetAspect: "9:16", inputWidth: 1920, inputHeight: 1080 });
        expect(frames).toHaveLength(1);
        expect(frames[0].w).toBe(Math.floor(1080 * (9 / 16)));
        expect(frames[0].h).toBe(1080);
    });

    it("1:1 produces min(W,H) square", () => {
        const track = makeTrack({
            frames: [{ t: 0.0, faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, { targetAspect: "1:1", inputWidth: 1920, inputHeight: 1080 });
        expect(frames[0].w).toBe(1080);
        expect(frames[0].h).toBe(1080);
    });

    it("4:5 cropW = floor(inputHeight * 4/5) clamped to inputWidth", () => {
        const track = makeTrack({
            width: 1080,
            height: 1350,
            frames: [{ t: 0.0, faces: [{ x: 540, y: 675, w: 200, h: 250, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, { targetAspect: "4:5", inputWidth: 1080, inputHeight: 1350 });
        expect(frames[0].h).toBe(1350);
        expect(frames[0].w).toBe(Math.min(1080, Math.floor(1350 * (4 / 5))));
    });
});

describe("computeAutoCrop — defaults and inheritance", () => {
    it("no faces at t=0 defaults to centered crop", () => {
        const track = makeTrack({ frames: [{ t: 0.0, faces: [] }] });
        const frames = computeAutoCrop(track, { targetAspect: "9:16", inputWidth: 1920, inputHeight: 1080 });
        const cropW = Math.floor(1080 * (9 / 16));
        expect(frames[0].x).toBe(Math.round(1920 / 2 - cropW / 2));
        expect(frames[0].y).toBe(0);
    });

    it("empty-faces mid-track inherits previous smoothed center", () => {
        const track = makeTrack({
            frames: [
                { t: 0.0, faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }] },
                { t: 0.1, faces: [] },
            ],
        });
        const frames = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 1.0,
        });
        expect(frames[1].x).toBe(frames[0].x);
        expect(frames[1].y).toBe(frames[0].y);
    });
});

describe("computeAutoCrop — EMA smoothing", () => {
    it("alpha=0.12 dampens 500px face jump to ≤20px crop jump", () => {
        const track = makeTrack({
            frames: [
                { t: 0.0, faces: [{ x: 200, y: 540, w: 200, h: 250, score: 0.9 }] },
                { t: 0.033, faces: [{ x: 700, y: 540, w: 200, h: 250, score: 0.9 }] },
            ],
        });
        const result = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 0.12,
        });
        expect(Math.abs(result[1].x - result[0].x)).toBeLessThanOrEqual(20);
    });

    it("alpha=1.0 snaps to face center exactly on second frame", () => {
        const face2 = { x: 700, y: 540, w: 200, h: 250, score: 0.9 };
        const track = makeTrack({
            frames: [
                { t: 0.0, faces: [{ x: 200, y: 540, w: 200, h: 250, score: 0.9 }] },
                { t: 0.033, faces: [face2] },
            ],
        });
        const result = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 1.0,
        });
        const cropW = Math.floor(1080 * (9 / 16));
        const faceCx = face2.x + face2.w / 2;
        const expectedX = Math.round(Math.max(0, Math.min(1920 - cropW, faceCx - cropW / 2)));
        expect(result[1].x).toBe(expectedX);
    });
});

describe("computeAutoCrop — bounds clamping", () => {
    it("face at right edge clamps crop x to inputWidth - cropW", () => {
        const track = makeTrack({
            frames: [{ t: 0.0, faces: [{ x: 1800, y: 540, w: 100, h: 120, score: 0.9 }] }],
        });
        const frames = computeAutoCrop(track, {
            targetAspect: "9:16",
            inputWidth: 1920,
            inputHeight: 1080,
            alpha: 1.0,
        });
        const cropW = Math.floor(1080 * (9 / 16));
        expect(frames[0].x).toBeGreaterThanOrEqual(0);
        expect(frames[0].x + frames[0].w).toBeLessThanOrEqual(1920);
        expect(frames[0].x).toBe(1920 - cropW);
    });
});

describe("computeAutoCrop — output length", () => {
    it("returns CropFrame[] of same length as input frames", () => {
        const inputFrames = Array.from({ length: 10 }, (_, i) => ({
            t: i * 0.1,
            faces: [{ x: 960, y: 540, w: 200, h: 250, score: 0.9 }],
        }));
        const track = makeTrack({ frames: inputFrames });
        const result = computeAutoCrop(track, { targetAspect: "9:16", inputWidth: 1920, inputHeight: 1080 });
        expect(result).toHaveLength(10);
    });
});
