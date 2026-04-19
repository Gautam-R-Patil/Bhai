// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModel, ModelDownloadBlockedError } from "../util/model-cache.js";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BG_MATTE_PY = join(__dirname, "../python/bg_matte.py");

export interface AlphaMatteOpts {
    confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean>;
}

function buildCacheKey(videoPath: string): string {
    const stat = statSync(videoPath);
    const raw = `${videoPath}::${stat.mtimeMs}::${stat.size}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function generateAlphaMatte(
    videoPath: string,
    projectRoot: string,
    opts?: AlphaMatteOpts,
): Promise<string> {
    const hash = buildCacheKey(videoPath);
    const cacheDir = join(projectRoot, "cache");
    const cachePath = join(cacheDir, `matte-${hash}.mov`);

    if (existsSync(cachePath)) {
        return cachePath;
    }

    mkdirSync(cacheDir, { recursive: true });

    const modelDir = await ensureModel("birefnet", { confirm: opts?.confirm });

    await ensurePythonEnv();

    await runPython(BG_MATTE_PY, [videoPath, modelDir, cachePath], {
        timeoutMs: 30 * 60 * 1000,
    });

    if (!existsSync(cachePath)) {
        throw new Error(`[bg-remove] bg_matte.py did not produce output at expected path: ${cachePath}`);
    }

    return cachePath;
}

export { ModelDownloadBlockedError };
