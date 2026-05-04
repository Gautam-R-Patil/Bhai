// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Local ASR — Moonshine (27M) or Whisper via Ollama/local inference.
// 48% lower error than Whisper Tiny. Runs on CPU.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
const execFileAsync = promisify(execFile);

export interface TranscriptionResult {
    text: string;
    language: string;
    confidence: number;
    durationMs: number;
    source: "moonshine" | "whisper" | "macos" | "fallback";
}

export async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
    const start = Date.now();
    if (!fs.existsSync(audioPath)) return { text: "", language: "en", confidence: 0, durationMs: 0, source: "fallback" };

    // Local ASR via Ollama and macOS `osascript` are not currently implemented.
    // The previous Ollama path passed audio as `images: [...]` to `/api/generate`
    // which only accepts that field for vision models — it always failed
    // silently. The macOS path returned a placeholder string. Both removed.
    //
    // Use the cloud transcription pipeline in src/voice/transcribe.ts (Whisper
    // via OpenAI-compatible API) or the Telegram voice message handler
    // (src/voice/telegram-voice.ts) for actual transcription.
    return { text: "", language: "en", confidence: 0, durationMs: Date.now() - start, source: "fallback" };
}
