// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { analyzeImage } from "../../models/local-vision.js";
import { pLimit } from "../../utils/concurrency.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";
import type { Scene } from "./scene-detect.js";

// Call-time wrapper (see Task 6): module-level promisify(execFile) would not
// be intercepted by vi.mock("node:child_process") in tests.
function execFileP(
    bin: string,
    args: string[],
    options: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(bin, args, options, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

export interface KeyframeCaption {
    sceneIndex: number;
    timestamp: number;
    imagePath: string;
    caption: string;
}

const CONCURRENCY = 3;

function buildCaptionCacheKey(videoPath: string, scenes: Scene[]): string {
    const stat = fs.statSync(videoPath);
    const scenesHash = createHash("sha256").update(JSON.stringify(scenes)).digest("hex").slice(0, 8);
    const videoHash = createHash("sha256")
        .update(`${videoPath}::${stat.mtimeMs}::${stat.size}`)
        .digest("hex")
        .slice(0, 8);
    return `${videoHash}-${scenesHash}`;
}

function captionCacheFile(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", "keyframes", `captions-${hash}.json`);
}

function keyframeJpgPath(projectRoot: string, hash: string, sceneIndex: number): string {
    return path.join(projectRoot, "cache", "keyframes", `scene-${hash}-${sceneIndex}.jpg`);
}

async function extractFrame(videoPath: string, timestamp: number, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await execFileP(
        ffmpegPath(),
        ["-ss", String(timestamp), "-i", videoPath, "-frames:v", "1", "-q:v", "2", "-y", outPath],
        { timeout: 30_000 },
    );
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

export async function describeKeyframes(
    videoPath: string,
    scenes: Scene[],
    projectRoot: string,
): Promise<KeyframeCaption[]> {
    const hash = buildCaptionCacheKey(videoPath, scenes);
    const cacheFile = captionCacheFile(projectRoot, hash);
    const partialFile = `${cacheFile}.partial`;

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as KeyframeCaption[];
    }

    const partialMap = new Map<number, KeyframeCaption>();
    if (fs.existsSync(partialFile)) {
        try {
            const partial = JSON.parse(fs.readFileSync(partialFile, "utf-8")) as KeyframeCaption[];
            for (const kf of partial) partialMap.set(kf.sceneIndex, kf);
        } catch {
            // Corrupt partial — ignore, will re-run all scenes
        }
    }

    const tasks = scenes.map((scene) => async (): Promise<KeyframeCaption> => {
        if (partialMap.has(scene.index)) {
            const existing = partialMap.get(scene.index);
            if (existing) return existing;
        }

        const mid = round4((scene.start + scene.end) / 2);
        const imgPath = keyframeJpgPath(projectRoot, hash, scene.index);

        if (!fs.existsSync(imgPath)) {
            await extractFrame(videoPath, mid, imgPath);
        }

        const visionResult = await analyzeImage(
            imgPath,
            "Describe this video frame in one sentence. Focus on subject, action, and setting.",
        );

        const kf: KeyframeCaption = {
            sceneIndex: scene.index,
            timestamp: mid,
            imagePath: imgPath,
            caption: visionResult.description,
        };

        partialMap.set(scene.index, kf);
        fs.writeFileSync(partialFile, JSON.stringify(Array.from(partialMap.values()), null, 2), "utf-8");

        return kf;
    });

    const keyframes = await pLimit(tasks, CONCURRENCY);

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(keyframes, null, 2), "utf-8");
    try {
        fs.unlinkSync(partialFile);
    } catch {
        // already gone
    }

    return keyframes;
}
