// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ffprobePath } from "../util/ffmpeg-bin.js";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";
import { getVSPythonScript } from "../util/resolve-paths.js";



export interface Scene {
    index: number;
    start: number;
    end: number;
    duration: number;
}

interface SceneDetectOutput {
    scenes: Array<{ start: number; end: number; duration: number }>;
}

function buildCacheKey(videoPath: string): string {
    const stat = fs.statSync(videoPath);
    const raw = `${videoPath}::${stat.mtimeMs}::${stat.size}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function cachePath(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", `scenes-${hash}.json`);
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

function execFileP(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) {
                reject(err);
                return;
            }
            resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
}

async function fallbackFixedIntervals(videoPath: string): Promise<Scene[]> {
    const { stdout } = await execFileP(
        ffprobePath(),
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
        30_000,
    );

    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`[scene-detect] ffprobe returned invalid duration for ${videoPath}`);
    }

    const interval = 5;
    const scenes: Scene[] = [];
    let start = 0;
    let index = 0;
    while (start < duration) {
        const end = Math.min(start + interval, duration);
        scenes.push({ index, start: round4(start), end: round4(end), duration: round4(end - start) });
        start = end;
        index++;
    }
    return scenes;
}

export async function detectScenes(videoPath: string, projectRoot: string): Promise<Scene[]> {
    const hash = buildCacheKey(videoPath);
    const cacheFile = cachePath(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Scene[];
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    let scenes: Scene[];

    try {
        await ensurePythonEnv();
        const scriptPath = getVSPythonScript("scene_detect.py");
        const tmpOut = `${cacheFile}.tmp.json`;
        await runPython(scriptPath, [videoPath, tmpOut]);
        const raw = JSON.parse(fs.readFileSync(tmpOut, "utf-8")) as SceneDetectOutput;
        fs.unlinkSync(tmpOut);
        scenes = raw.scenes.map((s, i) => ({
            index: i,
            start: s.start,
            end: s.end,
            duration: s.duration,
        }));
    } catch (err) {
        console.warn("[scene-detect] PySceneDetect failed, falling back to fixed intervals:", (err as Error).message);
        scenes = await fallbackFixedIntervals(videoPath);
    }

    fs.writeFileSync(cacheFile, JSON.stringify(scenes, null, 2), "utf-8");
    return scenes;
}
