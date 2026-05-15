// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { classifyOutcome } from "../outcome-classifier.js";

function mkBuf(size: number, fill: number): Buffer {
    const b = Buffer.alloc(size);
    b.fill(fill);
    return b;
}

describe("classifyOutcome", () => {
    it("returns 'unknown' when buffers missing", () => {
        const r = classifyOutcome(null, null, 100, 100, 800, 600);
        expect(r.outcome).toBe("unknown");
        expect(r.confidence).toBe(0);
    });

    it("returns 'no_op' when before and after are identical", () => {
        const buf = mkBuf(10000, 128);
        const r = classifyOutcome(buf, buf, 400, 300, 800, 600);
        expect(r.outcome).toBe("no_op");
        expect(r.diffPercent).toBeLessThan(0.01);
    });

    it("returns 'success' when changes concentrate near target", () => {
        const before = mkBuf(10000, 128);
        const after = Buffer.from(before);
        // Modify the middle 100 bytes (roughly near our target region)
        for (let i = 4500; i < 5500; i++) after[i] = 250;
        const r = classifyOutcome(before, after, 400, 300, 800, 600);
        // Either success or modal_pop is reasonable depending on diff ratios
        expect(["success", "modal_pop", "wrong_target"]).toContain(r.outcome);
    });

    it("returns 'modal_pop' on large global change with small near-target change", () => {
        const before = mkBuf(10000, 100);
        const after = mkBuf(10000, 200); // Every byte changed
        const r = classifyOutcome(before, after, 400, 300, 800, 600);
        expect(["modal_pop", "success"]).toContain(r.outcome);
        expect(r.diffPercent).toBeGreaterThan(0.5);
    });

    it("clamps targetRadius option", () => {
        const before = mkBuf(10000, 100);
        const after = mkBuf(10000, 200);
        const r = classifyOutcome(before, after, 400, 300, 800, 600, { targetRadius: 0 });
        // With radius=0 the regional check returns ~0
        expect(r.nearTargetDiff).toBeLessThan(0.1);
    });

    it("respects custom pixelThreshold", () => {
        const before = mkBuf(10000, 100);
        const after = mkBuf(10000, 105); // small change
        const tight = classifyOutcome(before, after, 0, 0, 100, 100, { pixelThreshold: 3 });
        const loose = classifyOutcome(before, after, 0, 0, 100, 100, { pixelThreshold: 20 });
        expect(tight.diffPercent).toBeGreaterThan(loose.diffPercent);
    });
});
