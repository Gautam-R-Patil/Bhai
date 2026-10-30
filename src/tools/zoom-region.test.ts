// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// os_zoom_region crops with sharp: no Python needed, and its inputs are numbers, never code.
import sharp from "sharp";
import { expect, it } from "vitest";
import "./index.js"; // load the registry first, as the app does (macos.ts is in an import cycle with it)
import { zoomImageRegion } from "./macos.js";

const img = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#fff" } }).png().toBuffer();

it("zooms a region 2x and clamps it to the image", async () => {
    const z = await zoomImageRegion(img, 10, 5, 20, 10);
    expect(z?.size).toBe("40x20");
    expect((await sharp(z!.buffer).metadata()).format).toBe("jpeg");
    expect((await zoomImageRegion(img, 90, 40, 50, 50))?.region).toEqual({ x: 90, y: 40, width: 10, height: 10 });
});

it("refuses anything that isn't a number instead of running it", async () => {
    expect(await zoomImageRegion(img, "0; import os; os.system('id')", 0, 10, 10)).toBeNull();
    expect(await zoomImageRegion(img, 0, 0, 0, 10)).toBeNull();
    expect(await zoomImageRegion(img, 0, 0, undefined, 10)).toBeNull();
    expect(await zoomImageRegion(img, "4", "2", "10", "10")).not.toBeNull(); // numeric strings are fine
});
