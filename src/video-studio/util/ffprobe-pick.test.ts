// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// On a Mac with no Homebrew ffprobe the shipped ffprobe-static gives exact durations
// (ffmpeg's banner is only 10 ms); when it can't start (x86_64, no Rosetta) the
// video tools read the banner instead.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("./ffmpeg-bin.js");
    vi.resetModules();
});

describe("ffprobePathIfAny", () => {
    it("falls back to the shipped ffprobe-static when Homebrew has none", async () => {
        vi.resetModules();
        vi.doMock("node:fs", async (orig) => {
            const fs = await orig<typeof import("node:fs")>();
            const existsSync = (p: string) => !/^\/(opt\/homebrew|usr\/local)\/bin\/ffprobe$/.test(p) && fs.existsSync(p);
            return { ...fs, existsSync, default: { ...fs, existsSync } };
        });
        const { ffprobePathIfAny } = await import("./ffmpeg-bin.js");
        expect(ffprobePathIfAny()).toMatch(/ffprobe-static\/bin\/.+\/ffprobe(\.exe)?$/);
    });
});

describe("probeVideoMetadata", () => {
    it("reads ffmpeg's banner when the ffprobe binary can't start", async () => {
        vi.resetModules();
        vi.doMock("../util/ffmpeg-bin.js", async (orig) => ({
            ...(await orig<typeof import("./ffmpeg-bin.js")>()),
            ffprobePathIfAny: () => "/nonexistent/ffprobe",
        }));
        const { ffmpegPath } = await import("./ffmpeg-bin.js");
        const { probeVideoMetadata } = await import("../analyze/timeline-builder.js");
        const dir = mkdtempSync(join(tmpdir(), "probe-pick-"));
        try {
            const file = join(dir, "c.mp4");
            execFileSync(ffmpegPath(), [
                ...["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "1"],
                ...["-c:v", "libx264", "-pix_fmt", "yuv420p", file],
            ]);
            const m = await probeVideoMetadata(file);
            expect(m).toMatchObject({ width: 320, height: 240, fps: 25, resolution: "320x240" });
            expect(m.duration).toBeCloseTo(1, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
