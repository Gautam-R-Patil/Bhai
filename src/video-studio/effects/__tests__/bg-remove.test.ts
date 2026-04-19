// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("../../util/model-cache.js", () => ({
    ensureModel: vi.fn(),
    ModelDownloadBlockedError: class ModelDownloadBlockedError extends Error {
        readonly reason: string;
        constructor(reason: string, message = "blocked") {
            super(message);
            this.name = "ModelDownloadBlockedError";
            this.reason = reason;
        }
    },
}));
vi.mock("../../util/python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));

import fs from "node:fs";
import { ensureModel } from "../../util/model-cache.js";
import { runPython } from "../../util/python-sidecar.js";
import { generateAlphaMatte } from "../bg-remove.js";

const VIDEO_PATH = "/fake/video.mp4";
const PROJECT_ROOT = "/fake/project";

function mockStat(mtime = 1000, size = 50000): void {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: mtime, size } as unknown as fs.Stats);
}

describe("generateAlphaMatte — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
    });

    it("returns cached matte path without calling ensureModel or runPython", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const result = await generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT);
        expect(result).toMatch(/matte-[0-9a-f]{16}\.mov$/);
        expect(ensureModel).not.toHaveBeenCalled();
        expect(runPython).not.toHaveBeenCalled();
    });
});

describe("generateAlphaMatte — cache miss", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStat();
        vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it("calls ensureModel('birefnet') then runPython on cache miss", async () => {
        vi.mocked(ensureModel).mockResolvedValue("/fake/models/birefnet");
        vi.mocked(runPython).mockResolvedValue("");
        vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValue(true);

        const result = await generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT);
        expect(ensureModel).toHaveBeenCalledWith("birefnet", expect.any(Object));
        expect(runPython).toHaveBeenCalledWith(
            expect.stringContaining("bg_matte.py"),
            expect.arrayContaining([VIDEO_PATH]),
            expect.objectContaining({ timeoutMs: 30 * 60 * 1000 }),
        );
        expect(result).toMatch(/matte-[0-9a-f]{16}\.mov$/);
    });

    it("surfaces ModelDownloadBlockedError('kill_switch') when kill-switch is on", async () => {
        const { ModelDownloadBlockedError: MDBE } = await import("../../util/model-cache.js");
        vi.mocked(ensureModel).mockRejectedValue(new MDBE("kill_switch", "blocked"));
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT)).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "kill_switch",
        });
        expect(runPython).not.toHaveBeenCalled();
    });

    it("surfaces ModelDownloadBlockedError('user_declined') when user declines confirm", async () => {
        const { ModelDownloadBlockedError: MDBE } = await import("../../util/model-cache.js");
        vi.mocked(ensureModel).mockRejectedValue(new MDBE("user_declined", "blocked"));
        const confirm = vi.fn().mockResolvedValue(false);
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT, { confirm })).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "user_declined",
        });
        expect(runPython).not.toHaveBeenCalled();
    });

    it("propagates timeout error from runPython", async () => {
        vi.mocked(ensureModel).mockResolvedValue("/fake/models/birefnet");
        vi.mocked(runPython).mockRejectedValue(new Error("bg_matte.py timed out after 1800000ms"));
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT)).rejects.toThrow(/timed out/i);
    });

    it("rejects descriptively when runPython succeeds but no output file is created", async () => {
        vi.mocked(ensureModel).mockResolvedValue("/fake/models/birefnet");
        vi.mocked(runPython).mockResolvedValue("");
        await expect(generateAlphaMatte(VIDEO_PATH, PROJECT_ROOT)).rejects.toThrow(
            /bg_matte\.py did not produce output/i,
        );
    });
});
