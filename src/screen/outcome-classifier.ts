// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Click-outcome classifier (Phase 5).
 *
 * After every click, classify the screen-state change into one of:
 *   - success       : visible state changed in the expected region (~target bbox)
 *   - no_op         : essentially no change (diff < 0.0005)
 *   - modal_pop     : new modal/dialog appeared (large new region in foreground)
 *   - wrong_target  : changes happened but NOT near the target
 *
 * Heuristic-only — no ML. Encoded frames are decoded + downsampled with sharp
 * (classifyOutcomeFromImages) and diffed in pixel space; a few ms per pair.
 * Feeds into:
 *   - click-memory (success increments count; misses decrement)
 *   - drift-calibration (success records sample if we can locate the actual click target)
 *   - cascade router telemetry (which tier produced wrong_target most often)
 */

export type ClickOutcome = "success" | "no_op" | "modal_pop" | "wrong_target" | "unknown";

export interface ClickOutcomeResult {
    outcome: ClickOutcome;
    diffPercent: number; // 0..1 — pixel-sampled diff between before/after
    nearTargetDiff: number; // 0..1 — diff restricted to a region around the target
    confidence: number; // 0..1 — how sure are we
    reason: string;
}

export interface ClassifyOptions {
    /** Max pixel samples for the global diff (strided). Default: every pixel. */
    sampleCount?: number;
    /** Grey-level diff threshold for "counted as changed". Default 10. */
    pixelThreshold?: number;
    /** Box half-size around the target, in the caller's imageWidth/Height units. Default 40. */
    targetRadius?: number;
}

/** Longest side of the decoded grey frames we diff (cheap, and dilutes 1px AA noise). */
const DIFF_MAX_SIDE = 512;

/**
 * Classify a click outcome from DECODED frames: `before`/`after` are 8-bit
 * single-channel (greyscale) pixel arrays of exactly imageWidth × imageHeight,
 * row-major, and (targetX, targetY) is in that same pixel space. Anything else
 * (e.g. PNG bytes) → `unknown`. Use classifyOutcomeFromImages for encoded images.
 */
export function classifyOutcome(
    before: Buffer | null,
    after: Buffer | null,
    targetX: number,
    targetY: number,
    imageWidth: number,
    imageHeight: number,
    opts: ClassifyOptions = {},
): ClickOutcomeResult {
    if (!before || !after) {
        return { outcome: "unknown", diffPercent: 0, nearTargetDiff: 0, confidence: 0, reason: "missing_buffer" };
    }
    const n = imageWidth * imageHeight;
    if (n <= 0 || before.length !== n || after.length !== n) {
        return { outcome: "unknown", diffPercent: 0, nearTargetDiff: 0, confidence: 0, reason: "size_mismatch" };
    }
    const pixelThreshold = opts.pixelThreshold ?? 10;
    const targetRadius = opts.targetRadius ?? 40;

    const diffPercent = computeGlobalDiff(before, after, opts.sampleCount ?? n, pixelThreshold);
    const nearTargetDiff = computeRegionalDiff(
        before, after, Math.round(targetX), Math.round(targetY), Math.round(targetRadius), imageWidth, imageHeight, pixelThreshold,
    );

    // Large global change + small near-target change = something else opened (modal/menu/window switch)
    if (diffPercent > 0.3 && nearTargetDiff < 0.1) {
        return {
            outcome: "modal_pop",
            diffPercent,
            nearTargetDiff,
            confidence: 0.7,
            reason: "large_global_change_outside_target",
        };
    }

    // Near-target change → success. Checked BEFORE no_op: a small control
    // (checkbox/toggle) changes only a few hundred pixels — tiny globally.
    if (nearTargetDiff >= 0.02) {
        return { outcome: "success", diffPercent, nearTargetDiff, confidence: 0.8, reason: "change_near_target" };
    }

    // Only a static frame (a caret blink at most) is a no-op. A keypad press
    // changes a few digits in the display, away from the key, and a false miss
    // makes the caller click again — a second keypress.
    if (diffPercent < 0.0005) {
        return { outcome: "no_op", diffPercent, nearTargetDiff, confidence: 0.9, reason: "no_visible_change" };
    }

    // Global change but nothing near target → wrong target
    if (diffPercent >= 0.02 && nearTargetDiff < 0.005) {
        return {
            outcome: "wrong_target",
            diffPercent,
            nearTargetDiff,
            confidence: 0.6,
            reason: "change_far_from_target",
        };
    }

    return { outcome: "unknown", diffPercent, nearTargetDiff, confidence: 0.3, reason: "ambiguous" };
}

