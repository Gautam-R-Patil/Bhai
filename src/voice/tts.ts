// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import OpenAI from "openai";

// ── OpenAI Text-to-Speech ─────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
    if (!openaiClient) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("OPENAI_API_KEY not configured for TTS");
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}

// ── Generate Speech ───────────────────────────

export async function textToSpeech(
    text: string,
    voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "nova",
    speed = 1.0
): Promise<Buffer> {
    const client = getOpenAI();

    const response = await client.audio.speech.create({
        model: "tts-1",
        voice,
        input: text,
        speed,
        response_format: "opus",
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
