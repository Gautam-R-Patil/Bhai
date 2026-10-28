// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import OpenAI from "openai";

// ── Whisper Transcription (when API key available) ──

let openaiClient: OpenAI | null = null;
let whisperProvider: "openai" | "groq" | "none" = "none";

function getWhisperClient(): OpenAI | null {
    if (openaiClient) return openaiClient;

    const openaiKey = process.env.OPENAI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (openaiKey) {
        openaiClient = new OpenAI({ apiKey: openaiKey });
        whisperProvider = "openai";
        return openaiClient;
    } else if (groqKey) {
        openaiClient = new OpenAI({ apiKey: groqKey, baseURL: "https://api.groq.com/openai/v1" });
        whisperProvider = "groq";
        return openaiClient;
    }
    whisperProvider = "none";
    return null;
}

// No Whisper key: there is no other STT backend. The Convex LLM proxy drops
// audio parts (convex/claude.ts), and local ASR (models/local-asr.ts) is a stub,
// so sending audio there yielded empty or hallucinated transcripts. Fail clearly.
export const STT_NOT_CONFIGURED =
    "Voice transcription isn't set up (no OPENAI_API_KEY or GROQ_API_KEY), so I can't read voice messages yet.";

// ── Public API ───────────────────────────────────

/**
 * Transcribe audio from a file path.
 * Uses Whisper (OPENAI_API_KEY/GROQ_API_KEY); throws STT_NOT_CONFIGURED without one.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
    const client = getWhisperClient();
    if (client) {
        const model = whisperProvider === "groq" ? "whisper-large-v3-turbo" : "whisper-1";
        const fileStream = fs.createReadStream(audioPath);
        const response = await client.audio.transcriptions.create({
            model,
            file: fileStream,
            response_format: "text",
        });
        return response as unknown as string;
    }

    throw new Error(STT_NOT_CONFIGURED);
}

/**
 * Transcribe audio from a Buffer.
 * Uses Whisper (OPENAI_API_KEY/GROQ_API_KEY); throws STT_NOT_CONFIGURED without one.
 */
export async function transcribeBuffer(buffer: Buffer, filename = "audio.ogg"): Promise<string> {
    // Derive MIME type from filename extension
    const ext = filename.split(".").pop()?.toLowerCase() ?? "ogg";
    const mimeType = ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : "audio/ogg";

    const client = getWhisperClient();
    if (client) {
        const model = whisperProvider === "groq" ? "whisper-large-v3-turbo" : "whisper-1";
        const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
        const file = new File([blob], filename, { type: mimeType });
        const response = await client.audio.transcriptions.create({
            model,
            file,
            response_format: "text",
        });
        return response as unknown as string;
    }

    throw new Error(STT_NOT_CONFIGURED);
}
