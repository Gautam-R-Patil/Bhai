// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cloudGroundClick } from "../cloud-grounding.js";
import { findClickTarget } from "../perception-router.js";

// Retina-style capture: a 1568x980 logical window captured at 2x = 3136x1960 px.
async function writeRetinaPng(): Promise<string> {
    const p = join(tmpdir(), `atlas_cg_scale_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    const buf = await sharp({ create: { width: 3136, height: 1960, channels: 3, background: "#fff" } }).png().toBuffer();
    await fs.writeFile(p, buf);
    return p;
}

describe("cloudGroundClick — downscale + coordinate space", () => {
    it("sends a ≤1568px image, tells the model its size, and reports the SENT dims", async () => {
        const png = await writeRetinaPng();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let seen: any;
        const llm = {
            chat: async (params: unknown) => {
                seen = params;
                return { choices: [{ message: { content: 'thinking {draft} … {"x": 784, "y": 490, "confidence": 0.9}' } }] };
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const r = await cloudGroundClick(png, "the Save button", { llm });
        expect(r.error).toBeUndefined();
        expect(r.imageWidth).toBe(1568);
        expect(r.imageHeight).toBe(980);
        expect({ x: r.x, y: r.y }).toEqual({ x: 784, y: 490 });
        expect(seen.systemPrompt).toMatch(/grounding/i);
        expect(seen.thinkingLevel).toBe("low");
        expect(seen.modelOverride).toBe("anthropic/claude-haiku-4.5"); // Sonnet only on a verified miss
        expect(seen.messages[0].content[0].text).toContain("1568x980");
        const url: string = seen.messages[0].content[1].image_url.url;
        const sent = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
        expect([sent.width, sent.height]).toEqual([1568, 980]);
    });

    it("maps sent-image coords to absolute screen coords via the window dims", async () => {
        const png = await writeRetinaPng();
        const llm = {
            chat: async () => ({ choices: [{ message: { content: '{"x": 784, "y": 490, "confidence": 0.9}' } }] }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const r = await findClickTarget("the Save button", {
            screenshotPath: png,
            forceProfile: "standard",
            skipTiers: ["memory", "ax_exact", "ax_fuzzy", "omniparser"],
            // Window at (100,50), 1568x980 logical — image center → window center.
            screenDims: { width: 1568, height: 980, scale: 2, monitorId: "test", originX: 100, originY: 50 },
            llm,
        });
        expect(r?.source).toBe("cloud_grounding");
        expect({ x: r?.x, y: r?.y }).toEqual({ x: 884, y: 540 });
    });

    it("times out instead of hanging", async () => {
        const png = await writeRetinaPng();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const llm = { chat: () => new Promise(() => {}) } as any;
        const r = await cloudGroundClick(png, "x", { llm, timeoutMs: 50 });
        expect(r.error).toMatch(/timeout/);
    });
});
