// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { gridScreenshot, withoutGrid } from "./grid-overlay.js";

/** The darkest red value in a base64 image. */
const darkest = async (b64: string) => (await sharp(Buffer.from(b64, "base64")).stats()).channels[0].min;

describe("withoutGrid", () => {
    it("gives back the gridded screenshot without its grid, and passes others through", async () => {
        const white = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#fff" } })
            .png()
            .toBuffer();
        const gridded = await gridScreenshot(white, 400, 160);
        if (!gridded) throw new Error("sharp unusable");
        const b64 = gridded.buf.toString("base64");
        const clean = await withoutGrid(b64);
        if (!clean) throw new Error("no clean copy");
        // The grid's label boxes are dark; the clean copy is the plain white screen.
        expect(await darkest(b64)).toBeLessThan(150);
        expect(await darkest(clean)).toBeGreaterThan(240);
        expect(await withoutGrid(white.toString("base64"))).toBe(white.toString("base64"));
    });
});
