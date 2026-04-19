// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:fs/promises");
vi.mock("node:os");
vi.mock("../python-sidecar.js", () => ({
    ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn().mockResolvedValue(""),
}));

import { ensureModel, ModelDownloadBlockedError, modelCacheDir } from "../model-cache.js";
import { runPython } from "../python-sidecar.js";

const FAKE_HOME = "/fake/home";
const FAKE_CACHE_DIR = `${FAKE_HOME}/.atlas/models`;

function setupBaseMocks(): void {
    vi.mocked(os.homedir).mockReturnValue(FAKE_HOME);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fsPromises.statfs).mockResolvedValue({
        bsize: 4096,
        bavail: 5 * 1024 * 1024,
        blocks: 0,
        bfree: 0,
        files: 0,
        ffree: 0,
    } as unknown as Awaited<ReturnType<typeof fsPromises.statfs>>);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
}

describe("modelCacheDir", () => {
    beforeEach(() => {
        vi.mocked(os.homedir).mockReturnValue(FAKE_HOME);
    });

    it("returns ~/.atlas/models", () => {
        expect(modelCacheDir()).toBe(FAKE_CACHE_DIR);
    });
});

describe("ensureModel — cache hit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
    });

    it("returns model dir immediately when .ready marker exists — no downloader call", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === `${FAKE_CACHE_DIR}/mediapipe_face/.ready`);

        const result = await ensureModel("mediapipe_face");

        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
        expect(runPython).not.toHaveBeenCalled();
    });

    it("also returns immediately for birefnet on cache hit without kill-switch concern", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === `${FAKE_CACHE_DIR}/birefnet/.ready`);

        const result = await ensureModel("birefnet");

        expect(result).toBe(`${FAKE_CACHE_DIR}/birefnet`);
        expect(runPython).not.toHaveBeenCalled();
    });
});

describe("ensureModel — kill switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        process.env.ATLAS_VIDEO_NO_HEAVY = "1";
    });

    afterEach(() => {
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(kill_switch) for birefnet (tier 3)", async () => {
        await expect(ensureModel("birefnet")).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "kill_switch",
        });
    });

    it("does NOT throw for mediapipe_face (tier 2) even when kill switch is on", async () => {
        vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
        const result = await ensureModel("mediapipe_face");
        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
    });
});

describe("ensureModel — disk space check", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(disk_space) when free bytes < requireFreeBytes", async () => {
        vi.mocked(fsPromises.statfs).mockResolvedValue({
            bsize: 4096,
            bavail: 100,
            blocks: 0,
            bfree: 0,
            files: 0,
            ffree: 0,
        } as unknown as Awaited<ReturnType<typeof fsPromises.statfs>>);

        await expect(ensureModel("mediapipe_face")).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "disk_space",
        });
    });

    it("skips disk check when statfs throws ENOSYS", async () => {
        const err = Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
        vi.mocked(fsPromises.statfs).mockRejectedValue(err);
        vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

        const result = await ensureModel("mediapipe_face");
        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
    });

    it("honours custom requireFreeBytes threshold", async () => {
        vi.mocked(fsPromises.statfs).mockResolvedValue({
            bsize: 1024,
            bavail: 300 * 1024,
            blocks: 0,
            bfree: 0,
            files: 0,
            ffree: 0,
        } as unknown as Awaited<ReturnType<typeof fsPromises.statfs>>);

        await expect(ensureModel("mediapipe_face", { requireFreeBytes: 400 * 1024 * 1024 })).rejects.toMatchObject({
            reason: "disk_space",
        });
    });
});

describe("ensureModel — confirm callback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(user_declined) when confirm returns false", async () => {
        const confirm = vi.fn().mockResolvedValue(false);

        await expect(ensureModel("mediapipe_face", { confirm })).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "user_declined",
        });
        expect(confirm).toHaveBeenCalledWith({
            name: "mediapipe_face",
            sizeBytes: 50 * 1024 * 1024,
        });
    });

    it("proceeds with download when confirm returns true", async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

        const result = await ensureModel("mediapipe_face", { confirm });

        expect(confirm).toHaveBeenCalledOnce();
        expect(result).toBe(`${FAKE_CACHE_DIR}/mediapipe_face`);
    });
});

describe("ensureModel — unknown model", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupBaseMocks();
        delete process.env.ATLAS_VIDEO_NO_HEAVY;
    });

    it("throws ModelDownloadBlockedError(no_downloader) for unrecognised model name", async () => {
        await expect(ensureModel("totally_unknown" as never)).rejects.toMatchObject({
            name: "ModelDownloadBlockedError",
            reason: "no_downloader",
        });
    });
});
