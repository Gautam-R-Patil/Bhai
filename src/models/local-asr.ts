// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Local ASR stub.
//
// Historical: this module tried Ollama Whisper and a macOS osascript
// fallback. Both paths were broken (Ollama was called with audio as
// `images: [...]`, which is vision-only; the macOS path returned a
// placeholder string) and always fell through.
//
// For real transcription use src/voice/transcribe.ts (cloud Whisper
// via OpenAI-compatible API, or the server's /api/stt). This
// stub is kept so existing callers still link; it returns an empty
// result with source:"fallback" so they treat it as "no transcription
// available" rather than crashing.

import fs from "node:fs";

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
    // Use src/voice/transcribe.ts (local Whisper key or the server's /api/stt)
    // for actual transcription.
    return { text: "", language: "en", confidence: 0, durationMs: Date.now() - start, source: "fallback" };
}
