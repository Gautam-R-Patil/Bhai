// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeAudio } from "../../voice/transcribe.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";
import { ensurePythonEnv, runPython } from "../util/python-sidecar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export interface TranscriptWord {
    start: number;
    end: number;
    word: string;
    confidence: number;
}

export interface TranscriptSegment {
    start: number;
    end: number;
    text: string;
    words: TranscriptWord[];
}

export interface Transcript {
    language: string;
    segments: TranscriptSegment[];
}

function buildCacheKey(videoPath: string): string {
    const stat = fs.statSync(videoPath);
    return createHash("sha256").update(`${videoPath}::${stat.mtimeMs}::${stat.size}`).digest("hex").slice(0, 16);
}

function cacheFilePath(projectRoot: string, hash: string): string {
    return path.join(projectRoot, "cache", `transcript-${hash}.json`);
}

async function extractAudio(videoPath: string): Promise<string> {
    const tmpWav = path.join(os.tmpdir(), `atlas-vs-audio-${Date.now()}.wav`);
    await execFileP(
        ffmpegPath(),
        ["-i", videoPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", tmpWav],
        { timeout: 120_000 },
    );
    return tmpWav;
}

export async function transcribeVideo(videoPath: string, projectRoot: string, modelSize = "base"): Promise<Transcript> {
    const hash = buildCacheKey(videoPath);
    const cacheFile = cacheFilePath(projectRoot, hash);

    if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Transcript;
    }

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

    const tmpWav = await extractAudio(videoPath);
    let transcript: Transcript;

    try {
        await ensurePythonEnv();
        const scriptPath = path.join(__dirname, "..", "python", "faster_whisper_transcribe.py");
        const tmpOut = `${cacheFile}.tmp.json`;
        await runPython(scriptPath, [tmpWav, tmpOut, modelSize]);
        transcript = JSON.parse(fs.readFileSync(tmpOut, "utf-8")) as Transcript;
        try {
            fs.unlinkSync(tmpOut);
        } catch {
            // non-fatal
        }
    } catch (pyErr) {
        console.warn("[transcribe] faster-whisper failed, falling back to cloud Whisper:", (pyErr as Error).message);
        const plainText = await transcribeAudio(tmpWav);
        transcript = {
            language: "unknown",
            segments: [{ start: 0, end: 0, text: plainText, words: [] }],
        };
    } finally {
        try {
            fs.unlinkSync(tmpWav);
        } catch {
            // non-fatal
        }
    }

    fs.writeFileSync(cacheFile, JSON.stringify(transcript, null, 2), "utf-8");
    return transcript;
}
