// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

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
