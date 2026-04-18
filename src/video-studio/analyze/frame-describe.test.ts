// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../../models/local-vision.js", () => ({
    analyzeImage: vi.fn().mockResolvedValue({
        description: "A person standing in a field.",
        objects: [],
        textContent: "",
        sceneType: "photo",
        confidence: 0.8,
        source: "smolvlm",
        processingMs: 100,
    }),
}));
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffmpegPath: () => "/usr/local/bin/ffmpeg",
}));

import { analyzeImage } from "../../models/local-vision.js";
import { describeKeyframes } from "./frame-describe.js";
import type { Scene } from "./scene-detect.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

const SCENES: Scene[] = [
    { index: 0, start: 0, end: 6, duration: 6 },
    { index: 1, start: 6, end: 12, duration: 6 },
    { index: 2, start: 12, end: 18, duration: 6 },
];

async function setupCacheMiss(): Promise<void> {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as unknown as fs.Stats);

    const cp = await import("node:child_process");
    vi.mocked(cp.execFile).mockImplementation(((_b: unknown, _a: unknown, optsOrCb: unknown, cb: unknown) => {
        if (typeof optsOrCb === "function") (optsOrCb as (e: unknown, so: string, se: string) => void)(null, "", "");
        else if (typeof cb === "function") (cb as (e: unknown, so: string, se: string) => void)(null, "", "");
        return {} as ReturnType<typeof cp.execFile>;
    }) as unknown as typeof cp.execFile);
}

describe("describeKeyframes", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await setupCacheMiss();
    });

    it("cache hit skips ffmpeg and vision", async () => {
        vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as unknown as fs.Stats);
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const cached = [{ sceneIndex: 0, timestamp: 3, imagePath: "/p/s0.jpg", caption: "c" }];
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cached));

        const result = await describeKeyframes(VIDEO_PATH, SCENES, PROJECT_ROOT);
        expect(result).toEqual(cached);
        expect(analyzeImage).not.toHaveBeenCalled();
    });

    it("calls analyzeImage once per scene", async () => {
        await describeKeyframes(VIDEO_PATH, SCENES, PROJECT_ROOT);
        expect(analyzeImage).toHaveBeenCalledTimes(3);
    });

    it("respects concurrency limit of 3", async () => {
        const many: Scene[] = Array.from({ length: 9 }, (_, i) => ({
            index: i,
            start: i * 5,
            end: (i + 1) * 5,
            duration: 5,
        }));
        let concurrent = 0;
        let maxConcurrent = 0;
        vi.mocked(analyzeImage).mockImplementation(async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
            return {
                description: "frame",
                objects: [],
                textContent: "",
                sceneType: "photo" as const,
                confidence: 0.9,
                source: "smolvlm" as const,
                processingMs: 10,
            };
        });
        await describeKeyframes(VIDEO_PATH, many, PROJECT_ROOT);
        expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
});

describe("describeKeyframes — resilience", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await setupCacheMiss();
    });

    it("continues when the .partial file is corrupt JSON", async () => {
        // existsSync returns true for partialFile specifically
        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
            const s = String(p);
            return s.endsWith(".partial");
        });
        // readFileSync returns garbage when the partial is read
        vi.mocked(fs.readFileSync).mockReturnValue("not valid json{{{");

        // Should not throw; should call analyzeImage for every scene
        await expect(describeKeyframes(VIDEO_PATH, SCENES, PROJECT_ROOT)).resolves.toHaveLength(3);
        expect(analyzeImage).toHaveBeenCalledTimes(3);
    });

    it("JPEG path includes the video+scenes hash", async () => {
        // Capture all mkdirSync calls — look for keyframe directory creation
        await describeKeyframes(VIDEO_PATH, SCENES, PROJECT_ROOT);
        // Find an analyzeImage call; its imagePath argument should contain "scene-" and a hash before the index
        const calls = vi.mocked(analyzeImage).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const imgPath = calls[0][0] as string;
        // Pattern: scene-<hash>-<index>.jpg where hash contains a dash (videoHash-scenesHash)
        expect(imgPath).toMatch(/scene-[a-f0-9]{8}-[a-f0-9]{8}-\d+\.jpg$/);
    });
});
