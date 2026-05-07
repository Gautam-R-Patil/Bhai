// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Gemini Live Backend — WebSocket real-time voice via @google/genai ──

import { GoogleGenAI, Modality, FunctionResponseScheduling } from "@google/genai";
import { LiveVoiceBackend } from "./base.js";
import type { LiveSessionConfig, LiveToolCall, LiveToolResult } from "../types.js";

// ── Gemini Live Session Type ─────────────────────
// The @google/genai SDK returns a Session object from ai.live.connect()
// We define just the interface we need, since exact types may vary across versions.

interface GeminiLiveSession {
    sendRealtimeInput(params: {
        audio?: { data: string; mimeType: string };
        video?: { data: string; mimeType: string };
        media?: unknown;
        text?: string;
        activityStart?: unknown;
        activityEnd?: unknown;
        audioStreamEnd?: boolean;
    }): void;
    sendClientContent(params: { turns: Array<{ role: string; parts: Array<{ text: string }> }> }): void;
    sendToolResponse(params: {
        functionResponses: Array<{
            id: string;
            name: string;
            response: unknown;
            scheduling?: "INTERRUPT" | "WHEN_IDLE" | "SILENT";
        }>;
    }): void;
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

        // Primary: gemini-2.5-flash-native-audio-preview-12-2025 — the latest
        // dated preview, cheapest at $10/M out, verified to actually respond
        // via scripts/test-gemini-live.ts (70 messages on a plain "time now?"
        // turn, including audio chunks + gen_complete + turn_complete).
        //
        // IMPORTANT: do NOT put gemini-3.1-flash-live-preview ahead of this.
        // That model connects + consumes audio + fires tool calls BUT never
        // emits audio or text back — a black hole against v1beta. Direct
        // verification: harness run 2026-05-07 showed 1 message (setup) over
        // 40s vs 70 messages from 2.5-native-audio for the same request. It
        // stays in the chain only so if Google ever flips a feature flag,
        // auto-reconnect will pick it up.
        const LIVE_MODELS = [
            "gemini-2.5-flash-native-audio-preview-12-2025",
            "gemini-2.5-flash-native-audio-latest",
            "gemini-2.5-flash-native-audio-preview-09-2025",
            "gemini-2.0-flash-live-preview-04-09",
            "gemini-3.1-flash-live-preview",
        ];

        // Build tool declarations for the session
        const toolConfig = config.tools.length > 0
            ? [{ functionDeclarations: config.tools }]
            : undefined;

        // All models in LIVE_MODELS support AUDIO-only response modality.
        const responseModalities = [Modality.AUDIO];

