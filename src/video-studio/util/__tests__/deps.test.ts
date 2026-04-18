// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";

describe("video-studio runtime dependencies", () => {
    it("ffmpeg-static resolves to a non-empty string path", async () => {
        const mod = await import("ffmpeg-static");
        const ffmpegPath = (mod as unknown as { default: string | null }).default ?? (mod as unknown as string);
        expect(typeof ffmpegPath).toBe("string");
        expect((ffmpegPath as string).length).toBeGreaterThan(0);
    });

    it("ffprobe-static resolves to an object with ffprobePath", async () => {
        const mod = await import("ffprobe-static");
        const info = (mod as { default: { path: string } }).default ?? mod;
        expect(typeof info).toBe("object");
        expect(typeof (info as { path: string }).path).toBe("string");
        expect((info as { path: string }).path.length).toBeGreaterThan(0);
    });

    it("fluent-ffmpeg exports a callable function", async () => {
        const mod = await import("fluent-ffmpeg");
        const ffmpeg = (mod as { default: unknown }).default ?? mod;
        expect(typeof ffmpeg).toBe("function");
    });
});
