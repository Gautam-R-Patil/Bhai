// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Click-outcome classifier (Phase 5).
 *
 * After every click, classify the screen-state change into one of:
 *   - success       : visible state changed in the expected region (~target bbox)
 *   - no_op         : essentially no change (diff < 0.005)
 *   - modal_pop     : new modal/dialog appeared (large new region in foreground)
 *   - wrong_target  : changes happened but NOT near the target
 *
 * Heuristic-only — no ML, runs in <1ms on a typical 1920×1080 screenshot diff.
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
    /** Sample size for the diff (number of pixel samples). Default 1000. */
    sampleCount?: number;
    /** Pixel-value diff threshold for "counted as changed". Default 10. */
    pixelThreshold?: number;
    /** Bbox half-size (px) around the target for nearTargetDiff. Default 80. */
    targetRadius?: number;
}

/**
 * Classify a click outcome from before/after screenshot buffers + target coord.
 * Buffers can be raw PNG bytes; we sample byte-level so this is approximate but fast.
 *
 * For better accuracy, decode to RGBA first and pass decoded buffers — but the
 * raw-byte mode is adequate for the cascade-router's success-vs-miss gating.
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
    const sampleCount = opts.sampleCount ?? 1000;
    const pixelThreshold = opts.pixelThreshold ?? 10;
    const targetRadius = opts.targetRadius ?? 80;

    const diffPercent = computeByteDiff(before, after, sampleCount, pixelThreshold);
    const nearTargetDiff = computeRegionalDiff(
        before,
        after,
        targetX,
        targetY,
        targetRadius,
        imageWidth,
        imageHeight,
        pixelThreshold,
    );

    // Classify
    if (diffPercent < 0.005) {
        return { outcome: "no_op", diffPercent, nearTargetDiff, confidence: 0.9, reason: "no_visible_change" };
    }

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

    // Near-target change → success
    if (nearTargetDiff >= 0.02) {
        return { outcome: "success", diffPercent, nearTargetDiff, confidence: 0.8, reason: "change_near_target" };
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

/** Pixel-sampled byte diff. Same algorithm as the existing computeScreenDiff. */
function computeByteDiff(before: Buffer, after: Buffer, samples: number, threshold: number): number {
    const minLen = Math.min(before.length, after.length);
    if (minLen < samples) return 1.0;
    const step = Math.max(1, Math.floor(minLen / samples));
    let diffCount = 0;
    let total = 0;
    for (let i = 0; i < minLen; i += step) {
        total++;
        if (Math.abs(before[i] - after[i]) > threshold) diffCount++;
    }
    return total > 0 ? diffCount / total : 1.0;
}

/**
 * Approximate regional diff. Since we're sampling raw PNG bytes (which are NOT a
 * regular grid mapping to pixel coords), we use a proportional offset: the byte
 * offset corresponding to (targetX, targetY) in image space, ± targetRadius rows.
 *
 * This is a HEURISTIC — PNG bytes are compressed, so the offset doesn't map 1:1
 * to pixel coords. For more accuracy, decode to RGBA first and pass the raw
 * decoded buffer.
 */
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
    if (imageW <= 0 || imageH <= 0) return 0;
    const minLen = Math.min(before.length, after.length);
    if (minLen < 1000) return 0;
    // Assume buffer is RGBA-decoded (or compressed but roughly proportional).
    // Map (targetX, targetY) to a fractional offset in [0,1] then to byte index.
    const xFrac = Math.max(0, Math.min(1, targetX / imageW));
    const yFrac = Math.max(0, Math.min(1, targetY / imageH));
    const centerByte = Math.floor((yFrac * imageH + xFrac) * (minLen / (imageW * imageH)));
    const radiusByte = Math.floor(radius * radius * (minLen / (imageW * imageH)));
    const start = Math.max(0, centerByte - radiusByte);
    const end = Math.min(minLen, centerByte + radiusByte);
    if (end <= start) return 0;
    let diffCount = 0;
    let total = 0;
    const step = Math.max(1, Math.floor((end - start) / 500));
    for (let i = start; i < end; i += step) {
        total++;
        if (Math.abs(before[i] - after[i]) > threshold) diffCount++;
    }
    return total > 0 ? diffCount / total : 0;
}
