// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { accessSync, constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { FFmpegNotInstalledError, ffmpegPath, ffprobePath } from "../ffmpeg-bin.js";

describe("ffmpeg-bin module", () => {
    it("ffmpegPath() returns a non-empty string", () => {
        const p = ffmpegPath();
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
    });

    it("ffprobePath() returns a non-empty string", () => {
        const p = ffprobePath();
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
    });

    it("ffmpegPath() points to an existing file", () => {
        accessSync(ffmpegPath(), constants.F_OK);
    });

    it("ffprobePath() points to an existing file", () => {
        accessSync(ffprobePath(), constants.F_OK);
    });

    it("ffmpegPath() points to an executable binary on unix", () => {
        if (process.platform === "win32") return;
        accessSync(ffmpegPath(), constants.X_OK);
    });

    it("ffprobePath() points to an executable binary on unix", () => {
        if (process.platform === "win32") return;
        accessSync(ffprobePath(), constants.X_OK);
    });

    it("FFmpegNotInstalledError is a proper Error subclass", () => {
        const err = new FFmpegNotInstalledError("ffmpeg");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("FFmpegNotInstalledError");
        expect(err.message).toContain("ffmpeg");
    });
});
