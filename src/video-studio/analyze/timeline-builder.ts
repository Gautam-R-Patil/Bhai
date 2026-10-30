// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffprobeCouldNotStart, ffprobePathIfAny, probeWithFfmpeg } from "../util/ffmpeg-bin.js";
import type { KeyframeCaption } from "./frame-describe.js";
import { describeKeyframes } from "./frame-describe.js";
import type { Scene } from "./scene-detect.js";
import { detectScenes } from "./scene-detect.js";
import type { Transcript } from "./transcribe.js";
import { transcribeVideo } from "./transcribe.js";

// Call-time wrapper so vi.mock("node:child_process") intercepts us in tests
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

export interface VideoMetadata {
    duration: number;
    fps: number;
    resolution: string;
    width: number;
    height: number;
}

export interface Timeline {
    videoPath: string;
    duration: number;
    fps: number;
    resolution: string;
    width: number;
    height: number;
    scenes: Scene[];
    keyframes: KeyframeCaption[];
    transcript: Transcript;
}

export type TimelineMap = Record<string, Timeline>;

export async function probeVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    const fromFfmpeg = async (): Promise<VideoMetadata> => {
        const { duration, fps, width, height } = await probeWithFfmpeg(videoPath);
        return { duration, fps, resolution: width && height ? `${width}x${height}` : "unknown", width, height };
    };
    const ffprobe = ffprobePathIfAny();
    if (!ffprobe) return fromFfmpeg();
    let stdout: string;
    try {
        ({ stdout } = await execFileP(
            ffprobe,
            [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,r_frame_rate:format=duration",
                "-of",
                "json",
                videoPath,
            ],
            { timeout: 30_000 },
        ));
    } catch (err) {
        if (ffprobeCouldNotStart(err)) return fromFfmpeg();
        throw err;
    }

    const data = JSON.parse(stdout) as {
        streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
        format?: { duration?: string };
    };

    const stream = data.streams?.[0] ?? {};
    const width = stream.width ?? 0;
    const height = stream.height ?? 0;
    const resolution = width && height ? `${width}x${height}` : "unknown";

    const [numStr, denStr] = (stream.r_frame_rate ?? "0/1").split("/");
    const fps = denStr && Number(denStr) !== 0 ? Math.round((Number(numStr) / Number(denStr)) * 100) / 100 : 0;

    const duration = Number.parseFloat(data.format?.duration ?? "0");

    return { duration, fps, resolution, width, height };
}

export async function buildSingleTimeline(videoPath: string, projectRoot: string): Promise<Timeline> {
    const [metadata, scenes] = await Promise.all([probeVideoMetadata(videoPath), detectScenes(videoPath, projectRoot)]);

    const [keyframes, transcript] = await Promise.all([
        describeKeyframes(videoPath, scenes, projectRoot),
        transcribeVideo(videoPath, projectRoot),
    ]);

    return {
        videoPath,
        duration: metadata.duration,
        fps: metadata.fps,
        resolution: metadata.resolution,
        width: metadata.width,
        height: metadata.height,
        scenes,
        keyframes,
        transcript,
    };
}

export async function buildTimeline(videoPaths: string[], projectRoot: string): Promise<Timeline | TimelineMap> {
    if (videoPaths.length === 0) {
        throw new Error("[timeline-builder] videoPaths must not be empty");
    }

    const timelineJsonPath = path.join(projectRoot, "timeline.json");

    if (videoPaths.length === 1) {
        const timeline = await buildSingleTimeline(videoPaths[0], projectRoot);
        fs.writeFileSync(timelineJsonPath, JSON.stringify(timeline, null, 2), "utf-8");
        return timeline;
    }

    const entries = await Promise.all(videoPaths.map((vp) => buildSingleTimeline(vp, projectRoot)));

    const map: TimelineMap = {};
    for (const entry of entries) {
        map[entry.videoPath] = entry;
    }

    fs.writeFileSync(timelineJsonPath, JSON.stringify(map, null, 2), "utf-8");
    return map;
}
