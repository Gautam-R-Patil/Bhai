// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffprobePath: () => "/usr/local/bin/ffprobe",
}));

import { runPython } from "../util/python-sidecar.js";
import { detectScenes } from "./scene-detect.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

function mockStat(): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as unknown as fs.Stats);
}

describe("detectScenes — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
    });

    it("returns cached scenes without calling python when cache file exists", async () => {
        const cachedScenes = [
            { index: 0, start: 0, end: 5, duration: 5 },
            { index: 1, start: 5, end: 10, duration: 5 },
        ];
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cachedScenes));

        const result = await detectScenes(VIDEO_PATH, PROJECT_ROOT);

        expect(result).toEqual(cachedScenes);
        expect(runPython).not.toHaveBeenCalled();
    });
});

describe("detectScenes — fallback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    });

    it("falls back to fixed intervals when python throws", async () => {
        vi.mocked(runPython).mockRejectedValue(new Error("scenedetect not found"));
        const cp = await import("node:child_process");
        vi.mocked(cp.execFile).mockImplementation(((_bin: unknown, _args: unknown, optsOrCb: unknown, cb: unknown) => {
            if (typeof optsOrCb === "function") {
                (optsOrCb as (e: unknown, so: string, se: string) => void)(null, "30.0\n", "");
            } else if (typeof cb === "function") {
                (cb as (e: unknown, so: string, se: string) => void)(null, "30.0\n", "");
            }
            return {} as ReturnType<typeof cp.execFile>;
        }) as unknown as typeof cp.execFile);

        const result = await detectScenes(VIDEO_PATH, PROJECT_ROOT);

        expect(result).toHaveLength(6);
        expect(result[0]).toMatchObject({ index: 0, start: 0, end: 5, duration: 5 });
        expect(result[5]).toMatchObject({ index: 5, start: 25, end: 30, duration: 5 });
    });
});
