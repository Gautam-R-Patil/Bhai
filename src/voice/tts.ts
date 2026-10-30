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

/**
 * Strip markup that the LLM sometimes leaks into text-mode responses even in
 * voice mode — HTML comments, widget markers, overlay directives, code fences,
 * markdown links, headings, bullet-list prefixes. TTS reads these literally
 * ("widget type colon clock"), which is terrible UX. The voice system prompt
 * already forbids them but LLMs violate it; strip as belt-and-braces. Used by
 * live voice and by every textToSpeech call (WhatsApp voice replies).
 */
export function stripTtsMarkup(text: string): string {
    return text
        // HTML comments (widget markers, collapse/quick_actions, etc)
        .replace(/<!--[\s\S]*?-->/g, "")
        // Code fences — keep the inner text, drop the backticks + language tag
        .replace(/```[a-zA-Z0-9]*\n?/g, "")
        .replace(/```/g, "")
        // Inline code backticks — TTS reads them as "backtick"
        .replace(/`([^`]*)`/g, "$1")
        // Markdown links: [text](url) → text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        // Bold/italic asterisks around words — keep the word
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
        // Heading hashes
        .replace(/^\s*#{1,6}\s+/gm, "")
        // Leading bullet markers on a line (*, -, •, numbered)
        .replace(/^\s*[-*•]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        // Trailing whitespace cleanup
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** Speech for `text`, markup stripped. `mimetype` is what the bytes really are. */
export async function textToSpeech(
    text: string,
    voice: OpenAIVoice = "nova",
    speed = 1.0,
): Promise<{ audio: Buffer; mimetype: string }> {
    text = stripTtsMarkup(text);
    const provider = pickProvider();
    if (provider === "elevenlabs") {
        return { audio: await elevenLabsTTS(text), mimetype: "audio/mpeg" };
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
        return { audio: Buffer.from(await response.arrayBuffer()), mimetype: "audio/ogg; codecs=opus" };
    }
    throw new Error(
        "No TTS provider configured — set ELEVENLABS_API_KEY or OPENAI_API_KEY",
    );
}
