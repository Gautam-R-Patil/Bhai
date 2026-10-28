// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Coordinate-grid overlay for os_screenshot (mac/linux/windows), in-process via sharp.
 * Replaces scripts/grid_overlay.py (needed Pillow, which neither the Mac nor the
 * packaged app has, so the grid never rendered). Same math as the script: a 1px
 * red line every `gridPx` image pixels, labels in IMAGE pixels (os_click scales
 * them from `width` to the screen), black label box at (x-1,0)..(x+len*7+3,13).
 */

/** The grid as an SVG the size of the resized image. Exported for tests. */
export function buildGridSvg(w: number, h: number, gridPx: number): string {
    const parts: string[] = [];
    // PIL rectangles are inclusive of both corners, hence the +1s in width/height.
    // Text y is the baseline: the script's top-left (tx, ty) ≈ baseline ty+10 at 11px.
    const label = (x0: number, y0: number, x1: number, y1: number, tx: number, ty: number, text: string) => {
        parts.push(
            `<rect x="${x0}" y="${y0}" width="${x1 - x0 + 1}" height="${y1 - y0 + 1}" fill="#000" fill-opacity="0.627"/>`,
        );
        parts.push(`<text x="${tx}" y="${ty + 10}" fill="#fff" fill-opacity="0.863">${text}</text>`);
    };
    // Vertical lines + x labels first, then horizontal (same draw order as the script).
    for (let x = 0; x < w; x += gridPx) {
        parts.push(`<rect x="${x}" y="0" width="1" height="${h}" fill="#f00" fill-opacity="0.157"/>`);
        const t = String(x);
        if (x > 0) label(x - 1, 0, x + t.length * 7 + 3, 13, x + 2, 0, t);
    }
    for (let y = 0; y < h; y += gridPx) {
        parts.push(`<rect x="0" y="${y}" width="${w}" height="1" fill="#f00" fill-opacity="0.157"/>`);
        const t = String(y);
        if (y > 0) label(0, y - 1, t.length * 7 + 3, y + 13, 2, y, t);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" shape-rendering="crispEdges" font-family="Helvetica, Arial, sans-serif" font-size="11">${parts.join("")}</svg>`;
}

/**
 * Resize `input` to `width` px wide (aspect kept), draw the grid, encode JPEG q85.
 * Fail-open: grid fails → resized JPEG without it; sharp unusable → null
 * (caller falls back to its own resize or sends the raw capture).
 */
export async function gridScreenshot(
    input: Buffer,
    width: number,
    gridPx: number,
): Promise<{ buf: Buffer; mime: string } | null> {
    try {
        const sharp = (await import("sharp")).default;
        // keepIccProfile skips the Display P3 → sRGB transform (~180ms on a Retina
        // frame); pixels pass through unconverted. Resizing to raw first, then
        // compositing, is ~2x faster than resize+composite in one pipeline.
        const { data, info } = await sharp(input)
            .resize({ width })
            .keepIccProfile()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const img = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
        try {
            const svg = Buffer.from(buildGridSvg(info.width, info.height, gridPx));
            return {
                buf: await img()
                    .composite([{ input: svg }])
                    .jpeg({ quality: 85 })
                    .toBuffer(),
                mime: "image/jpeg",
            };
        } catch {
            return { buf: await img().jpeg({ quality: 85 }).toBuffer(), mime: "image/jpeg" };
        }
    } catch {
        return null;
    }
}
