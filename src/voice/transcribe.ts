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

// No local Whisper key: transcribe on the server (convex/stt.ts, /api/stt).
// Claude can't hear audio, so this is the only path for regular users; the
// server answers 503 until an STT provider key is set in the Convex env.
export const STT_NOT_CONFIGURED = "Voice transcription isn't set up yet, so I can't read voice messages.";

async function transcribeViaServer(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    const { getSessionToken } = await import("../session.js");
    const { getConvexSiteUrl } = await import("../config/keys.js");
    const { encryptedFetch } = await import("../crypto-transport.js");
    const token = await getSessionToken();
    const site = getConvexSiteUrl();
    if (!token || !site) throw new Error(STT_NOT_CONFIGURED);
    const res = await encryptedFetch(`${site}/api/stt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ audio: buffer.toString("base64"), mimeType, filename }),
        signal: AbortSignal.timeout(90_000),
    });
    // 503: no provider key on the server; 404: a backend without /api/stt yet.
    if (res.status === 503 || res.status === 404) throw new Error(STT_NOT_CONFIGURED);
    if (res.status === 402) throw Object.assign(new Error("You've run out of AI credits."), { status: 402 });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${data.error ?? ""}`.trim());
    return (data.text ?? "").trim();
}

const MIME_BY_EXT: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    mpeg: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    webm: "audio/webm",
    flac: "audio/flac",
};

// ── Public API ───────────────────────────────────

/** Transcribe audio from a file path. See transcribeBuffer. */
export async function transcribeAudio(audioPath: string): Promise<string> {
    const name = audioPath.split(/[\\/]/).pop() || "audio.ogg";
    return transcribeBuffer(fs.readFileSync(audioPath), name);
}

/**
 * Transcribe audio from a Buffer: local Whisper (OPENAI_API_KEY/GROQ_API_KEY)
 * if set, else the server. Throws STT_NOT_CONFIGURED when neither can.
 */
export async function transcribeBuffer(buffer: Buffer, filename = "audio.ogg"): Promise<string> {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "ogg";
    const mimeType = MIME_BY_EXT[ext] ?? "audio/ogg";

    const client = getWhisperClient();
    if (client) {
        const model = whisperProvider === "groq" ? "whisper-large-v3-turbo" : "whisper-1";
        const file = new File([new Uint8Array(buffer)], filename, { type: mimeType });
        const response = await client.audio.transcriptions.create({ model, file, response_format: "text" });
        return response as unknown as string;
    }

    return transcribeViaServer(buffer, filename, mimeType);
}