/**
 * Classify from ENCODED before/after images (PNG/JPEG). Both are decoded with
 * sharp to greyscale and resized to the same ≤512px frame (aspect from
 * imageWidth/Height), so captures at different pixel densities still compare.
 * (targetX, targetY) and targetRadius are in imageWidth × imageHeight units —
 * i.e. relative to the captured region's top-left, NOT absolute screen coords.
 */
export async function classifyOutcomeFromImages(
    before: Buffer | null,
    after: Buffer | null,
    targetX: number,
    targetY: number,
    imageWidth: number,
    imageHeight: number,
    opts: ClassifyOptions = {},
): Promise<ClickOutcomeResult> {
    if (!before || !after) return classifyOutcome(null, null, 0, 0, 0, 0);
    if (imageWidth <= 0 || imageHeight <= 0) {
        return { outcome: "unknown", diffPercent: 0, nearTargetDiff: 0, confidence: 0, reason: "missing_dims" };
    }
    const k = Math.min(1, DIFF_MAX_SIDE / Math.max(imageWidth, imageHeight));
    const w = Math.max(1, Math.round(imageWidth * k));
    const h = Math.max(1, Math.round(imageHeight * k));
    let a: Buffer;
    let b: Buffer;
    try {
        const sharp = (await import("sharp")).default;
        const decode = (img: Buffer) =>
            sharp(img).greyscale().resize({ width: w, height: h, fit: "fill" }).raw().toBuffer();
        [a, b] = await Promise.all([decode(before), decode(after)]);
    } catch {
        return { outcome: "unknown", diffPercent: 0, nearTargetDiff: 0, confidence: 0, reason: "decode_failed" };
    }
    return classifyOutcome(a, b, targetX * k, targetY * k, w, h, {
        ...opts,
        targetRadius: (opts.targetRadius ?? 40) * k,
    });
}

/** Fraction of (strided) pixels whose grey level changed by more than `threshold`. */
function computeGlobalDiff(before: Buffer, after: Buffer, samples: number, threshold: number): number {
    const step = Math.max(1, Math.floor(before.length / Math.max(1, samples)));
    let diffCount = 0;
    let total = 0;
    for (let i = 0; i < before.length; i += step) {
        total++;
        if (Math.abs(before[i] - after[i]) > threshold) diffCount++;
    }
    return total > 0 ? diffCount / total : 1.0;
}

/** Fraction of changed pixels inside the (clamped) box of half-size `radius` around the target. */
function computeRegionalDiff(
    before: Buffer,
    after: Buffer,
    targetX: number,
    targetY: number,
    radius: number,
    imageW: number,
    imageH: number,
    threshold: number,
): number {
    const x0 = Math.max(0, targetX - radius);
    const x1 = Math.min(imageW - 1, targetX + radius);
    const y0 = Math.max(0, targetY - radius);
    const y1 = Math.min(imageH - 1, targetY + radius);
    if (x1 < x0 || y1 < y0) return 0; // target outside the image
    let diffCount = 0;
    let total = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const i = y * imageW + x;
            total++;
            if (Math.abs(before[i] - after[i]) > threshold) diffCount++;
        }
    }
    return total > 0 ? diffCount / total : 0;
}
