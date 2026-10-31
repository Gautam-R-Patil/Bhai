// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── screen_record ─────────────────────────────
// Record a short clip of the user's screen for walkthroughs / demos
// that ship on Telegram or WhatsApp. Wraps ffmpeg with per-platform
// input (avfoundation on macOS, x11grab on Linux, gdigrab on Windows).
// Fails open — if ffmpeg isn't installed or screen-capture is denied,
// returns a clear error and the agent falls back to os_screenshot.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getScreenshotsDir } from "../../config/paths.js";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import { logToolAction } from "../../utils/debug-log.js";
import type { ToolDefinition } from "../get-current-time.js";

const MAX_DURATION_SEC = 60; // hard cap
const DEFAULT_DURATION_SEC = 10;
const DEFAULT_FPS = 24;

function ffmpegAvailable(): boolean {
    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

interface PlatformInput {
    inputArgs: string[];
    note: string;
}

function platformInput(): PlatformInput | null {
    if (process.platform === "darwin") {
        // Index "1:none" = primary display, no audio. Index list available
        // via: ffmpeg -f avfoundation -list_devices true -i "".
        return {
            inputArgs: ["-f", "avfoundation", "-framerate", String(DEFAULT_FPS), "-i", "1:none"],
            note: "macOS avfoundation",
        };
    }
    if (process.platform === "linux") {
        const display = process.env.DISPLAY || ":0.0";
        return {
            inputArgs: ["-f", "x11grab", "-framerate", String(DEFAULT_FPS), "-i", display],
            note: "Linux x11grab",
        };
    }
    if (process.platform === "win32") {
        return {
            inputArgs: ["-f", "gdigrab", "-framerate", String(DEFAULT_FPS), "-i", "desktop"],
            note: "Windows gdigrab",
        };
    }
    return null;
}

export const screenRecordTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "screen_record",
            description:
                "Record a short screen clip (default 10s, max 60s) to an MP4 at the given path. " +
                "Used when the user is on Telegram/WhatsApp and a still screenshot isn't enough — " +
                "e.g. demonstrating a UI interaction, showing a build succeed in real time, or a " +
                "walkthrough animation after a complex coding task. Requires ffmpeg on PATH; on macOS " +
                "also requires Screen Recording permission for the parent app (Terminal/Electron). " +
                "Returns { output_path, duration_sec }.",
            parameters: {
                type: "object",
                properties: {
                    duration_sec: {
                        type: "number",
                        description: `Recording length in seconds. Default ${DEFAULT_DURATION_SEC}, max ${MAX_DURATION_SEC}.`,
                    },
                    output_path: {
                        type: "string",
                        description:
                            "Optional destination .mp4 path. Defaults to Bhai Files/Screenshots/recording-<ts>.mp4.",
                    },
                },
            },
        },
    },

    async handler(input) {
        if (!ffmpegAvailable()) {
            return JSON.stringify({
                success: false,
                error: "ffmpeg not found on PATH. Install it (brew install ffmpeg / apt install ffmpeg) or fall back to os_screenshot for a still image.",
            });
        }
        const platform = platformInput();
        if (!platform) {
            return JSON.stringify({
                success: false,
                error: `screen_record not supported on ${process.platform}. Use os_screenshot for a still image.`,
            });
        }

        const rawDuration = Number(input.duration_sec) || DEFAULT_DURATION_SEC;
        const duration = Math.min(MAX_DURATION_SEC, Math.max(1, Math.round(rawDuration)));

        const defaultPath = path.join(getScreenshotsDir(), `recording-${Date.now()}.mp4`);
        const outputPath =
            typeof input.output_path === "string" && input.output_path ? path.resolve(input.output_path) : defaultPath;

        if (!isPathAllowed(outputPath)) {
            return JSON.stringify({
                success: false,
                error: getPathBlockedReason(outputPath) ?? `output path not allowed: ${outputPath}`,
            });
        }
        if (!outputPath.toLowerCase().endsWith(".mp4")) {
            return JSON.stringify({ success: false, error: "output_path must end in .mp4" });
        }

        auditLog("screen_record", { output: outputPath, duration, platform: platform.note });
        logToolAction({
            tool: "screen_record",
            filePath: outputPath,
            action: `record ${duration}s clip (${platform.note})`,
        });

        const args = [
            ...platform.inputArgs,
            "-t",
            String(duration),
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-movflags",
            "+faststart",
            "-y",
            outputPath,
        ];

        const start = Date.now();
        const exitCode: number | null = await new Promise((resolve) => {
            const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr?.on("data", (d: Buffer) => {
                stderr += d.toString("utf-8");
                // Keep only the tail to avoid unbounded buffering
                if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
            });
            child.on("close", (code) => {
                if (code !== 0 && process.env.BHAI_TOOL_DEBUG !== "false") {
                    const tail = stderr.split("\n").slice(-6).join("\n");
                    console.warn(`[screen_record] ffmpeg exit=${code}\n${tail}`);
                }
                resolve(code);
            });
            child.on("error", (err) => {
                console.warn(`[screen_record] ffmpeg spawn failed: ${err.message}`);
                resolve(null);
            });
        });

        if (exitCode !== 0) {
            return JSON.stringify({
                success: false,
                error: `ffmpeg exited with code ${exitCode ?? "null"}. On macOS verify Screen Recording permission for the parent app in System Settings > Privacy & Security.`,
            });
        }
        if (!existsSync(outputPath)) {
            return JSON.stringify({ success: false, error: "ffmpeg returned success but output file is missing" });
        }

        return JSON.stringify({
            success: true,
            output_path: outputPath,
            duration_sec: duration,
            elapsed_ms: Date.now() - start,
        });
    },
};
