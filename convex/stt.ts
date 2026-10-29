// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Speech-to-text for /api/stt ─────────────────────────────────
// Claude can't hear audio, so voice notes are transcribed here with any
// OpenAI-compatible /audio/transcriptions API, set in the Convex env:
//   STT_API_KEY   required; no key = the endpoint answers "not configured"
//   STT_BASE_URL  default https://api.openai.com/v1
//                 Groq: https://api.groq.com/openai/v1
//                 Azure OpenAI: https://<resource>.openai.azure.com/openai/v1
//   STT_MODEL     default gpt-4o-mini-transcribe (Groq: whisper-large-v3-turbo;
//                 Azure: the deployment name)

/** Voice notes are short; this also stays under Convex's 20MB request cap. */
export const STT_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
/** Billed like a Haiku call. */
export const STT_CREDIT_COST = 0.25;

export interface SttConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
}

export function sttConfigFromEnv(env: Record<string, string | undefined>): SttConfig | null {
    const apiKey = env.STT_API_KEY?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        baseUrl: (env.STT_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
        model: env.STT_MODEL?.trim() || "gpt-4o-mini-transcribe",
    };
}

export async function transcribeWithProvider(
    cfg: SttConfig,
    audio: Uint8Array<ArrayBuffer>,
    mimeType: string,
    filename: string,
    fetchFn: typeof fetch = fetch,
): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: mimeType }), filename);
    form.append("model", cfg.model);
    form.append("response_format", "json");
    const res = await fetchFn(`${cfg.baseUrl}/audio/transcriptions`, {
        method: "POST",
        // Bearer for OpenAI/Groq, api-key for Azure; each ignores the other.
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "api-key": cfg.apiKey },
        body: form,
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`STT provider ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { text?: unknown };
    return typeof data.text === "string" ? data.text.trim() : "";
}

export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
