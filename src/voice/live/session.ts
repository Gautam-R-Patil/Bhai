// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Session — Main Orchestrator ───────

import { EventEmitter } from "node:events";
import type { LLMClient } from "../../llm.js";
import type {
    LiveVoiceConfig,
    LiveVoiceEvent,
    LiveVoiceEventType,
    LiveToolCall,
    LiveSessionConfig,
} from "./types.js";
import { DEFAULT_LIVE_CONFIG } from "./types.js";
import { LiveVoiceBackend } from "./backends/base.js";
import { GeminiLiveBackend } from "./backends/gemini-live.js";
import { OpenAIRealtimeBackend } from "./backends/openai-realtime.js";
import { HybridPipelineBackend } from "./backends/hybrid-pipeline.js";
import { MicCapture } from "./audio/mic-capture.js";
import { AudioPlayer } from "./audio/audio-player.js";
import { getVoiceToolDeclarations, executeVoiceToolCalls } from "./tool-bridge.js";
import { buildVoiceSystemPrompt } from "./prompt-builder.js";
import { getLightMemoryRefresh } from "./memory-bridge.js";

// ── Session State ────────────────────────────────

type SessionState = "idle" | "connecting" | "active" | "stopping";

// ── Live Voice Session Class ─────────────────────

export class LiveVoiceSession extends EventEmitter {
    private config: LiveVoiceConfig;
    private llm: LLMClient;
    private backend: LiveVoiceBackend | null = null;
    private mic: MicCapture | null = null;
    private player: AudioPlayer | null = null;
    private state: SessionState = "idle";
    private turnCount = 0;
    private sessionTimer: NodeJS.Timeout | null = null;
    private startTime = 0;
    private micMuted = false;
    private inflightToolIds = new Set<string>();

    constructor(config: Partial<LiveVoiceConfig> & Pick<LiveVoiceConfig, "keys">, llm: LLMClient) {
        super();
        this.config = { ...DEFAULT_LIVE_CONFIG, ...config } as LiveVoiceConfig;
        this.llm = llm;
    }

    get isActive(): boolean {
        return this.state === "active";
    }

    get currentState(): SessionState {
        return this.state;
    }

    get duration(): number {
        return this.startTime > 0 ? Date.now() - this.startTime : 0;
    }

    // ── Start Session ────────────────────────────

    async start(): Promise<void> {
        if (this.state !== "idle") {
            throw new Error(`Cannot start: session is ${this.state}`);
        }

        this.state = "connecting";
        console.log("[LIVE-SESSION] Starting live voice session...");

        try {
            // 1. Select backend
            this.backend = this.selectBackend();

            // 2. Build system prompt (personality + memory)
            const systemPrompt = await buildVoiceSystemPrompt();

            // 3. Get voice tool declarations
            const tools = getVoiceToolDeclarations();
            console.log(`[LIVE-SESSION] ${tools.length} voice tools loaded`);

            // 4. Connect backend
            const sessionConfig: LiveSessionConfig = {
                systemPrompt,
                tools,
                voiceName: this.config.voiceName,
                responseModalities: ["AUDIO", "TEXT"],
                inputSampleRate: this.config.inputSampleRate,
                outputSampleRate: this.config.outputSampleRate,
            };

            console.log(`[LIVE-SESSION] System prompt: ${systemPrompt.length} chars, Tools: ${tools.length}`);
            await this.backend.connect(sessionConfig);

            // 5. Set up audio I/O
            this.mic = new MicCapture(this.config.inputSampleRate);
            this.player = new AudioPlayer(this.config.outputSampleRate);

            // 6. Wire everything together
            this.wireEvents();

            // 7. Start mic capture
            this.mic.start();

            // 8. Set session timeout
            this.sessionTimer = setTimeout(() => {
                console.log("[LIVE-SESSION] Session timeout reached, stopping");
                this.stop().catch(console.error);
            }, this.config.maxSessionDurationMs);

            this.state = "active";
            this.startTime = Date.now();
            this.emitEvent("session_started");
            console.log("[LIVE-SESSION] Live voice session ACTIVE");

        } catch (err) {
            this.state = "idle";
            const message = err instanceof Error ? err.message : String(err);
            console.error("[LIVE-SESSION] Failed to start:", message);
            this.emitEvent("error", err);
            throw err;
        }
    }

