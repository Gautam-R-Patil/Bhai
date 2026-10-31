// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// A deck's AI images wait in the server's image queue only until the deck's deadline (before
// create_presentation's timeout); after it a slide gets a stock photo or none, and no new image is ordered.

import { rmSync } from "node:fs";
import sharp from "sharp";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    process.env.BHAI_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-deck-"));
    return { requestImages: vi.fn() };
});
vi.mock("../generate-image.js", () => ({ requestImages: h.requestImages }));

import { clearAssetCache, resolveAssets } from "../presentation/assets.js";

describe("deck images with a slow image queue", () => {
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    // The queue outlasts every wait: requestImages gives up when its waitMs is spent.
    h.requestImages.mockImplementation(async (_req: unknown, waitMs: number) => {
        skew += waitMs;
        throw new Error("The image model's queue is too long right now.");
    });
    const slides = (deadline: number) =>
        ["a", "b", "c"].map((id) => ({ id, opts: { prompt: `slide ${id}`, slideTitle: id, deadline } }));
    afterEach(() => {
        h.requestImages.mockClear();
        clearAssetCache();
        vi.unstubAllGlobals();
        delete process.env.PEXELS_API_KEY;
    });
    afterAll(() => {
        vi.restoreAllMocks();
        rmSync(process.env.BHAI_WORKSPACE as string, { recursive: true, force: true });
    });

    it("stops waiting at the deadline and orders no image after it (no stock key: no image)", async () => {
        const out = await resolveAssets(slides(Date.now() + 100_000), 1);
        expect(h.requestImages).toHaveBeenCalledTimes(1);
        expect(h.requestImages.mock.calls[0][1]).toBeLessThanOrEqual(100_000);
        expect([...out.values()]).toEqual([null, null, null]);
    });

    it("falls back to the stock photo", async () => {
        process.env.PEXELS_API_KEY = "k";
        const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#09f" } }).jpeg().toBuffer();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) =>
                url.includes("api.pexels.com")
                    ? Response.json({ photos: [{ src: { large: "https://img.test/p.jpg" }, photographer: "Ann", url: "https://pexels.test/1" }] })
                    : new Response(jpeg),
            ),
        );
        const out = await resolveAssets(slides(Date.now() + 100_000), 1);
        expect(h.requestImages).toHaveBeenCalledTimes(1);
        expect([...out.values()].map((a) => a?.kind)).toEqual(["photo", "photo", "photo"]);
    });
});
