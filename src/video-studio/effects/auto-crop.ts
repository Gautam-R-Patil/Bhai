// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { FaceTrack } from "../analyze/face-track.js";

export interface AutoCropOpts {
    /** EMA smoothing factor — 0 = no movement, 1 = instant snap. Default 0.12. */
    alpha?: number;
    inputHeight: number;
    inputWidth: number;
    targetAspect: "1:1" | "4:5" | "9:16";
}

export interface CropFrame {
    h: number;
    t: number;
    w: number;
    x: number;
    y: number;
}

function aspectRatio(aspect: AutoCropOpts["targetAspect"]): number {
    switch (aspect) {
        case "9:16":
            return 9 / 16;
        case "1:1":
            return 1;
        case "4:5":
            return 4 / 5;
    }
}

function computeCropDimensions(
    targetAspect: AutoCropOpts["targetAspect"],
    inputWidth: number,
    inputHeight: number,
): { cropH: number; cropW: number } {
    const ratio = aspectRatio(targetAspect);
    const cropH = inputHeight;
    const cropW = Math.min(inputWidth, Math.floor(inputHeight * ratio));
    return { cropH, cropW };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function primaryFaceCenter(faces: FaceTrack["frames"][number]["faces"]): { cx: number; cy: number } | null {
    if (faces.length === 0) return null;
    const primary = faces.reduce((best, f) => {
        return f.w * f.h * f.score > best.w * best.h * best.score ? f : best;
    });
    return { cx: primary.x + primary.w / 2, cy: primary.y + primary.h / 2 };
}

export function computeAutoCrop(faceTrack: FaceTrack, opts: AutoCropOpts): CropFrame[] {
    const { inputHeight, inputWidth, targetAspect } = opts;
    const alpha = opts.alpha ?? 0.12;
    const { cropH, cropW } = computeCropDimensions(targetAspect, inputWidth, inputHeight);

    const defaultCx = inputWidth / 2;
    const defaultCy = inputHeight / 2;

    let smoothedCx = defaultCx;
    let smoothedCy = defaultCy;

    const result: CropFrame[] = [];

    for (const frame of faceTrack.frames) {
        const center = primaryFaceCenter(frame.faces);

        const desiredCx = center !== null ? center.cx : smoothedCx;
        const desiredCy = center !== null ? center.cy : smoothedCy;

        smoothedCx = alpha * desiredCx + (1 - alpha) * smoothedCx;
        smoothedCy = alpha * desiredCy + (1 - alpha) * smoothedCy;

        const rawX = smoothedCx - cropW / 2;
        const rawY = smoothedCy - cropH / 2;

        const x = Math.round(clamp(rawX, 0, inputWidth - cropW));
        const y = Math.round(clamp(rawY, 0, inputHeight - cropH));

        result.push({ h: cropH, t: frame.t, w: cropW, x, y });
    }

    return result;
}
