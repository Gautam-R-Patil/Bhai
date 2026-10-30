// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class FFmpegNotInstalledError extends Error {
    readonly name = "FFmpegNotInstalledError";
    constructor(binary: "ffmpeg" | "ffprobe") {
        super(
            `${binary} binary not found. Run \`npm install\` to restore ffmpeg-static / ffprobe-static, ` +
                `then run \`npx tsx scripts/postinstall-video.ts\` to make them executable.`,
        );
    }
}

let _ffmpegPath: string | null | undefined;
let _ffprobePath: string | null | undefined;

function resolveFFmpeg(): string {
    if (_ffmpegPath !== undefined) return _ffmpegPath as string;

    let resolved: string | null = null;
    try {
        const mod = require("ffmpeg-static") as string | { default: string | null } | null;
        if (typeof mod === "string") {
            resolved = mod;
        } else if (mod && typeof (mod as { default: string | null }).default === "string") {
            resolved = (mod as { default: string }).default;
        }
    } catch {
        resolved = null;
    }

    if (!resolved || !existsSync(resolved)) {
        throw new FFmpegNotInstalledError("ffmpeg");
    }
    _ffmpegPath = resolved;
    return resolved;
}

function resolveFFprobe(): string {
    if (_ffprobePath !== undefined) return _ffprobePath as string;
    // ffprobe-static's darwin "arm64" binary is x86_64: on a Mac without Rosetta it can't
    // start (spawn error -86). A native Homebrew one wins when there is one.
    if (process.platform === "darwin" && process.arch === "arm64" && existsSync("/opt/homebrew/bin/ffprobe")) {
        _ffprobePath = "/opt/homebrew/bin/ffprobe";
        return _ffprobePath;
    }

    let resolved: string | null = null;
    try {
        const mod = require("ffprobe-static") as { path: string } | { default: { path: string } } | null;
        if (mod && typeof (mod as { path: string }).path === "string") {
            resolved = (mod as { path: string }).path;
        } else if (mod && typeof (mod as { default: { path: string } }).default?.path === "string") {
            resolved = (mod as { default: { path: string } }).default.path;
        }
    } catch {
        resolved = null;
    }

    if (!resolved || !existsSync(resolved)) {
        throw new FFmpegNotInstalledError("ffprobe");
    }
    _ffprobePath = resolved;
    return resolved;
}

export function ffmpegPath(): string {
    return resolveFFmpeg();
}

export function ffprobePath(): string {
    return resolveFFprobe();
}

/**
 * The ffprobe to run (on a Mac Homebrew's when there is one, else the shipped one), or null
 * when none is installed. ffprobe-static's darwin build is x86_64: without Rosetta it can't
 * start, so callers fall back to probeWithFfmpeg() when ffprobeCouldNotStart(err).
 */
export function ffprobePathIfAny(): string | null {
    if (process.platform === "darwin") {
        const brew = process.arch === "arm64" ? "/opt/homebrew/bin/ffprobe" : "/usr/local/bin/ffprobe";
        if (existsSync(brew)) return brew;
    }
    try {
        return resolveFFprobe();
    } catch {
        return null;
    }
}

/** The ffprobe process never ran (missing, or an x86_64 binary with no Rosetta: errno -86). */
export function ffprobeCouldNotStart(err: unknown): boolean {
    return typeof (err as { code?: unknown } | null)?.code === "string";
}

export interface MediaProbe {
    duration: number;
    width: number;
    height: number;
    fps: number;
}

/**
 * Reads ffmpeg's input banner (`ffmpeg -hide_banner -i <file>` stderr): the duration
 * (printed to 10 ms), and the first video stream's size and tbr, which is ffprobe's
 * r_frame_rate rounded to 2 decimals. Throws when ffmpeg could not open the input.
 */
export function parseFfmpegBanner(stderr: string): MediaProbe {
    if (!/^Input #0,/m.test(stderr)) {
        throw new Error(stderr.trim().split("\n").at(-1) || "ffmpeg could not read the input");
    }
    const d = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
    const duration = d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 100) / 100 : 0;
    const video = /^\s*Stream #0:\d+.*?: Video: (.*)$/m.exec(stderr)?.[1] ?? "";
    // "1920x1080 [SAR", "1280x720," — but not a codec tag like "0x31637661)".
    const size = /(?:^|[\s,])(\d+)x(\d+)(?=[\s,[]|$)/.exec(video);
    const tbr = /([\d.]+)(k?) tbr/.exec(video);
    const fps = tbr ? Math.round(Number(tbr[1]) * (tbr[2] ? 1000 : 1) * 100) / 100 : 0;
    return { duration, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0, fps };
}

/** Duration, size and fps of a media file, from the bundled ffmpeg instead of ffprobe. */
export function probeWithFfmpeg(file: string, timeoutMs = 30_000): Promise<MediaProbe> {
    return new Promise((resolve, reject) => {
        // Exits 1 ("At least one output file must be specified") after printing the banner.
        execFile(ffmpegPath(), ["-hide_banner", "-i", file], { timeout: timeoutMs }, (err, _stdout, stderr) => {
            if (err?.killed) return reject(err);
            try {
                resolve(parseFfmpegBanner(String(stderr ?? "")));
            } catch (e) {
                reject(e);
            }
        });
    });
}
