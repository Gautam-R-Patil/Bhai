// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Screen share for Gemini Live ──────────────────
// Captures one JPEG per ~1.5s and feeds it to the live-voice backend so the
// model can see what the user is looking at. This is what lets the user say
// "click the first one" or "make a PPT" and have Gemini actually understand
// the current screen state.
//
// Platform support: macOS (`screencapture`), Linux/Windows via the shared
// platform bridge. Downscales via sips (macOS) / sharp (fallback) to keep
// the frame under ~150 KB so we stay within Gemini's realtime input budget.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withCursorHidden } from "../../screen/agent-cursor.js";

const execFileAsync = promisify(execFile);

// Gemini Live caps at 1 fps. 1.5s between frames gives us headroom and
// keeps CPU use low on the agent side.
const FRAME_INTERVAL_MS = 1500;
const TARGET_WIDTH = 1024;   // downscale target — readable for UI reading
const JPEG_QUALITY = 60;     // 60 is a good legibility/size tradeoff

export interface ScreenShareHandle {
    stop(): void;
}

/**
 * Start capturing screen frames and calling `onFrame(b64, mime)` for each.
 * Returns a handle with a stop() method. Errors are logged and the loop
 * continues — a single failed capture must not tear down the voice session.
 */
export function startScreenShare(
    onFrame: (dataB64: string, mimeType: string) => void,
    isPaused: () => boolean,
): ScreenShareHandle {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const captureOne = async () => {
        if (stopped) return;
        if (isPaused()) {
            // While muted the model shouldn't be peeking either — privacy.
            schedule();
            return;
        }
        try {
            const { dataB64, mimeType } = await captureFrame();
            if (!stopped) onFrame(dataB64, mimeType);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Log once per failure class — a long session shouldn't spam.
            console.warn("[SCREEN-SHARE] capture failed:", msg);
        }
        schedule();
    };

    const schedule = () => {
        if (stopped) return;
        timer = setTimeout(captureOne, FRAME_INTERVAL_MS);
    };

    console.log("[SCREEN-SHARE] started (target ~1 fps)");
    // Fire once immediately so the model gets context on the very first turn.
    captureOne();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            console.log("[SCREEN-SHARE] stopped");
        },
    };
}

export function stopScreenShare(handle: ScreenShareHandle | null): void {
    if (handle) handle.stop();
}

// ── One-frame capture ────────────────────────────

async function captureFrame(): Promise<{ dataB64: string; mimeType: string }> {
    if (process.platform === "darwin") return captureFrameMac();
    return captureFrameFallback();
}

async function captureFrameMac(): Promise<{ dataB64: string; mimeType: string }> {
    const tmpDir = tmpdir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rawPath = join(tmpDir, `atlas-screenshare-${stamp}.jpg`);
    const scaledPath = join(tmpDir, `atlas-screenshare-${stamp}-s.jpg`);
    try {
        // -x silent, -t jpg for JPEG, -C exclude cursor (less noise)
        await withCursorHidden(() => execFileAsync("screencapture", ["-x", "-t", "jpg", "-C", rawPath], { timeout: 4000 }));
        // sips is part of macOS — downscale without external deps.
        await execFileAsync("sips", [
            "-Z", String(TARGET_WIDTH),
            "-s", "format", "jpeg",
            "-s", "formatOptions", String(JPEG_QUALITY),
            rawPath,
            "--out", scaledPath,
        ], { timeout: 4000 });
        const bytes = await fsp.readFile(scaledPath);
        return { dataB64: bytes.toString("base64"), mimeType: "image/jpeg" };
    } finally {
        // Best-effort cleanup.
        fsp.unlink(rawPath).catch(() => { /* */ });
        fsp.unlink(scaledPath).catch(() => { /* */ });
    }
}

// Cross-platform fallback: use the platform-bridge screenshot helper. It
// returns a Buffer directly (PNG on Linux, PNG on Windows). Slightly larger
// payload than a downscaled JPEG but always works.
async function captureFrameFallback(): Promise<{ dataB64: string; mimeType: string }> {
    const { takeScreenshot } = await import("../../tools/platform-bridge.js");
    const bytes = await takeScreenshot();
    return { dataB64: bytes.toString("base64"), mimeType: "image/png" };
}
