// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Hybrid Pipeline Backend — STT + LLM + TTS (OpenRouter compatible) ──
// Fallback when no direct Gemini/OpenAI API keys are available.
// Uses: Whisper STT (chunked) + OpenRouter LLM + ElevenLabs/Chatterbox TTS

import { LiveVoiceBackend } from "./base.js";
import type { LiveSessionConfig, LiveToolCall, LiveToolResult } from "../types.js";
import { EnergyVAD } from "../audio/vad.js";

// Chunk size for Whisper processing (2 seconds of 16kHz 16-bit mono PCM)
const WHISPER_CHUNK_BYTES = 16000 * 2 * 2; // 2s * 16000Hz * 2 bytes/sample

export class HybridPipelineBackend extends LiveVoiceBackend {
    private vad: EnergyVAD;
    private audioBuffer: Buffer[] = [];
    private systemPrompt = "";
    private processing = false;

    constructor() {
        super();
        this.vad = new EnergyVAD({ threshold: 0.015, silenceFrames: 6, speechFrames: 2 });
    }

    async connect(_config: LiveSessionConfig): Promise<void> {
        // The hybrid backend is not currently wired to an LLM client — see the
        // placeholder in processAccumulatedAudio. Selecting it would silently
        // echo the user's transcript back as TTS, which is confusing UX.
        // Fail loudly instead until a full integration lands.
        throw new Error(
            "HybridPipelineBackend (Whisper STT + LLM + TTS) is not implemented yet. " +
                "Set LIVE_VOICE_BACKEND=gemini-live or openai-realtime, or configure direct API keys.",
        );
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        this.audioBuffer = [];
        this.vad.reset();
        this.emit("disconnected");
    }

    sendAudio(pcm: Buffer): void {
        if (!this._connected) return;

        // Run VAD
        const isSpeech = this.vad.process(pcm);

        // Accumulate during speech
        if (isSpeech) {
            this.audioBuffer.push(pcm);
        }
    }

    interrupt(): void {
        // Cancel any in-progress TTS playback
        this.processing = false;
    }

    sendToolResponse(_results: LiveToolResult[]): void {
        // In hybrid mode, tool results go back through the next LLM call
        // (we don't have a persistent session like Gemini/OpenAI)
    }

    sendText(text: string): void {
        if (!this._connected) return;
        this.processText(text);
    }

    // ── Process accumulated audio after speech ends ──

    private async processAccumulatedAudio(): Promise<void> {
        if (this.processing || this.audioBuffer.length === 0) return;
        this.processing = true;

        // Combine all audio chunks
        const fullAudio = Buffer.concat(this.audioBuffer);
        this.audioBuffer = [];

        try {
            // 1. STT — Transcribe with Whisper
            const { transcribeBuffer } = await import("../../transcribe.js");
            const transcript = await transcribeBuffer(fullAudio, "audio.wav");

            if (!transcript || transcript.trim().length === 0) {
                this.processing = false;
                return;
            }

            console.log(`[HYBRID] User said: "${transcript}"`);

            // 2. LLM — Get response (using agent or direct LLM call)
            // For simplicity, we use a direct approach here.
            // In a full implementation, this would call through the LLM client.
            const response = transcript; // Placeholder — needs LLM integration
            this.emit("text", `[Hybrid mode: "${transcript}" — full LLM integration pending]`);

            // 3. TTS — Generate speech from response
            // Uses ElevenLabs streaming or local Chatterbox
            try {
                const { synthesizeSpeech } = await import("../../../models/local-tts.js");
                const ttsResult = await synthesizeSpeech(response);
                if (ttsResult.audioPath) {
                    // Read the audio file and emit as PCM
                    const fs = await import("node:fs");
                    const audioData = fs.readFileSync(ttsResult.audioPath);
                    this.emit("audio", {
                        pcm: audioData,
                        sampleRate: 24000,
                        channels: 1 as const,
                    });
                }
            } catch {
                // TTS failed — text-only response
            }

            this.emit("turn_complete");
        } catch (err) {
            console.error("[HYBRID] Processing failed:", (err as Error).message);
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
        } finally {
            this.processing = false;
        }
    }

    private async processText(text: string): Promise<void> {
        // Direct text input — skip STT, go straight to LLM + TTS
        this.emit("text", text);
        this.emit("turn_complete");
    }
}