    // ── Stop Session ─────────────────────────────

    async stop(): Promise<void> {
        if (this.state === "idle" || this.state === "stopping") return;

        this.state = "stopping";
        console.log("[LIVE-SESSION] Stopping live voice session...");

        // Clear timeout
        if (this.sessionTimer) {
            clearTimeout(this.sessionTimer);
            this.sessionTimer = null;
        }

        // Stop mic
        if (this.mic) {
            this.mic.stop();
            this.mic.removeAllListeners();
            this.mic = null;
        }

        // Stop player
        if (this.player) {
            this.player.stop();
            this.player.removeAllListeners();
            this.player = null;
        }

        // Disconnect backend
        if (this.backend) {
            await this.backend.disconnect();
            this.backend.removeAllListeners();
            this.backend = null;
        }

        const duration = this.duration;
        const turns = this.turnCount;
        this.state = "idle";
        this.startTime = 0;
        this.turnCount = 0;
        this.micMuted = false;
        this.inflightToolIds.clear();

        // Reset session-scoped caches in downstream tools.
        try {
            const spotify = await import("../../tools/spotify.js");
            spotify.resetSpotifySession?.();
        } catch { /* optional */ }

        this.emitEvent("session_ended");
        console.log(`[LIVE-SESSION] Session ended (${(duration / 1000).toFixed(0)}s, ${turns} turns)`);
    }

    // ── Backend Selection ─────────────────────────

    private selectBackend(): LiveVoiceBackend {
        const { backend, keys } = this.config;

        if (backend === "gemini-live" || (backend === "auto" && keys.google)) {
            if (!keys.google) throw new Error("Gemini Live requires GOOGLE_API_KEY");
            console.log("[LIVE-SESSION] Using Gemini Live backend");
            return new GeminiLiveBackend(keys.google);
        }

        if (backend === "openai-realtime" || (backend === "auto" && keys.openai)) {
            if (!keys.openai) throw new Error("OpenAI Realtime requires OPENAI_API_KEY");
            console.log("[LIVE-SESSION] Using OpenAI Realtime backend");
            return new OpenAIRealtimeBackend(keys.openai);
        }

        if (backend === "hybrid" || backend === "auto") {
            console.log("[LIVE-SESSION] Using Hybrid pipeline backend (STT + LLM + TTS)");
            return new HybridPipelineBackend();
        }

        throw new Error(`Unknown backend: ${backend}`);
    }

    // ── Wire Events ──────────────────────────────

    private wireEvents(): void {
        if (!this.backend || !this.mic || !this.player) return;

        // Mic → Backend (send audio chunks to the model; respect mute)
        this.mic.on("data", (pcm) => {
            if (this.micMuted) return;
            // Guard against a buffered mic event landing after stop() nulled the backend.
            if (!this.backend) return;
            this.backend.sendAudio(pcm);
        });

        this.mic.on("error", (err) => {
            console.error("[LIVE-SESSION] Mic error:", err.message);
            this.emitEvent("error", err);
        });

        // Backend → Player (play model's audio response)
        this.backend.on("audio", (chunk) => {
            this.player!.write(chunk.pcm);
            this.emitEvent("response_audio", chunk);
        });

        // Backend → Output transcript (model → speech).
        // Gemini Live is AUDIO-only (see gemini-live.ts Modality config),
        // so the assistant-side text stream flows only via outputTranscription.
        // We deliberately do NOT wire `backend.on("text")` → response_text:
        // re-enabling text modality later would otherwise double-emit.
        this.backend.on("transcript", (transcript) => {
            this.emitEvent("response_transcript", transcript);
        });

        // Backend → Input transcript (user → speech)
        this.backend.on("user_transcript", (text: string) => {
            this.emitEvent("user_transcript", text);
        });

        // Backend → Tool call cancelled by server (user interrupted mid-call).
        // Gemini Live's toolCallCancellation.ids is optional per SDK docs — when
        // absent, cancel ALL in-flight tools so UI chips don't stick in pending.
        this.backend.on("tool_cancelled", (ids: string[]) => {
            const toCancel = ids.length > 0 ? ids : [...this.inflightToolIds];
            for (const id of toCancel) this.inflightToolIds.delete(id);
            this.emitEvent("tool_cancelled", toCancel);
        });

        // Backend → Tool calls (execute in parallel, don't block audio)
        this.backend.on("tool_call", (calls) => {
            this.handleToolCalls(calls);
        });

        // Backend → Interrupted (user spoke while model was responding)
        this.backend.on("interrupted", () => {
            // Immediately flush the audio player for instant silence
            this.player!.flush();
            this.emitEvent("interrupted");
        });

        // Backend → Turn complete (model finished responding)
        this.backend.on("turn_complete", () => {
            this.turnCount++;
            this.emitEvent("turn_complete");

            // End the current audio playback gracefully
            this.player!.end();

            // Periodic memory refresh
            if (this.turnCount % this.config.memoryRefreshInterval === 0) {
                this.refreshMemory();
            }
        });

        // Backend → User speech detected
        this.backend.on("user_speech_started", () => {
            this.emitEvent("user_speaking");
        });

        this.backend.on("user_speech_ended", () => {
            this.emitEvent("processing");
        });

        // Backend errors
        this.backend.on("error", (err) => {
            console.error("[LIVE-SESSION] Backend error:", err.message);
            this.emitEvent("error", err);
        });

        this.backend.on("disconnected", () => {
            if (this.state === "active") {
                console.warn("[LIVE-SESSION] Backend disconnected unexpectedly, stopping session");
                this.stop().catch(console.error);
            }
        });
    }