        let lastError = "";
        for (const model of LIVE_MODELS) {
            console.log(`[GEMINI-LIVE] Trying model: ${model}...`);
            try {
                const session = await this.connectToModel(
                    model,
                    config.systemPrompt,
                    responseModalities,
                    toolConfig,
                    config.voiceName,
                );
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
        voiceName: string | undefined,
    ): Promise<GeminiLiveSession> {
        return new Promise<GeminiLiveSession>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Connection timeout (10s)")), 10000);
            let resolved = false;

            // Build config
            const config: Record<string, any> = {
                responseModalities,
                systemInstruction: systemPrompt,
                // Request text transcripts of model audio responses so the UI can
                // display what the assistant is saying (without this, the overlay
                // never receives response_transcript events — silent UI).
                outputAudioTranscription: {},
                // Server-side VAD for input — user's speech auto-detected + transcribed.
                inputAudioTranscription: {},
                // Tighten generation so voice responses stay snappy. Long, rambling
                // TTS responses are the #1 voice-AI UX complaint.
                temperature: 0.85,
                // Keep responses short — voice mode should feel conversational,
                // not essay-like. Roughly 30-60 spoken seconds max per turn.
                maxOutputTokens: 600,
            };
            // Disable "thinking" tokens — only applies to native-audio models.
            // The half-cascade `gemini-live-2.5-flash-preview` doesn't expose
            // thinkingConfig and Google's validator may reject unknown fields.
            if (/native-audio/.test(model)) {
                config.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
            }
            // NOTE: enableAffectiveDialog is Vertex-only per the SDK docs.
            // The Gemini Developer API path (which we use) silently drops or
            // rejects it. Emotion mirroring is handled in the prompt instead.
            // Honor the user's voice preference. Gemini Live defaults to Puck;
            // valid names include Aoede / Charon / Kore / Fenrir / Puck.
            if (voiceName) {
                config.speechConfig = {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                };
            }
            // Only add tools if we have them (empty array can cause errors)
            if (toolConfig && toolConfig.length > 0) {
                config.tools = toolConfig;
            }

            if (!this.ai) {
                clearTimeout(timeout);
                reject(new Error("GoogleGenAI client not initialized"));
                return;
            }

            this.ai.live.connect({
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
        this.audioChunksReceived = 0;
        this.ai = null;
    }

    private audioChunksSent = 0;
    private audioChunksReceived = 0;

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

    /**
     * Send one screen frame (JPEG recommended) to the model. Gemini Live
     * caps at 1 frame/second — callers should throttle. Skips silently
     * if we're not connected yet so the screen-capture loop can keep
     * running across reconnects without crashing.
     */
    override sendVideo(dataB64: string, mimeType: string = "image/jpeg"): void {
        if (!this.session || !this._connected || !this.setupComplete) return;
        try {
            this.session.sendRealtimeInput({ video: { data: dataB64, mimeType } });
        } catch (err) {
            console.warn("[GEMINI-LIVE] sendVideo failed:", (err as Error).message);
        }
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
                    // `scheduling` only applies to NON_BLOCKING function calls;
                    // our tools are all blocking (the default), so the server
                    // ignores this field. We still set it using the SDK enum
                    // as forward-compat in case we ever flag a tool as
                    // non-blocking — the wire value will be correct.
                    scheduling: FunctionResponseScheduling.INTERRUPT,
                })),
            });
        } catch (err) {
            console.error("[GEMINI-LIVE] Failed to send tool response:", (err as Error).message);
        }
    }

    /**
     * Mid-session text nudge (memory updates, long-task completion, etc.).
     *
     * Per the @google/genai docs for the 3.x Live models:
     *   "send_client_content is ONLY supported for seeding INITIAL context
     *    history... After the first model turn, use send_realtime_input with
     *    the text field instead."
     *
     * Using sendClientContent after the first turn is silently rejected by
     * the newer models — the context never reaches the session and the model
     * appears to ignore the memory injection or background notification.
     * Route all mid-session text through sendRealtimeInput.
     */
    sendText(text: string): void {
        if (!this.session || !this._connected || !this.setupComplete) return;
        try {
            this.session.sendRealtimeInput({ text });
        } catch (err) {
            console.warn("[GEMINI-LIVE] sendText (realtime) failed:", (err as Error).message);
        }
    }

    /**
     * Seed the conversation with an initial user turn. Only safe BEFORE the
     * first model turn — matches the sendClientContent contract for 3.x Live.
     * Not currently used but exposed for callers that need initial history.
     */
    seedInitialHistory(text: string): void {
        if (!this.session || !this._connected) return;
        try {
            this.session.sendClientContent({
                turns: [{ role: "user", parts: [{ text }] }],
            });
        } catch (err) {
            console.warn("[GEMINI-LIVE] seedInitialHistory failed:", (err as Error).message);
        }
    }

    // ── Message Handler ──────────────────────────

    private handleMessage(event: any): void {
        const data = event?.data || event;
        if (!data) return;

        // DIAGNOSTIC: log EVERY server message type so we can see exactly what
        // Gemini sends back after a tool result. If there's no modelTurn or
        // turnComplete after a tool, we know the server isn't generating a
        // response at all (as opposed to us not handling it correctly).
        if (process.env.ATLAS_LIVE_DEBUG === "true") {
            const keys = Object.keys(data || {});
            const sc = data.serverContent ? Object.keys(data.serverContent) : [];
            console.log(`[GEMINI-LIVE][DEBUG] msg keys=${keys.join(",")} serverContent.keys=${sc.join(",")}`);
        }

        // ── Audio response chunks ──
        if (data.serverContent?.modelTurn?.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
                // Audio output
                if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith("audio/")) {
                    const pcmBuffer = Buffer.from(part.inlineData.data, "base64");
                    this.audioChunksReceived++;
                    if (this.audioChunksReceived === 1 || this.audioChunksReceived % 50 === 0) {
                        console.log(`[GEMINI-LIVE] Received model audio chunk #${this.audioChunksReceived} (${pcmBuffer.length}B)`);
                    }
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
            // Always emit the raw chunk so hybrid mode can accumulate without
            // losing single-letter/low-content fragments ("w", "I", "2") that
            // legitimately make up longer words. The noise filter is useful
            // for display/log purposes only — not for semantic concat.
            this.emit("user_transcript_raw", raw);
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
            console.log("[GEMINI-LIVE] serverContent.turnComplete");
            this.emit("turn_complete");
        }

        // ── Interrupted (user spoke while model was responding) ──
        if (data.serverContent?.interrupted) {
            console.log("[GEMINI-LIVE] serverContent.interrupted");
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
