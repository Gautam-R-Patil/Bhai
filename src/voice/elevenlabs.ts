// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── ElevenLabs Text-to-Speech ──────────────────

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// ── Generate Speech ───────────────────────────

/** MP3 bytes (the format is pinned, so callers can label it audio/mpeg). Multilingual: Hindi replies too. */
export async function elevenLabsTTS(
    text: string,
    voiceId?: string,
    modelId = "eleven_multilingual_v2",
): Promise<Buffer> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

    const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam: male, Bhai is a "he"

    const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
        },
        body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.0,
                use_speaker_boost: true,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}
