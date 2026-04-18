// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { accessSync, constants } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ffmpeg-static binary is executable after postinstall", () => {
    it("ffmpeg-static path exists on the filesystem", async () => {
        const mod = await import("ffmpeg-static");
        const ffmpegPath = ((mod as unknown as { default: string | null }).default ?? mod) as string;
        expect(typeof ffmpegPath).toBe("string");
        accessSync(ffmpegPath, constants.F_OK);
    });

    it("ffmpeg-static binary is executable", async () => {
        if (process.platform === "win32") return;
        const mod = await import("ffmpeg-static");
        const ffmpegPath = ((mod as unknown as { default: string | null }).default ?? mod) as string;
        accessSync(ffmpegPath, constants.X_OK);
    });

    it("ffprobe-static binary is executable", async () => {
        if (process.platform === "win32") return;
        const mod = await import("ffprobe-static");
        const info = ((mod as unknown as { default: { path: string } }).default ?? mod) as { path: string };
        accessSync(info.path, constants.X_OK);
    });
});
