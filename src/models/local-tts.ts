// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Local TTS — Chatterbox-Turbo (350M, MIT) or macOS say fallback.
// Sub-200ms latency. Emotion exaggeration control. 23 languages.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const execFileAsync = promisify(execFile);

export interface TTSResult {
    audioPath: string;
    durationMs: number;
    source: "chatterbox" | "macos-say" | "fallback";
}

export async function synthesizeSpeech(
    text: string,
    emotion: "neutral" | "happy" | "sad" | "excited" | "calm" = "neutral",
    outputPath = path.join(tmpdir(), "atlas-tts-output.aiff"),
): Promise<TTSResult> {
    const start = Date.now();

    // Try local Chatterbox via API (if running)
    try {
        const resp = await fetch("http://localhost:8787/synthesize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, emotion, format: "wav" }),
            signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
            const buffer = await resp.arrayBuffer();
            const wavPath = outputPath.replace(/\.\w+$/, ".wav");
            fs.writeFileSync(wavPath, Buffer.from(buffer));
            return { audioPath: wavPath, durationMs: Date.now() - start, source: "chatterbox" };
        }
    } catch { /* */ }

    // Fallback: macOS say command
    try {
        const voice = emotion === "excited" ? "Samantha" : emotion === "calm" ? "Alex" : "Samantha";
        const rate = emotion === "excited" ? "220" : emotion === "calm" ? "160" : "190";
        await execFileAsync("say", ["-v", voice, "-r", rate, "-o", outputPath, text], { timeout: 15000 });
        return { audioPath: outputPath, durationMs: Date.now() - start, source: "macos-say" };
    } catch { /* */ }

    return { audioPath: "", durationMs: Date.now() - start, source: "fallback" };
}
