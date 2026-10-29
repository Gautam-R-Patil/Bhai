#!/usr/bin/env npx tsx
// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { chmodSync, existsSync } from "node:fs";

function ensureExecutable(binaryPath: string, label: string): void {
    if (!binaryPath) {
        console.warn(`[postinstall-video] ${label}: path is empty, skipping`);
        return;
    }
    if (!existsSync(binaryPath)) {
        console.warn(`[postinstall-video] ${label}: binary not found at ${binaryPath}, skipping`);
        return;
    }
    if (process.platform === "win32") {
        console.log(`[postinstall-video] ${label}: Windows — chmod not required`);
        return;
    }
    try {
        chmodSync(binaryPath, 0o755);
        console.log(`[postinstall-video] ${label}: chmod 755 -> ${binaryPath}`);
    } catch (err) {
        console.warn(`[postinstall-video] ${label}: chmod failed (non-fatal): ${(err as Error).message}`);
    }
}

async function main(): Promise<void> {
    try {
        const ffmpegMod = await import("ffmpeg-static");
        const ffmpegPath = ((ffmpegMod as unknown as { default: string | null }).default ?? ffmpegMod) as string | null;
        if (ffmpegPath) ensureExecutable(ffmpegPath, "ffmpeg-static");
    } catch (err) {
        console.warn(`[postinstall-video] ffmpeg-static not installed: ${(err as Error).message}`);
    }

    try {
        const ffprobeMod = await import("ffprobe-static");
        const ffprobeInfo = ((ffprobeMod as unknown as { default: { path: string } }).default ?? ffprobeMod) as {
            path: string;
        } | null;
        if (ffprobeInfo?.path) ensureExecutable(ffprobeInfo.path, "ffprobe-static");
    } catch (err) {
        console.warn(`[postinstall-video] ffprobe-static not installed: ${(err as Error).message}`);
    }

    console.log("[postinstall-video] Done.");
}

main().catch((err) => {
    console.warn("[postinstall-video] Unexpected error (non-fatal):", err);
});
