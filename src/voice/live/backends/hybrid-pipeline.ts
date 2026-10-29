// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Hybrid Pipeline Backend — stub ──
// Originally intended as a fallback when no direct Gemini/OpenAI API keys
// are available (Whisper STT + OpenRouter LLM + ElevenLabs/Chatterbox TTS).
// The previous implementation had a placeholder `response = transcript`
// that echoed the user's speech back as TTS — a confusing no-op. All
// method bodies now fail fast or no-op; connect() throws with a clear
// error directing users to a working backend.
//
// When a full integration lands, it should wire an LLMClient through the
// constructor and call .chat() in processAccumulatedAudio — the STT+TTS
// plumbing is straightforward; what was missing is a routed LLM call.

import { LiveVoiceBackend } from "./base.js";
import type { LiveSessionConfig, LiveToolResult } from "../types.js";

export class HybridPipelineBackend extends LiveVoiceBackend {
    async connect(_config: LiveSessionConfig): Promise<void> {
        throw new Error(
            "HybridPipelineBackend (Whisper STT + LLM + TTS) is not implemented yet. " +
                "Set LIVE_VOICE_BACKEND=gemini-live or openai-realtime, or configure direct API keys.",
        );
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        this.emit("disconnected");
    }

    sendAudio(_pcm: Buffer): void {
        /* backend never connects — audio is silently dropped */
    }

    interrupt(): void {
        /* nothing to interrupt */
    }

    sendToolResponse(_results: LiveToolResult[]): void {
        /* no persistent session to respond to */
    }

    sendText(_text: string): void {
        /* backend never connects — text is silently dropped */
    }
}
