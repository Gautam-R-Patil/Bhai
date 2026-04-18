// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── ElevenLabs Text-to-Speech ──────────────────

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// ── Generate Speech ───────────────────────────

export async function elevenLabsTTS(
    text: string,
    voiceId?: string,
    modelId = "eleven_monolingual_v1"
): Promise<Buffer> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

    const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel default

    const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voice}`, {
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

// ── Streaming TTS ─────────────────────────────

export async function elevenLabsStreamTTS(
    text: string,
    voiceId?: string
): Promise<ReadableStream<Uint8Array> | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

    const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

    const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voice}/stream`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
        },
        body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs stream error: ${response.status}`);
    }

    return response.body;
}

// ── List Voices ───────────────────────────────

export async function listVoices(): Promise<Array<{ voice_id: string; name: string }>> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return [];

    const response = await fetch(`${ELEVENLABS_BASE}/voices`, {
        headers: { "xi-api-key": apiKey },
    });

    if (!response.ok) return [];
    const data = await response.json() as { voices: Array<{ voice_id: string; name: string }> };
    return data.voices.map((v) => ({ voice_id: v.voice_id, name: v.name }));
}
