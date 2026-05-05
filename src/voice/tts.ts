// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import OpenAI from "openai";
import { elevenLabsTTS } from "./elevenlabs.js";

export type TtsProvider = "elevenlabs" | "openai" | "none";

export type OpenAIVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
    if (!openaiClient) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("OPENAI_API_KEY not configured for TTS");
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}

// Choose provider in this order: explicit ATLAS_TTS_PROVIDER override →
// ELEVENLABS_API_KEY → OPENAI_API_KEY → none. Keeping the order deterministic
// lets users pin provider without touching code while still getting graceful
// fallback when the preferred key is missing.
function pickProvider(): TtsProvider {
    const override = (process.env.ATLAS_TTS_PROVIDER || "").toLowerCase();
    if (override === "openai" || override === "elevenlabs") return override;
    if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
    if (process.env.OPENAI_API_KEY) return "openai";
    return "none";
}

export function _pickProviderForTests(): TtsProvider {
    return pickProvider();
}

export async function textToSpeech(
    text: string,
    voice: OpenAIVoice = "nova",
    speed = 1.0,
): Promise<Buffer> {
    const provider = pickProvider();
    if (provider === "elevenlabs") {
        return await elevenLabsTTS(text);
    }
    if (provider === "openai") {
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
    throw new Error(
        "No TTS provider configured — set ELEVENLABS_API_KEY or OPENAI_API_KEY",
    );
}
