// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { mkdir, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBhaiHome } from "../../config/paths.js";

import { runPython } from "./python-sidecar.js";
import { getVSPythonScript } from "./resolve-paths.js";



export type ModelName = "birefnet" | "mediapipe_face";

export interface EnsureModelOpts {
    confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean>;
    requireFreeBytes?: number;
}

export class ModelDownloadBlockedError extends Error {
    readonly reason: "kill_switch" | "disk_space" | "user_declined" | "no_downloader";

    constructor(reason: ModelDownloadBlockedError["reason"], message: string) {
        super(message);
        this.name = "ModelDownloadBlockedError";
        this.reason = reason;
    }
}

export function modelCacheDir(): string {
    return path.join(getBhaiHome(), "models");
}

export async function ensureModel(name: ModelName, opts: EnsureModelOpts = {}): Promise<string> {
    const entry = DOWNLOADERS[name];
    if (!entry) {
        throw new ModelDownloadBlockedError(
            "no_downloader",
            `[model-cache] No downloader registered for model: "${name}"`,
        );
    }

    const dest = path.join(modelCacheDir(), name);
    const readyMarker = path.join(dest, ".ready");

    if (fs.existsSync(readyMarker)) {
        return dest;
    }

    if (entry.tier >= 3 && process.env.BHAI_VIDEO_NO_HEAVY === "1") {
        throw new ModelDownloadBlockedError(
            "kill_switch",
            `[model-cache] Model "${name}" is a Tier-${entry.tier} (heavy) download and ` +
                `BHAI_VIDEO_NO_HEAVY=1 is set. Unset the variable to allow downloads.`,
        );
    }

    const requiredBytes = opts.requireFreeBytes ?? 5 * 1024 ** 3;
    try {
        const stats = await statfs(os.homedir());
        const freeBytes =
            (stats as unknown as { bsize: number; bavail: number }).bsize *
            (stats as unknown as { bsize: number; bavail: number }).bavail;
        if (freeBytes < requiredBytes) {
            throw new ModelDownloadBlockedError(
                "disk_space",
                `[model-cache] Insufficient free disk space for "${name}". ` +
                    `Need ${(requiredBytes / 1024 ** 3).toFixed(1)} GB, ` +
                    `have ${(freeBytes / 1024 ** 3).toFixed(1)} GB.`,
            );
        }
    } catch (err) {
        if (err instanceof ModelDownloadBlockedError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOSYS") throw err;
    }

    if (opts.confirm) {
        const approved = await opts.confirm({ name, sizeBytes: entry.sizeBytes });
        if (!approved) {
            throw new ModelDownloadBlockedError(
                "user_declined",
                `[model-cache] Download of "${name}" was declined by user.`,
            );
        }
    }

    await mkdir(dest, { recursive: true });
    await entry.download(dest);

    return dest;
}

async function downloadBirefnet(dest: string): Promise<void> {
    const scriptPath = getVSPythonScript("model_loader.py");
    await runPython(scriptPath, ["birefnet", dest], { timeoutMs: 30 * 60 * 1000 });
    await writeFile(path.join(dest, ".ready"), new Date().toISOString(), "utf-8");
}

const DOWNLOADERS: Record<ModelName, { sizeBytes: number; tier: 2 | 3; download: (dest: string) => Promise<void> }> = {
    birefnet: {
        sizeBytes: 400 * 1024 * 1024,
        tier: 3,
        download: downloadBirefnet,
    },
    mediapipe_face: {
        sizeBytes: 50 * 1024 * 1024,
        tier: 2,
        download: async (dest: string) => {
            await writeFile(path.join(dest, ".ready"), new Date().toISOString(), "utf-8");
        },
    },
};
