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
//   AUDIO_MODEL   optional: a chat model that hears audio (gpt-audio / gpt-4o-audio family,
//                 Azure: the deployment name). With it, "analyze" requests get the words
//                 and what else can be heard (background, music, other voices, tone).

/** Voice notes are short; this also stays under Convex's 20MB request cap. */
export const STT_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
/** Billed like a Haiku call. */
export const STT_CREDIT_COST = 0.25;

export interface SttConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    audioModel?: string;
}

export function sttConfigFromEnv(env: Record<string, string | undefined>): SttConfig | null {
    const apiKey = env.STT_API_KEY?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        baseUrl: (env.STT_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
        model: env.STT_MODEL?.trim() || "gpt-4o-mini-transcribe",
        ...(env.AUDIO_MODEL?.trim() ? { audioModel: env.AUDIO_MODEL.trim() } : {}),
    };
}

/**
 * Azure serves its newer transcribe models only on the per-deployment URL, not on
 * /openai/v1 (DeploymentNotFound there), so an Azure base goes to the deployment.
 */
export function transcriptionUrl(cfg: SttConfig): string {
    const azure = cfg.baseUrl.match(/^(https:\/\/[^/]+\.(?:openai|cognitiveservices)\.azure\.com)\/openai\/v1$/);
    return azure
        ? `${azure[1]}/openai/deployments/${encodeURIComponent(cfg.model)}/audio/transcriptions?api-version=2025-04-01-preview`
        : `${cfg.baseUrl}/audio/transcriptions`;
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
    const res = await fetchFn(transcriptionUrl(cfg), {
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

const LISTEN_PROMPT =
    'Listen to this recording. Reply with JSON only: {"transcript": the exact words spoken, in the language spoken ("" if none), "sounds": what else can be heard — background noise, music, other voices, where it seems to be, the speaker\'s tone or mood — in one or two short sentences ("" if nothing notable)}';

/** The words and the rest of what can be heard, from a chat model that takes audio input. */
export async function analyzeWithProvider(
    cfg: SttConfig,
    audio: Uint8Array<ArrayBuffer>,
    format: "mp3" | "wav",
    fetchFn: typeof fetch = fetch,
): Promise<{ text: string; sounds: string }> {
    if (!cfg.audioModel) throw new Error("no audio model");
    let bin = "";
    for (let i = 0; i < audio.length; i += 0x8000) bin += String.fromCharCode(...audio.subarray(i, i + 0x8000));
    const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "api-key": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: cfg.audioModel,
            modalities: ["text"],
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: LISTEN_PROMPT },
                        { type: "input_audio", input_audio: { data: btoa(bin), format } },
                    ],
                },
            ],
        }),
        signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`Audio model ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = String(data.choices?.[0]?.message?.content ?? "");
    try {
        const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? "") as {
            transcript?: unknown;
            sounds?: unknown;
        };
        return {
            text: typeof parsed.transcript === "string" ? parsed.transcript.trim() : "",
            sounds: typeof parsed.sounds === "string" ? parsed.sounds.trim() : "",
        };
    } catch {
        // Not JSON: the model just answered in words; keep them as the transcript.
        return { text: content.trim(), sounds: "" };
    }
}

export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
