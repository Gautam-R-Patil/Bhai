// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Gemini Live Backend — WebSocket real-time voice via @google/genai ──

import { GoogleGenAI, Modality } from "@google/genai";
import { LiveVoiceBackend } from "./base.js";
import type { LiveSessionConfig, LiveToolCall, LiveToolResult } from "../types.js";

// ── Gemini Live Session Type ─────────────────────
// The @google/genai SDK returns a Session object from ai.live.connect()
// We define just the interface we need, since exact types may vary across versions.

interface GeminiLiveSession {
    sendRealtimeInput(params: {
        audio?: { data: string; mimeType: string };
        media?: unknown;
        text?: string;
        activityStart?: unknown;
        activityEnd?: unknown;
        audioStreamEnd?: boolean;
    }): void;
    sendClientContent(params: { turns: Array<{ role: string; parts: Array<{ text: string }> }> }): void;
    sendToolResponse(params: { functionResponses: Array<{ id: string; name: string; response: unknown }> }): void;
    close(): void;
}

export class GeminiLiveBackend extends LiveVoiceBackend {
    private apiKey: string;
    private session: GeminiLiveSession | null = null;
    private ai: GoogleGenAI | null = null;
    private setupComplete = false;
    private pendingAudio: Buffer[] = [];

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    async connect(config: LiveSessionConfig): Promise<void> {
        if (this._connected) return;

        this.ai = new GoogleGenAI({ apiKey: this.apiKey });

        // Try models in order — availability changes across API versions
        // Native audio Live API models — only support AUDIO response modality
        const LIVE_MODELS = [
            "gemini-3.1-flash-live-preview",
            "gemini-2.5-flash-live-preview",
        ];

        // Build tool declarations for the session
        const toolConfig = config.tools.length > 0
            ? [{ functionDeclarations: config.tools }]
            : undefined;

        // Native audio Live API models only support AUDIO modality
        const responseModalities = [Modality.AUDIO];

        let lastError = "";
        for (const model of LIVE_MODELS) {
            console.log(`[GEMINI-LIVE] Trying model: ${model}...`);
            try {
                const session = await this.connectToModel(model, config.systemPrompt, responseModalities, toolConfig);
                this.session = session;
                console.log(`[GEMINI-LIVE] Connected successfully to ${model}`);
                return;
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                console.warn(`[GEMINI-LIVE] ${model} failed: ${lastError.substring(0, 100)}`);
            }
        }

        throw new Error(`Gemini Live: all models failed. Last error: ${lastError}`);
    }

