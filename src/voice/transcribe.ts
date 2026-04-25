// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import OpenAI from "openai";
import fs from "node:fs";

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

// ── OpenRouter Transcription (no separate API key needed) ──
// Uses the existing Convex proxy + Gemini Flash to transcribe audio
// Same pipeline as all other LLM calls — no new keys required.

async function transcribeViaOpenRouter(base64Audio: string, mimeType: string): Promise<string> {
    // Dynamic import to avoid circular deps at boot
    const { getSessionToken } = await import("../session.js");
    const { getConvexSiteUrl } = await import("../config/keys.js");
    const { encryptedFetch } = await import("../crypto-transport.js");

    const sessionToken = await getSessionToken();
    const convexUrl = getConvexSiteUrl();
    if (!sessionToken || !convexUrl) {
        throw new Error("Not authenticated — cannot transcribe via OpenRouter");
    }

    const format = mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") ? "mp3" : "ogg";
    const response = await encryptedFetch(`${convexUrl}/api/llm/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
                {
                    role: "system",
                    content: "You are a precise audio transcription assistant. Transcribe the spoken words from the audio EXACTLY as said. Output ONLY the transcription text — no commentary, no analysis, no formatting, no timestamps. If you cannot hear any speech, output an empty string.",
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "input_audio" as "text",
                            input_audio: { data: base64Audio, format },
                        } as any,
                    ],
                },
            ],
            max_tokens: 1024,
        }),
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`OpenRouter transcription failed: ${response.status} — ${(errData as any).error || "Unknown"}`);
    }

    const data = await response.json() as any;
    return (data.choices?.[0]?.message?.content || "").trim();
}

// ── Public API ───────────────────────────────────

/**
 * Transcribe audio from a file path.
 * Tries Whisper first (if OPENAI_API_KEY/GROQ_API_KEY set), falls back to OpenRouter.
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

    // Fallback: OpenRouter via Convex proxy
    const audioBuffer = fs.readFileSync(audioPath);
    const base64 = audioBuffer.toString("base64");
    const ext = audioPath.split(".").pop()?.toLowerCase() ?? "ogg";
    const mimeType = ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : "audio/ogg";
    return transcribeViaOpenRouter(base64, mimeType);
}

/**
 * Transcribe audio from a Buffer.
 * Tries Whisper first (if OPENAI_API_KEY/GROQ_API_KEY set), falls back to OpenRouter.
 */
export async function transcribeBuffer(
    buffer: Buffer,
    filename = "audio.ogg"
): Promise<string> {
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

    // Fallback: OpenRouter via Convex proxy
    const base64 = buffer.toString("base64");
    return transcribeViaOpenRouter(base64, mimeType);
}
