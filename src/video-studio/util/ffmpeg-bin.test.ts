// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Golden test: on a Mac with no native ffprobe the video tools read duration,
// size and fps from ffmpeg's input banner. The banners below are ffmpeg-static's
// (the ffmpeg the app ships) for three real clips; `ffprobe` holds what
// `ffprobe -select_streams v:0 -show_entries stream=width,height,r_frame_rate:format=duration`
// reported for the same files.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath, parseFfmpegBanner, probeWithFfmpeg } from "./ffmpeg-bin.js";

const MP4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf60.3.100
  Duration: 00:00:03.50, start: 0.000000, bitrate: 6527 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 6445 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
      encoder         : Lavc60.3.100 libx264
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 69 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
      vendor_id       : [0][0][0][0]
At least one output file must be specified
`;

const WEBM = `Input #0, matroska,webm, from 'clip.webm':
  Metadata:
    ENCODER         : Lavf60.3.100
  Duration: 00:00:02.21, start: -0.007000, bitrate: 271 kb/s
  Stream #0:0: Video: vp9 (Profile 1), gbrp(pc, gbr/unknown/unknown, progressive), 1280x720, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 1k tbn
    Metadata:
      ENCODER         : Lavc60.3.100 libvpx-vp9
      DURATION        : 00:00:02.200000000
  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp
    Metadata:
      ENCODER         : Lavc60.3.100 libopus
      DURATION        : 00:00:02.208000000
At least one output file must be specified
`;

const MOV = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mov':
  Metadata:
    major_brand     : qt
    minor_version   : 512
    compatible_brands: qt
    encoder         : Lavf60.3.100
  Duration: 00:00:04.05, start: 0.000000, bitrate: 962 kb/s
  Stream #0:0[0x1]: Video: mpeg4 (Simple Profile) (mp4v / 0x7634706D), yuv420p, 640x360 [SAR 1:1 DAR 16:9], 190 kb/s, 23.98 fps, 23.98 tbr, 24k tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : FFMP
      encoder         : Lavc60.3.100 mpeg4
  Stream #0:1[0x2]: Audio: pcm_s16le (sowt / 0x74776F73), 48000 Hz, mono, s16, 768 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
      vendor_id       : [0][0][0][0]
At least one output file must be specified
`;

const cases = [
    {
        name: "H.264 MP4",
        banner: MP4,
        ffprobe: { width: 1920, height: 1080, r_frame_rate: "30000/1001", duration: "3.503500" },
    },
    {
        name: "VP9 WebM",
        banner: WEBM,
        ffprobe: { width: 1280, height: 720, r_frame_rate: "25/1", duration: "2.208000" },
    },
    {
        name: "MPEG-4 MOV",
        banner: MOV,
        ffprobe: { width: 640, height: 360, r_frame_rate: "24000/1001", duration: "4.045708" },
    },
];

// timeline-builder's rounding of ffprobe's r_frame_rate.
const fpsOf = (rate: string) => {
    const [n, d] = rate.split("/").map(Number);
    return Math.round((n / d) * 100) / 100;
};

describe("parseFfmpegBanner", () => {
    for (const c of cases) {
        it(`matches ffprobe for ${c.name}`, () => {
            const p = parseFfmpegBanner(c.banner);
            expect(Math.abs(p.duration - Number(c.ffprobe.duration))).toBeLessThanOrEqual(0.01);
            expect(p.width).toBe(c.ffprobe.width);
            expect(p.height).toBe(c.ffprobe.height);
            expect(p.fps).toBe(fpsOf(c.ffprobe.r_frame_rate));
        });
    }

    it("reads a 'k' frame rate and an audio-only file", () => {
        expect(parseFfmpegBanner(MP4.replace("29.97 tbr", "1k tbr")).fps).toBe(1000);
        const audio = parseFfmpegBanner(
            `Input #0, mp3, from 'a.mp3':\n  Duration: 00:01:02.35, start: 0.025057, bitrate: 128 kb/s\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s\n`,
        );
        expect(audio).toEqual({ duration: 62.35, width: 0, height: 0, fps: 0 });
    });

    it("throws when ffmpeg could not open the input", () => {
        expect(() => parseFfmpegBanner("nope.mp4: No such file or directory\n")).toThrow("No such file or directory");
    });
});

describe("probeWithFfmpeg", () => {
    it("probes a real clip with the shipped ffmpeg", async () => {
        const dir = mkdtempSync(join(tmpdir(), "probe-"));
        try {
            const file = join(dir, "c.mp4");
            execFileSync(ffmpegPath(), [
                ...["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30000/1001", "-t", "2"],
                ...["-c:v", "libx264", "-pix_fmt", "yuv420p", file],
            ]);
            const p = await probeWithFfmpeg(file);
            expect(p).toMatchObject({ width: 320, height: 240, fps: 29.97 });
            expect(Math.abs(p.duration - 2)).toBeLessThanOrEqual(0.05);
            await expect(probeWithFfmpeg(join(dir, "missing.mp4"))).rejects.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
