// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildGridSvg, gridScreenshot } from "../grid-overlay.js";

describe("grid overlay (replaces scripts/grid_overlay.py)", () => {
    it("uses the script's line/label math, labels in image pixels", () => {
        const svg = buildGridSvg(1280, 800, 160);
        // x label 320: box (319,0)..(320+3*7+3, 13) inclusive → 26x14, text at (322, top 0)
        expect(svg).toContain('<rect x="319" y="0" width="26" height="14"');
        expect(svg).toContain('<text x="322" y="10"');
        // y label 160: box (0,159)..(3*7+3, 173) inclusive → 25x15, text at (2, top 160)
        expect(svg).toContain('<rect x="0" y="159" width="25" height="15"');
        expect(svg).toContain(">1120</text>");
        expect(svg).not.toContain(">1280</text>"); // range(0, w, grid) excludes w
        expect(svg).not.toContain(">0</text>");
    });

    it("resizes to the target width and actually draws lines + label glyphs", async () => {
        const white = await sharp({ create: { width: 2560, height: 1600, channels: 3, background: "#fff" } })
            .png()
            .toBuffer();
        const out = await gridScreenshot(white, 1280, 160);
        expect(out?.mime).toBe("image/jpeg");
        if (!out) return;
        const { data, info } = await sharp(out.buf).raw().toBuffer({ resolveWithObject: true });
        expect([info.width, info.height]).toEqual([1280, 800]);
        const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];

        expect(Math.min(...px(80, 400))).toBeGreaterThan(240); // off-grid stays white
        const [r, g] = px(480, 400); // vertical line: faint red (JPEG 4:2:0 dilutes the 1px chroma)
        expect(g).toBeLessThan(235);
        expect(r - g).toBeGreaterThan(6);
        // Label box for "160" spans x 159..184, y 0..13: mostly black, with light glyph
        // pixels inside — proves SVG text rendered (fonts resolved), not just the box.
        let dark = 0;
        let light = 0;
        for (let y = 1; y < 13; y++)
            for (let x = 161; x < 183; x++) {
                const v = px(x, y)[1];
                if (v < 130)
                    dark++; // box: 63% black over white ≈ 95
                else if (v > 190) light++; // glyph: 86% white over the box ≈ 233
            }
        expect(dark).toBeGreaterThan(100);
        expect(light).toBeGreaterThan(10);
    });

    it("fails open with null when the input can't be decoded", async () => {
        expect(await gridScreenshot(Buffer.from("not an image"), 1280, 160)).toBeNull();
    });
});
