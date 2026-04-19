// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FaceBBox {
    h: number;
    score: number;
    w: number;
    x: number;
    y: number;
}

export interface FaceFrame {
    faces: FaceBBox[];
    t: number;
}

export interface FaceTrack {
    fps: number;
    frames: FaceFrame[];
    height: number;
    videoPath: string;
    width: number;
}

function buildCacheKey(videoPath: string): string {
    const stat = fs.statSync(videoPath);
    const raw = `${videoPath}::${stat.mtimeMs}::${stat.size}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function cacheFilePath(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", `faces-${hash}.json`);
}

export async function detectFaces(videoPath: string, projectRoot: string): Promise<FaceTrack> {
    const hash = buildCacheKey(videoPath);
    const cacheFile = cacheFilePath(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as FaceTrack;
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    await ensurePythonEnv();
    const scriptPath = path.join(__dirname, "..", "python", "face_track.py");
    const tmpOut = `${cacheFile}.tmp.json`;

    await runPython(scriptPath, [videoPath, tmpOut]);

    let track: FaceTrack;
    try {
        track = JSON.parse(fs.readFileSync(tmpOut, "utf-8")) as FaceTrack;
    } catch (err) {
        throw new Error(`[face-track] failed to parse python output: ${(err as Error).message}`);
    }

    try {
        fs.unlinkSync(tmpOut);
    } catch {
        // non-fatal — tmp cleanup failure does not affect result correctness
    }

    fs.writeFileSync(cacheFile, JSON.stringify(track, null, 2), "utf-8");
    return track;
}