    private connectToModel(
        model: string,
        systemPrompt: string,
        responseModalities: any[],
        toolConfig: any[] | undefined,
    ): Promise<GeminiLiveSession> {
        return new Promise<GeminiLiveSession>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Connection timeout (10s)")), 10000);
            let resolved = false;

            // Build config
            const config: Record<string, any> = {
                responseModalities,
                systemInstruction: systemPrompt,
            };
            // Only add tools if we have them (empty array can cause errors)
            if (toolConfig && toolConfig.length > 0) {
                config.tools = toolConfig;
            }

            this.ai!.live.connect({
                model,
                config,
                callbacks: {
                    onopen: () => {
                        console.log(`[GEMINI-LIVE] WebSocket connected (${model})`);
                        this._connected = true;
                        this.emit("connected");
                        // Don't resolve yet — wait for server to acknowledge setup
                    },
                    onmessage: (event: any) => {
                        // Check for setup complete (first message from server)
                        const data = event?.data || event;
                        if (data?.setupComplete || data?.serverContent !== undefined) {
                            if (!this.setupComplete) {
                                this.setupComplete = true;
                                console.log(`[GEMINI-LIVE] Setup complete — ready to send audio`);
                                // Flush any audio that arrived before setup
                                for (const pending of this.pendingAudio) {
                                    this.sendAudioDirect(pending);
                                }
                                this.pendingAudio = [];
                                // NOW resolve — server has acknowledged the session
                                if (!resolved && this.session) {
                                    clearTimeout(timeout);
                                    resolved = true;
                                    resolve(this.session);
                                }
                            }
                        }
                        this.handleMessage(event);
                    },
                    onerror: (event: any) => {
                        const errDetail = event?.error?.message || event?.message || JSON.stringify(event?.error || event || "unknown");
                        console.error(`[GEMINI-LIVE] Error (${model}):`, errDetail);
                        if (!resolved) {
                            clearTimeout(timeout);
                            resolved = true;
                            reject(new Error(errDetail));
                        } else {
                            this.emit("error", new Error(`Gemini Live: ${errDetail}`));
                        }
                    },
                    onclose: (event: any) => {
                        const reason = event?.reason || event?.code || "unknown";
                        console.log(`[GEMINI-LIVE] Disconnected (${model}, reason: ${reason})`);
                        if (!resolved) {
                            clearTimeout(timeout);
                            resolved = true;
                            reject(new Error(`Disconnected immediately: ${reason}`));
                        } else {
                            this._connected = false;
                            this.emit("disconnected");
                        }
                    },
                },
            }).then((session) => {
                // Store session reference but don't resolve — resolution
                // happens in onmessage when setupComplete arrives from server.
                this.session = session as unknown as GeminiLiveSession;
            }).catch((err) => {
                if (!resolved) {
                    clearTimeout(timeout);
                    resolved = true;
                    reject(err);
                }
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.session) {
            try {
                this.session.close();
            } catch { /* */ }
            this.session = null;
        }
        this._connected = false;
        this.setupComplete = false;
        this.pendingAudio = [];
        this.audioChunksSent = 0;
        this.ai = null;
    }

    private audioChunksSent = 0;

    sendAudio(pcm: Buffer): void {
        if (!this.session || !this._connected) return;

        // Queue audio until server setup is acknowledged
        if (!this.setupComplete) {
            this.pendingAudio.push(pcm);
            if (this.pendingAudio.length === 1) {
                console.log(`[GEMINI-LIVE] Queuing audio (waiting for setup)...`);
            }
            return;
        }

        this.sendAudioDirect(pcm);
    }

    private sendAudioDirect(pcm: Buffer): void {
        if (!this.session || !this._connected) return;

        this.audioChunksSent++;
        if (this.audioChunksSent <= 2) {
            console.log(`[GEMINI-LIVE] Sending audio chunk #${this.audioChunksSent}: ${pcm.length} bytes`);
        }

        const base64Audio = pcm.toString("base64");
        try {
            this.session.sendRealtimeInput({
                audio: {
                    data: base64Audio,
                    mimeType: "audio/pcm;rate=16000",
                },
            });
        } catch (err) {
            console.error(`[GEMINI-LIVE] sendRealtimeInput error:`, (err as Error).message);
        }
    }

    interrupt(): void {
        // Gemini Live handles interruption automatically via VAD.
        // When the user starts speaking, the server detects it and
        // cancels the current response. We just need to stop our audio player.
        // Optionally send an activity signal.
    }

    sendToolResponse(results: LiveToolResult[]): void {
        if (!this.session || !this._connected) return;

        try {
            this.session.sendToolResponse({
                functionResponses: results.map(r => ({
                    id: r.id,
                    name: r.name,
                    // Gemini SDK expects `response` to be a Record<string, unknown> with an "output" key,
                    // not a raw string. Wrap string results in { output: ... } format.
                    response: typeof r.result === "string"
                        ? { output: r.result }
                        : (r.result && typeof r.result === "object" ? r.result as Record<string, unknown> : { output: String(r.result) }),
                })),
            });
        } catch (err) {
            console.error("[GEMINI-LIVE] Failed to send tool response:", (err as Error).message);
        }
    }

    sendText(text: string): void {
        if (!this.session || !this._connected) return;

        this.session.sendClientContent({
            turns: [{ role: "user", parts: [{ text }] }],
        });
    }

    // ── Message Handler ──────────────────────────

    private handleMessage(event: any): void {
        const data = event?.data || event;
        if (!data) return;

        // ── Audio response chunks ──
        if (data.serverContent?.modelTurn?.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
                // Audio output
                if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith("audio/")) {
                    const pcmBuffer = Buffer.from(part.inlineData.data, "base64");
                    this.emit("audio", {
                        pcm: pcmBuffer,
                        sampleRate: 24000, // Gemini outputs 24kHz
                        channels: 1 as const,
                    });
                }

                // Text output
                if (part.text) {
                    this.emit("text", part.text);
                }
            }
        }

