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
import { startScreenShare, stopScreenShare } from "./screen-share.js";
import { TranscriptSpeaker } from "./transcript-speaker.js";

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
    private screenShare: import("./screen-share.js").ScreenShareHandle | null = null;
    private speaker = new TranscriptSpeaker();
    // Rate-limit reconnect attempts: at most 3 in a rolling 30s window,
    // otherwise we'd loop forever against a genuinely broken backend.
    private reconnectTimes: number[] = [];
    private reconnecting = false;
    // Bumped on every reconnect so in-flight tool-execution promises can see
    // they've been orphaned and skip sending stale IDs to a fresh session.
    private backendEpoch = 0;

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

    /** True while the session has ≥1 tool call still executing. */
    get hasToolsInFlight(): boolean {
        return this.inflightToolIds.size > 0;
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

            // 9. Start screen sharing — gives the model eyes so "click that",
            // "make a PPT", "open Bluetooth settings" work against the real UI.
            // Paused while the mic is muted (privacy).
            if (process.env.ATLAS_LIVE_SCREEN_SHARE !== "false") {
                try {
                    this.screenShare = startScreenShare(
                        (b64, mime) => this.backend?.sendVideo(b64, mime),
                        () => this.micMuted || this.state !== "active",
                    );
                } catch (err) {
                    console.warn("[LIVE-SESSION] Screen share failed to start:", (err as Error).message);
                }
            }

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

        // Stop screen share
        if (this.screenShare) {
            stopScreenShare(this.screenShare);
            this.screenShare = null;
        }

        // Kill any in-flight on-device TTS
        this.speaker.cancel();

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
        this.reconnecting = false;
        this.reconnectTimes = [];

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
            // Echo gate: `say` fallback bleeds into the mic and bypasses Gemini's
            // server VAD — drop chunks while speaking (user mutes to interrupt).
            if (this.speaker.isSpeaking()) return;
            this.backend.sendAudio(pcm);
        });

        this.mic.on("error", (err) => {
            console.error("[LIVE-SESSION] Mic error:", err.message);
            this.emitEvent("error", err);
        });

        // Backend → Player (play model's audio response).
        // If inline audio arrives, Gemini IS producing speech — suppress the
        // on-device TTS fallback so the two streams don't overlap.
        this.backend.on("audio", (chunk) => {
            this.speaker.suppressForTurn();
            this.player!.write(chunk.pcm);
            this.emitEvent("response_audio", chunk);
        });

        // Backend → Output transcript (model → speech).
        // Gemini Live is AUDIO-only (see gemini-live.ts Modality config),
        // so the assistant-side text stream flows only via outputTranscription.
        // Also feed deltas to the on-device TTS speaker so the user hears a
        // voice even when the 2.5-native-audio model emits text without audio.
        this.backend.on("transcript", (transcript) => {
            this.emitEvent("response_transcript", transcript);
            this.speaker.append(transcript);
        });

        // Backend → Input transcript (user → speech).
        // NB: do NOT push memory context back via sendRealtimeInput on every
        // transcript. Gemini Live treats realtime-input text as a user utterance,
        // which can race against a pending tool_call and cause Gemini to
        // CANCEL the tool call (the exact pattern we saw in logs: tool result
        // sent at T, server-side cancellation 60ms later). The session-start
        // full memory dump in buildVoiceSystemPrompt already gives the model
        // every memory system it needs.
        this.backend.on("user_transcript", (text: string) => {
            this.emitEvent("user_transcript", text);
            // New user turn → reset the speaker (re-enable + clear buffers).
            this.speaker.onNewTurn();
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
            // Kill any in-flight on-device TTS too — same reason.
            this.speaker.cancel();
            this.emitEvent("interrupted");
        });

        // Backend → Turn complete (model finished responding)
        this.backend.on("turn_complete", () => {
            this.turnCount++;
            this.emitEvent("turn_complete");

            // End the current audio playback gracefully
            this.player!.end();
            // Flush the last trailing fragment through the on-device TTS,
            // then re-enable the speaker for the NEXT turn. Re-enabling here
            // rather than on user_transcript closes the gap where VAD is slow
            // to transcribe and the next model reply would stay muted.
            this.speaker.flush();
            this.speaker.onNewTurn();

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
            if (this.state === "active" && !this.reconnecting) {
                this.attemptReconnect().catch((err) => {
                    console.error("[LIVE-SESSION] Reconnect path errored:", err);
                    this.stop().catch(console.error);
                });
            }
        });
    }

    // ── Auto-Reconnect ───────────────────────────

    private async attemptReconnect(): Promise<void> {
        // Rate limit: drop old timestamps, bail if >=3 attempts in last 30s.
        const now = Date.now();
        this.reconnectTimes = this.reconnectTimes.filter(t => now - t < 30_000);
        if (this.reconnectTimes.length >= 3) {
            console.warn("[LIVE-SESSION] Reconnect budget exhausted (3 tries in 30s) — stopping session");
            if (this.inflightToolIds.size > 0) {
                this.emitEvent("tool_cancelled", [...this.inflightToolIds]);
                this.inflightToolIds.clear();
            }
            await this.stop();
            return;
        }
        this.reconnectTimes.push(now);
        this.reconnecting = true;
        this.backendEpoch++;
        console.warn("[LIVE-SESSION] Backend disconnected — silent reconnect attempt…");
        this.emitEvent("reconnecting");

        try {
            // Detach the dead backend.
            const oldBackend = this.backend;
            this.backend = null;
            if (oldBackend) {
                oldBackend.removeAllListeners();
                await oldBackend.disconnect().catch(() => { /* already dead */ });
            }

            // Cancel any in-flight tool calls — Gemini Live state does NOT
            // persist across sessions, so tool IDs from the dead backend are
            // meaningless to the new one. UI chips flip to `failed` cleanly.
            if (this.inflightToolIds.size > 0) {
                const cancelled = [...this.inflightToolIds];
                this.inflightToolIds.clear();
                this.emitEvent("tool_cancelled", cancelled);
            }

            try {
                // Rebuild + connect a fresh backend using the same config.
                this.backend = this.selectBackend();
                const systemPrompt = await buildVoiceSystemPrompt();
                const tools = getVoiceToolDeclarations();
                const sessionConfig: LiveSessionConfig = {
                    systemPrompt,
                    tools,
                    voiceName: this.config.voiceName,
                    responseModalities: ["AUDIO", "TEXT"],
                    inputSampleRate: this.config.inputSampleRate,
                    outputSampleRate: this.config.outputSampleRate,
                };
                await this.backend.connect(sessionConfig);
            } catch (err) {
                // Connect failed → tear down half-initialized backend, emit a
                // terminal error so the UI leaves "Reconnecting…", then let
                // the caller's .catch route us through stop().
                const half = this.backend;
                this.backend = null;
                if (half) await half.disconnect().catch(() => { /* */ });
                this.emitEvent("error", err instanceof Error ? err : new Error(String(err)));
                throw err;
            }

            // Re-wire backend listeners AND refresh mic listeners (they
            // forwarded to the now-dead backend). Player is unchanged.
            this.mic?.removeAllListeners();
            this.wireEvents();
            this.emitEvent("reconnected");
            console.log("[LIVE-SESSION] ✓ Reconnected");
        } finally {
            this.reconnecting = false;
        }
    }

    // ── Tool Call Handler ─────────────────────────

    private handleToolCalls(calls: LiveToolCall[]): void {
        for (const c of calls) this.inflightToolIds.add(c.id);
        this.emitEvent("tool_call", calls);

        // Snapshot backend identity so we can tell if a reconnect happened
        // between dispatch and .then — Gemini Live tool IDs don't carry
        // across sessions, sending a stale one to a fresh backend is a
        // protocol violation.
        const epoch = this.backendEpoch;

        // Execute tools in parallel — do NOT await (audio keeps playing)
        executeVoiceToolCalls(calls)
            .then((results) => {
                if (epoch !== this.backendEpoch) {
                    console.warn("[LIVE-SESSION] Reconnect happened during tool execution — dropping stale tool response");
                    return;
                }
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
        // Only refresh when there is no tool call mid-flight. Gemini Live
        // treats sendRealtimeInput text as user speech, so injecting context
        // while a tool is pending can cause the server to cancel the tool
        // call (we've seen this in logs).
        if (this.inflightToolIds.size > 0) return;
        try {
            const refresh = getLightMemoryRefresh();
            if (refresh && this.backend?.isConnected()) {
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