    // ── Tool Call Handler ─────────────────────────

    private handleToolCalls(calls: LiveToolCall[]): void {
        for (const c of calls) this.inflightToolIds.add(c.id);
        this.emitEvent("tool_call", calls);

        // Execute tools in parallel — do NOT await (audio keeps playing)
        executeVoiceToolCalls(calls)
            .then((results) => {
                // Send results back to the model so it can generate a voice response
                if (this.backend?.isConnected()) {
                    console.log(`[LIVE-SESSION] Sending ${results.length} tool result(s) back to model`);
                    this.backend.sendToolResponse(results);
                } else {
                    console.warn("[LIVE-SESSION] Backend disconnected — cannot send tool results");
                }
                for (const r of results) {
                    // If the id was already removed by a tool_cancelled event,
                    // skip the tool_result emit — otherwise the UI chip would
                    // flip from `failed` (set on cancel) back to `done`.
                    const wasCancelled = !this.inflightToolIds.has(r.id);
                    this.inflightToolIds.delete(r.id);
                    if (!wasCancelled) this.emitEvent("tool_result", r);
                }
            })
            .catch((err) => {
                console.error("[LIVE-SESSION] Tool execution failed:", err);
            });
    }

    // ── Memory Refresh ───────────────────────────

    private refreshMemory(): void {
        try {
            const refresh = getLightMemoryRefresh();
            if (refresh && this.backend?.isConnected()) {
                // Send updated context as a system-level message
                this.backend.sendText(`[Memory context update]\n${refresh}`);
                console.log(`[LIVE-SESSION] Memory refreshed at turn ${this.turnCount}`);
            }
        } catch (err) {
            console.warn("[LIVE-SESSION] Memory refresh failed:", (err as Error).message);
        }
    }

    // ── Event Helpers ────────────────────────────

    private emitEvent(type: LiveVoiceEventType, data?: unknown): void {
        const event: LiveVoiceEvent = {
            type,
            data,
            timestamp: Date.now(),
        };
        this.emit("event", event);
        this.emit(type, data);
    }

    // ── Send text input (for overlay/telegram text during live session) ──

    sendTextInput(text: string): void {
        if (!this.backend?.isConnected()) return;
        this.backend.sendText(text);
    }

    // ── Mic mute control (client-side pause — model keeps speaking) ──

    mute(): void {
        if (this.micMuted) return;
        this.micMuted = true;
        this.emitEvent("muted");
    }

    unmute(): void {
        if (!this.micMuted) return;
        this.micMuted = false;
        this.emitEvent("unmuted");
    }

    get isMuted(): boolean {
        return this.micMuted;
    }
}