        // ── Input transcription ──
        if (data.serverContent?.inputTranscription?.text) {
            const raw = String(data.serverContent.inputTranscription.text);
            const filtered = filterNoiseTranscript(raw);
            if (filtered) {
                console.log(`[GEMINI-LIVE] User said: "${filtered}"`);
                this.emit("user_transcript", filtered);
            } else {
                console.log(`[GEMINI-LIVE] Dropped noise transcript: "${raw}"`);
            }
        }

        // ── Output transcription ──
        if (data.serverContent?.outputTranscription?.text) {
            this.emit("transcript", data.serverContent.outputTranscription.text);
        }

        // ── Turn complete ──
        if (data.serverContent?.turnComplete) {
            this.emit("turn_complete");
        }

        // ── Interrupted (user spoke while model was responding) ──
        if (data.serverContent?.interrupted) {
            this.emit("interrupted");
        }

        // ── Tool calls ──
        if (data.toolCall?.functionCalls) {
            const calls: LiveToolCall[] = data.toolCall.functionCalls.map((fc: any) => ({
                id: fc.id || `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: fc.name,
                args: fc.args || {},
            }));
            this.emit("tool_call", calls);
        }

        // ── Tool call cancellation ──
        if (data.toolCallCancellation) {
            const ids: string[] = Array.isArray(data.toolCallCancellation.ids)
                ? data.toolCallCancellation.ids.map((x: unknown) => String(x))
                : [];
            console.log(`[GEMINI-LIVE] Tool call cancelled by server (user interrupted) ids=${ids.join(",") || "unknown"}`);
            this.emit("tool_cancelled", ids);
        }
    }
}

// ── Noise-guard for input transcripts ────────────
// Gemini Live occasionally transcribes background noise / keyboard clicks
// as short strings in random scripts (Korean/Japanese/German). We drop
// obviously-non-speech outputs before they leak into the model turn.

// Specific no-space noise patterns Gemini Live has produced against ATLAS.
// Kept conservative — only strings that are clearly transcription hallucinations
// in the logs, NOT everyday single words. (We deliberately do NOT include
// "はい" / "너도" here because they are legitimate Japanese "yes" / Korean
// "you too" that real users say.)
const KNOWN_NOISE_EXACT = new Set<string>([
    "늘어났구나.", "늘어났구나",
    "ey.", "eh.", "uh.", "ah.", "mm.", "hm.", "um.",
    "Sagen, ey.", "sagen, ey.", "Sagen ey.",
]);

export function filterNoiseTranscript(text: string): string | null {
    const t = text.trim();
    if (t.length < 2) return null;

    // Pure punctuation / whitespace junk
    if (!/[\p{L}\p{N}]/u.test(t)) return null;

    // Treat letters + digits + combining marks as meaningful content (so
    // Devanagari with nasalization like "हाँ" isn't under-counted).
    const content = t.replace(/[^\p{L}\p{N}\p{M}]/gu, "");
    if (content.length < 2) return null;

    // Direct-match known noise exemplars (ASR hallucinations seen in logs).
    if (KNOWN_NOISE_EXACT.has(t)) return null;

    // Very short Latin bursts that are ONLY filler tokens ("uh", "uh hm",
    // "Sagen, ey."). Anchored so mid-sentence "ah I see" passes through.
    if (/^[\s.,?!]*(?:sagen|ey|eh|uh|ah|mm|hm|um)(?:[\s.,?!]+(?:sagen|ey|eh|uh|ah|mm|hm|um))*[\s.,?!]*$/i.test(t)) {
        return null;
    }

    return t;
}
