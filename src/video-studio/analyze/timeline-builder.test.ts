// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffprobePath: () => "/usr/local/bin/ffprobe",
}));
vi.mock("./scene-detect.js", () => ({ detectScenes: vi.fn() }));
vi.mock("./frame-describe.js", () => ({ describeKeyframes: vi.fn() }));
vi.mock("./transcribe.js", () => ({ transcribeVideo: vi.fn() }));

import { describeKeyframes } from "./frame-describe.js";
import { detectScenes } from "./scene-detect.js";
import { buildTimeline, probeVideoMetadata } from "./timeline-builder.js";
import { transcribeVideo } from "./transcribe.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_A = "/fake/videoA.mp4";
const VIDEO_B = "/fake/videoB.mp4";

const MOCK_SCENES = [{ index: 0, start: 0, end: 5, duration: 5 }];
const MOCK_KEYFRAMES = [{ sceneIndex: 0, timestamp: 2.5, imagePath: "/p/s0.jpg", caption: "t" }];
const MOCK_TRANSCRIPT = { language: "en", segments: [{ start: 0, end: 3, text: "Hi", words: [] }] };
const FFPROBE_JSON = JSON.stringify({
    streams: [{ width: 1920, height: 1080, r_frame_rate: "30/1" }],
    format: { duration: "10.0" },
});

async function setupExecFileMock(): Promise<void> {
    const cp = await import("node:child_process");
    vi.mocked(cp.execFile).mockImplementation(((_b: unknown, _a: unknown, optsOrCb: unknown, cb: unknown) => {
        if (typeof optsOrCb === "function")
            (optsOrCb as (e: unknown, so: string, se: string) => void)(null, FFPROBE_JSON, "");
        else if (typeof cb === "function") (cb as (e: unknown, so: string, se: string) => void)(null, FFPROBE_JSON, "");
        return {} as ReturnType<typeof cp.execFile>;
    }) as unknown as typeof cp.execFile);
}

async function setupAllMocks(): Promise<void> {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(detectScenes).mockResolvedValue(MOCK_SCENES);
    vi.mocked(describeKeyframes).mockResolvedValue(MOCK_KEYFRAMES);
    vi.mocked(transcribeVideo).mockResolvedValue(MOCK_TRANSCRIPT);
    await setupExecFileMock();
}

describe("probeVideoMetadata", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await setupExecFileMock();
    });

    it("parses width, height, fps, duration from ffprobe", async () => {
        const meta = await probeVideoMetadata(VIDEO_A);
        expect(meta.width).toBe(1920);
        expect(meta.height).toBe(1080);
        expect(meta.fps).toBe(30);
        expect(meta.duration).toBe(10);
        expect(meta.resolution).toBe("1920x1080");
    });
});

describe("buildTimeline", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await setupAllMocks();
    });

    it("returns a Timeline for a single video", async () => {
        const result = await buildTimeline([VIDEO_A], PROJECT_ROOT);
        expect(result).toHaveProperty("videoPath", VIDEO_A);
        expect(result).toHaveProperty("scenes");
        expect(result).toHaveProperty("keyframes");
        expect(result).toHaveProperty("transcript");
    });

    it("returns a TimelineMap for multiple videos", async () => {
        const result = (await buildTimeline([VIDEO_A, VIDEO_B], PROJECT_ROOT)) as Record<string, unknown>;
        expect(result[VIDEO_A]).toBeDefined();
        expect(result[VIDEO_B]).toBeDefined();
    });

    it("writes timeline.json to projectRoot", async () => {
        await buildTimeline([VIDEO_A], PROJECT_ROOT);
        expect(fs.writeFileSync).toHaveBeenCalledWith(`${PROJECT_ROOT}/timeline.json`, expect.any(String), "utf-8");
    });

    it("throws when videoPaths is empty", async () => {
        await expect(buildTimeline([], PROJECT_ROOT)).rejects.toThrow();
    });
});
