// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Audio Visualization Tool ────────────────────
// Generates spectrograms, waveforms, and audio metadata using ffmpeg/ffprobe.
// No external binary needed beyond ffmpeg (commonly installed via brew/apt).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);

async function which(binary: string): Promise<boolean> {
    try {
        await execFileAsync("which", [binary], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

export const audioVisualize: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "audio_visualize",
            description:
                "Generate audio visualizations (spectrograms, waveforms) and extract audio metadata using ffmpeg. Requires ffmpeg to be installed.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["spectrogram", "waveform", "info"],
                        description: "Type of visualization or info to generate",
                    },
                    input: {
                        type: "string",
                        description: "Path to the audio file (mp3, wav, flac, ogg, m4a, etc.)",
                    },
                    output: {
                        type: "string",
                        description: "Output image path (default: /tmp/{filename}_{action}.png)",
                    },
                    start: {
                        type: "number",
                        description: "Start time in seconds (for extracting a segment)",
                    },
                    duration: {
                        type: "number",
                        description: "Duration in seconds (for extracting a segment)",
                    },
                    width: {
                        type: "number",
                        description: "Output image width in pixels (default: 1200)",
                    },
                    height: {
                        type: "number",
                        description: "Output image height in pixels (default: 400)",
                    },
                    color_scheme: {
                        type: "string",
                        enum: ["default", "fire", "cool", "magma", "viridis"],
                        description: "Color scheme for spectrogram (default: default)",
                    },
                },
                required: ["action", "input"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;
        const inputPath = input.input as string;
        const width = Math.max(200, Math.min(4000, (input.width as number) || 1200));
        const height = Math.max(100, Math.min(2000, (input.height as number) || 400));
        const start = input.start as number | undefined;
        const duration = input.duration as number | undefined;
        const colorScheme = (input.color_scheme as string) || "default";

        try {
            // Validate input file exists
            if (!existsSync(inputPath)) {
                return JSON.stringify({ error: `Audio file not found: ${inputPath}` });
            }

            // Check ffmpeg is available
            const hasFFmpeg = await which("ffmpeg");
            const hasFFprobe = await which("ffprobe");
            if (!hasFFmpeg) {
                return JSON.stringify({ error: "ffmpeg is not installed. Install with: brew install ffmpeg" });
            }

            // Build time range args
            const timeArgs: string[] = [];
            if (start !== undefined) timeArgs.push("-ss", String(start));
            if (duration !== undefined) timeArgs.push("-t", String(duration));

            const nameBase = basename(inputPath, extname(inputPath));

            switch (action) {
                case "spectrogram": {
                    const outputPath = (input.output as string) || join(tmpdir(), `${nameBase}_spectrogram.png`);

                    // Map color schemes to ffmpeg showspectrumpic color options
                    const colorMap: Record<string, string> = {
                        default: "intensity",
                        fire: "fire",
                        cool: "cool",
                        magma: "magma",
                        viridis: "viridis",
                    };
                    const color = colorMap[colorScheme] || "intensity";

                    const args = [
                        "-y",
                        ...timeArgs,
                        "-i",
                        inputPath,
                        "-lavfi",
                        `showspectrumpic=s=${width}x${height}:color=${color}:scale=log`,
                        outputPath,
                    ];

                    const { stderr } = await execFileAsync("ffmpeg", args, { timeout: 60000 });
                    if (!existsSync(outputPath)) {
                        return JSON.stringify({
                            error: "Failed to generate spectrogram",
                            details: stderr.substring(0, 300),
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        action: "spectrogram",
                        path: outputPath,
                        dimensions: { width, height },
                        color_scheme: colorScheme,
                    });
                }

                case "waveform": {
                    const outputPath = (input.output as string) || join(tmpdir(), `${nameBase}_waveform.png`);

                    const args = [
                        "-y",
                        ...timeArgs,
                        "-i",
                        inputPath,
                        "-filter_complex",
                        `showwavespic=s=${width}x${height}:colors=#4A90D9|#357ABD`,
                        "-frames:v",
                        "1",
                        outputPath,
                    ];

                    const { stderr } = await execFileAsync("ffmpeg", args, { timeout: 60000 });
                    if (!existsSync(outputPath)) {
                        return JSON.stringify({
                            error: "Failed to generate waveform",
                            details: stderr.substring(0, 300),
                        });
                    }

                    return JSON.stringify({
                        success: true,
                        action: "waveform",
                        path: outputPath,
                        dimensions: { width, height },
                    });
                }

                case "info": {
                    if (!hasFFprobe) {
                        return JSON.stringify({ error: "ffprobe is not installed. Install with: brew install ffmpeg" });
                    }

                    const { stdout } = await execFileAsync(
                        "ffprobe",
                        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", inputPath],
                        { timeout: 15000 },
                    );

                    const data = JSON.parse(stdout);
                    const format = data.format || {};
                    const audioStream = (data.streams || []).find(
                        (s: Record<string, unknown>) => s.codec_type === "audio",
                    );

                    return JSON.stringify({
                        success: true,
                        action: "info",
                        file: basename(inputPath),
                        format: format.format_long_name || format.format_name || "unknown",
                        duration_sec: parseFloat(format.duration) || 0,
                        size_bytes: parseInt(format.size) || 0,
                        bit_rate: parseInt(format.bit_rate) || 0,
                        audio: audioStream
                            ? {
                                  codec: audioStream.codec_long_name || audioStream.codec_name,
                                  sample_rate: parseInt(audioStream.sample_rate as string) || 0,
                                  channels: audioStream.channels || 0,
                                  channel_layout: audioStream.channel_layout || "unknown",
                                  bit_depth: audioStream.bits_per_raw_sample || audioStream.bits_per_sample || null,
                              }
                            : null,
                        tags: format.tags || {},
                    });
                }

                default:
                    return JSON.stringify({ error: `Unknown action: ${action}` });
            }
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};
