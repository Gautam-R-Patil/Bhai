// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("../../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));

import { ensurePythonEnv, runPython } from "../../util/python-sidecar.js";
import type { FaceTrack } from "../face-track.js";
import { detectFaces } from "../face-track.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

const SAMPLE_TRACK: FaceTrack = {
    videoPath: VIDEO_PATH,
    fps: 30.0,
    width: 1920,
    height: 1080,
    frames: [
        { t: 0.0, faces: [{ x: 450, y: 320, w: 180, h: 220, score: 0.98 }] },
        { t: 0.1, faces: [] },
    ],
};

function setupStat(): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000, size: 5000 } as unknown as fs.Stats);
}

describe("detectFaces — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupStat();
    });

    it("returns cached FaceTrack without calling python when cache file exists", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_TRACK));

        const result = await detectFaces(VIDEO_PATH, PROJECT_ROOT);

        expect(result).toEqual(SAMPLE_TRACK);
        expect(runPython).not.toHaveBeenCalled();
        expect(ensurePythonEnv).not.toHaveBeenCalled();
    });
});

describe("detectFaces — cache miss", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
        vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_TRACK));
    });

    it("calls ensurePythonEnv and runPython on cache miss", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        expect(ensurePythonEnv).toHaveBeenCalledOnce();
        expect(runPython).toHaveBeenCalledOnce();
    });

    it("runPython receives script path ending in face_track.py, videoPath, and tmp output path", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        const [scriptArg, posArgs] = vi.mocked(runPython).mock.calls[0] as [string, string[]];
        expect(scriptArg).toContain("face_track.py");
        expect(posArgs[0]).toBe(VIDEO_PATH);
        expect(posArgs[1]).toContain(".tmp.json");
    });

    it("writes parsed result to cache file after successful python call", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
        const cacheWrite = writeCalls.find(([p]) => String(p).includes("faces-") && !String(p).includes(".tmp"));
        expect(cacheWrite).toBeDefined();
        const written = JSON.parse(String(cacheWrite![1])) as FaceTrack;
        expect(written.fps).toBe(30.0);
        expect(written.frames).toHaveLength(2);
    });

    it("unlinkSync is called on the tmp file after reading", async () => {
        await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
    });

    it("rejects with a descriptive error when python output is not valid JSON", async () => {
        vi.mocked(fs.readFileSync).mockReturnValue("NOT_VALID_JSON{{{");
        await expect(detectFaces(VIDEO_PATH, PROJECT_ROOT)).rejects.toThrow(/face-track/i);
    });
});

describe("detectFaces — empty frames", () => {
    it("resolves with empty-frames track when python reports no detections", async () => {
        vi.clearAllMocks();
        setupStat();
        const emptyTrack: FaceTrack = { ...SAMPLE_TRACK, frames: [] };
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(emptyTrack));
        const result = await detectFaces(VIDEO_PATH, PROJECT_ROOT);
        expect(result.frames).toHaveLength(0);
        expect(result.fps).toBe(30.0);
    });
});

describe("detectFaces — cache dir creation", () => {
    it("creates the cache directory (recursive) when it does not exist", async () => {
        vi.clearAllMocks();
        setupStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
        vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE_TRACK));

        await detectFaces(VIDEO_PATH, PROJECT_ROOT);

        expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
            expect.stringContaining("cache"),
            expect.objectContaining({ recursive: true }),
        );
    });
});
