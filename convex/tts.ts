// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Text-to-speech for /api/tts ─────────────────────────────────
// Voice replies (WhatsApp voice notes) for installs with no TTS key of their own,
// spoken by any OpenAI-compatible /audio/speech API, set in the Convex env:
//   TTS_API_KEY   required; no key = the endpoint answers "not configured"
//   TTS_BASE_URL  default https://api.openai.com/v1
//                 Azure OpenAI: https://<resource>.openai.azure.com/openai/v1
//   TTS_MODEL     default gpt-4o-mini-tts (Azure: the deployment name)
//   TTS_VOICE     default nova

/** A voice note, not an audiobook. */
export const TTS_MAX_CHARS = 4000;
/** Billed like a Haiku call. */
export const TTS_CREDIT_COST = 0.25;

export interface TtsConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    voice: string;
}

export function ttsConfigFromEnv(env: Record<string, string | undefined>): TtsConfig | null {
    const apiKey = env.TTS_API_KEY?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        baseUrl: (env.TTS_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
        model: env.TTS_MODEL?.trim() || "gpt-4o-mini-tts",
        voice: env.TTS_VOICE?.trim() || "nova",
    };
}

/** Ogg/Opus speech for `text`: what a WhatsApp voice note is made of. */
export async function speakWithProvider(
    cfg: TtsConfig,
    text: string,
    voice: string | undefined,
    fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
    const res = await fetchFn(`${cfg.baseUrl}/audio/speech`, {
        method: "POST",
        // Bearer for OpenAI, api-key for Azure; each ignores the other.
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "api-key": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model, input: text, voice: voice || cfg.voice, response_format: "opus" }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`TTS provider ${res.status}: ${detail}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}

export function encodeBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
