// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { classifyOutcome, classifyOutcomeFromImages } from "../outcome-classifier.js";

const W = 200;
const H = 100;

function grey(fill: number): Buffer {
    return Buffer.alloc(W * H, fill);
}

function paintBox(buf: Buffer, x0: number, y0: number, x1: number, y1: number, v: number): Buffer {
    const out = Buffer.from(buf);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * W + x] = v;
    return out;
}

describe("classifyOutcome (decoded greyscale pixels)", () => {
    it("returns 'unknown' when buffers missing", () => {
        const r = classifyOutcome(null, null, 100, 100, 800, 600);
        expect(r.outcome).toBe("unknown");
        expect(r.confidence).toBe(0);
    });

    it("returns 'unknown' for buffers that aren't W×H pixel arrays (e.g. PNG bytes)", () => {
        const r = classifyOutcome(Buffer.alloc(10), Buffer.alloc(10), 1, 1, W, H);
        expect(r.reason).toBe("size_mismatch");
    });

    it("returns 'no_op' when before and after are identical", () => {
        const r = classifyOutcome(grey(128), grey(128), 100, 50, W, H);
        expect(r.outcome).toBe("no_op");
    });

    it("returns 'success' for a small change right at the target", () => {
        const after = paintBox(grey(128), 95, 45, 105, 55, 250); // 10x10 toggle
        const r = classifyOutcome(grey(128), after, 100, 50, W, H, { targetRadius: 20 });
        expect(r.outcome).toBe("success");
    });

    it("returns 'wrong_target' when the change is far from the target", () => {
        const after = paintBox(grey(128), 150, 0, 200, 100, 250); // right quarter changed
        const r = classifyOutcome(grey(128), after, 20, 50, W, H, { targetRadius: 10 });
        expect(r.outcome).toBe("wrong_target");
    });

    it("returns 'modal_pop' on a large global change away from the target", () => {
        const after = paintBox(grey(128), 60, 0, 200, 100, 250);
        const r = classifyOutcome(grey(128), after, 20, 50, W, H, { targetRadius: 10 });
        expect(r.outcome).toBe("modal_pop");
    });
});

describe("classifyOutcomeFromImages (encoded PNGs, region-relative target)", () => {
    const png = (img: Buffer, w: number, h: number) =>
        sharp(img, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();

    it("decodes a 2x Retina capture and finds the change at the logical target", async () => {
        // Logical region 400x200, captured at 2x = 800x400 px. Toggle at logical (300,150).
        const bw = 800;
        const bh = 400;
        const base = Buffer.alloc(bw * bh, 128);
        const changed = Buffer.from(base);
        for (let y = 290; y < 310; y++) for (let x = 590; x < 610; x++) changed[y * bw + x] = 250;
        const [before, after] = await Promise.all([png(base, bw, bh), png(changed, bw, bh)]);
        const hit = await classifyOutcomeFromImages(before, after, 300, 150, 400, 200, { targetRadius: 20 });
        expect(hit.outcome).toBe("success");
        // Same frames, target elsewhere → change is not near it.
        const miss = await classifyOutcomeFromImages(before, after, 50, 50, 400, 200, { targetRadius: 20 });
        expect(miss.outcome).not.toBe("success");
        expect(miss.nearTargetDiff).toBe(0);
    });

    it("returns 'unknown' when decode fails", async () => {
        const r = await classifyOutcomeFromImages(Buffer.from("nope"), Buffer.from("nope"), 1, 1, 10, 10);
        expect(r.reason).toBe("decode_failed");
    });
});
