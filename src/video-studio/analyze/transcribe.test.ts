// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("node:os", () => ({
    default: {
        tmpdir: () => "/tmp",
    },
    tmpdir: () => "/tmp",
}));
vi.mock("../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));
vi.mock("../util/ffmpeg-bin.js", () => ({
    ffmpegPath: () => "/usr/local/bin/ffmpeg",
}));
vi.mock("../../voice/transcribe.js", () => ({
    transcribeAudio: vi.fn().mockResolvedValue("Hello from cloud Whisper"),
}));

import { transcribeAudio } from "../../voice/transcribe.js";
import { runPython } from "../util/python-sidecar.js";
import { transcribeVideo } from "./transcribe.js";

const PROJECT_ROOT = "/fake/project";
const VIDEO_PATH = "/fake/video.mp4";

const SAMPLE = {
    language: "en",
    segments: [
        {
            start: 0.0,
            end: 3.2,
            text: "Hello world",
            words: [
                { start: 0.0, end: 0.5, word: "Hello", confidence: 0.98 },
                { start: 0.6, end: 1.0, word: "world", confidence: 0.97 },
            ],
        },
    ],
};

async function setupCacheMiss(): Promise<void> {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000, size: 8000 } as unknown as fs.Stats);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    const cp = await import("node:child_process");
    vi.mocked(cp.execFile).mockImplementation(((_b: unknown, _a: unknown, optsOrCb: unknown, cb: unknown) => {
        if (typeof optsOrCb === "function") (optsOrCb as (e: unknown, so: string, se: string) => void)(null, "", "");
        else if (typeof cb === "function") (cb as (e: unknown, so: string, se: string) => void)(null, "", "");
        return {} as ReturnType<typeof cp.execFile>;
    }) as unknown as typeof cp.execFile);
}

describe("transcribeVideo", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await setupCacheMiss();
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(SAMPLE));
    });

    it("extracts 16kHz mono audio via ffmpeg", async () => {
        const cp = await import("node:child_process");
        const spy = vi.mocked(cp.execFile);
        await transcribeVideo(VIDEO_PATH, PROJECT_ROOT);
        const ffmpegCall = spy.mock.calls.find((c) => String(c[0]).includes("ffmpeg"));
        expect(ffmpegCall).toBeDefined();
        if (!ffmpegCall) throw new Error("ffmpeg call not recorded");
        const args = ffmpegCall[1] as string[];
        expect(args[args.indexOf("-ar") + 1]).toBe("16000");
        expect(args[args.indexOf("-ac") + 1]).toBe("1");
    });

    it("returns word-level timestamps from faster-whisper", async () => {
        const result = await transcribeVideo(VIDEO_PATH, PROJECT_ROOT);
        expect(result.segments[0].words).toHaveLength(2);
        expect(result.segments[0].words[0]).toMatchObject({ word: "Hello" });
    });

    it("falls back to cloud Whisper when python sidecar fails", async () => {
        vi.mocked(runPython).mockRejectedValue(new Error("faster-whisper not installed"));
        const result = await transcribeVideo(VIDEO_PATH, PROJECT_ROOT);
        expect(transcribeAudio).toHaveBeenCalled();
        expect(result.segments[0].text).toBe("Hello from cloud Whisper");
        expect(result.segments[0].words).toEqual([]);
    });
});
