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
import { getVoiceToolDeclarations, getVoiceToolSchemas, executeVoiceToolCalls } from "./tool-bridge.js";
import { MODELS } from "../../llm.js";
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

    // ── Hybrid-mode state ────────────────────────
    // In hybrid mode, Gemini Live is STT-only. Reasoning + tool calls happen
    // via llm.chat() (fast regular Gemini) and output is spoken via Kokoro
    // TranscriptSpeaker. This path is ~1-2s user-to-hears vs ~3-4s for the
    // native-audio Live API path.
    private hybridMode = process.env.ATLAS_VOICE_MODE !== "native";
    private hybridHistory: import("openai/resources/chat/completions.js").ChatCompletionMessageParam[] = [];
    // Bumped whenever the user starts a new turn so an in-flight llm.chat()
    // response from the prior turn can recognize it's been orphaned and drop.
    private hybridTurn = 0;
    // Gemini emits inputTranscription in chunks ("He"→"llo"→" what's the time").
    // Accumulate chunks and wait for 700ms of silence before dispatching the
    // full utterance to the LLM — otherwise we'd fire one turn per chunk.
    private pendingUserText = "";
    private pendingUserTimer: NodeJS.Timeout | null = null;
    private static readonly END_OF_SPEECH_MS = 700;

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

            // 2. Build system prompt. In hybrid mode Gemini Live is STT-only
            // so it doesn't need the full ATLAS identity/memory prompt — a
            // minimal transcription-focused prompt keeps Live's token budget
            // low. The FULL prompt goes to the regular LLM turn instead.
            const systemPrompt = this.hybridMode
                ? "You are a silent transcription service. Do not respond with audio or text. Just transcribe."
                : await buildVoiceSystemPrompt();

            // 3. Voice tool declarations — skipped in hybrid mode (tools go
            // to the regular LLM, not to Live).
            const tools = this.hybridMode ? [] : getVoiceToolDeclarations();
            console.log(`[LIVE-SESSION] mode=${this.hybridMode ? "hybrid" : "native"}, ${tools.length} tools for Live`);

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
        this.hybridHistory = [];
        this.hybridTurn++;
        this.pendingUserText = "";
        if (this.pendingUserTimer) { clearTimeout(this.pendingUserTimer); this.pendingUserTimer = null; }

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

        // Backend → Player (native mode only). In hybrid mode, we IGNORE
        // Gemini Live's audio output entirely — Kokoro handles all TTS.
        if (!this.hybridMode) {
            this.backend.on("audio", (chunk) => {
                this.speaker.suppressForTurn();
                this.player!.write(chunk.pcm);
                this.emitEvent("response_audio", chunk);
            });

            this.backend.on("transcript", (transcript) => {
                this.emitEvent("response_transcript", transcript);
                this.speaker.append(transcript);
            });

            this.backend.on("tool_call", (calls) => {
                this.handleToolCalls(calls);
            });

            this.backend.on("turn_complete", () => {
                this.turnCount++;
                this.emitEvent("turn_complete");
                this.player!.end();
                this.speaker.flush();
                this.speaker.onNewTurn();
                if (this.turnCount % this.config.memoryRefreshInterval === 0) {
                    this.refreshMemory();
                }
            });
        }

        // Backend → Input transcript. In hybrid mode, chunks accumulate and
        // dispatch after END_OF_SPEECH_MS silence. Native mode just reflects
        // to the UI.
        this.backend.on("user_transcript", (text: string) => {
            this.emitEvent("user_transcript", text);
            this.speaker.onNewTurn();
            if (!this.hybridMode) return;

            this.pendingUserText += text;
            if (this.pendingUserTimer) clearTimeout(this.pendingUserTimer);
            this.pendingUserTimer = setTimeout(() => {
                const finalText = this.pendingUserText.trim();
                this.pendingUserText = "";
                this.pendingUserTimer = null;
                if (!finalText) return;
                this.runHybridTurn(finalText).catch((err) => {
                    console.error("[LIVE-SESSION] Hybrid turn errored:", err);
                    this.emitEvent("error", err);
                });
            }, LiveVoiceSession.END_OF_SPEECH_MS);
        });

        // Backend → Tool call cancelled by server (native only).
        this.backend.on("tool_cancelled", (ids: string[]) => {
            const toCancel = ids.length > 0 ? ids : [...this.inflightToolIds];
            for (const id of toCancel) this.inflightToolIds.delete(id);
            this.emitEvent("tool_cancelled", toCancel);
        });

        // Backend → Interrupted (user spoke while model was responding).
        // In hybrid mode this is our barge-in signal: cancel the in-flight
        // llm.chat turn and silence Kokoro.
        this.backend.on("interrupted", () => {
            this.player!.flush();
            this.speaker.cancel();
            if (this.hybridMode) {
                // Invalidate any in-flight hybrid turn — its response drops.
                this.hybridTurn++;
            }
            this.emitEvent("interrupted");
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
                const systemPrompt = this.hybridMode
                    ? "You are a silent transcription service. Do not respond with audio or text. Just transcribe."
                    : await buildVoiceSystemPrompt();
                const tools = this.hybridMode ? [] : getVoiceToolDeclarations();
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

    // ── Hybrid Turn ──────────────────────────────
    //
    // On user_transcript we call llm.chat() (fast regular Gemini) with the
    // voice tool schemas. Tool calls round-trip through executeVoiceToolCalls.
    // Final text is fed to TranscriptSpeaker (Kokoro). Any existing in-flight
    // turn is invalidated via hybridTurn counter so a newer user utterance
    // cleanly cancels the old reasoning + Kokoro speech.

    private async runHybridTurn(userText: string): Promise<void> {
        if (!userText.trim()) return;
        const turnId = ++this.hybridTurn;

        // Cancel any in-flight Kokoro audio from the previous turn.
        this.speaker.cancel();

        // Lazy-init system prompt on first turn. Built once per session.
        if (this.hybridHistory.length === 0) {
            const systemPrompt = await buildVoiceSystemPrompt();
            this.hybridHistory.push({ role: "system", content: systemPrompt });
        }

        this.hybridHistory.push({ role: "user", content: userText });

        const tools = getVoiceToolSchemas();

        // Tool loop: call model → if tool_calls, execute + loop → if text, speak.
        // Cap the loop so a misbehaving model can't infinitely tool-call.
        for (let step = 0; step < 6; step++) {
            if (turnId !== this.hybridTurn) return; // user barged in

            let response;
            try {
                response = await this.llm.chat({
                    messages: this.hybridHistory,
                    tools,
                    modelOverride: MODELS.GEMINI_25_FLASH,
                });
            } catch (err) {
                console.error("[LIVE-SESSION] llm.chat failed:", (err as Error).message);
                return;
            }

            if (turnId !== this.hybridTurn) return; // user barged in during await

            const msg = response.choices?.[0]?.message;
            if (!msg) return;

            const toolCalls = msg.tool_calls ?? [];
            const text = typeof msg.content === "string" ? msg.content : "";

            if (toolCalls.length > 0) {
                // Persist the assistant's tool-request in history so the model
                // sees its own prior turn when it re-reasons after results land.
                this.hybridHistory.push({
                    role: "assistant",
                    content: text || null,
                    tool_calls: toolCalls,
                });

                // Translate OpenAI tool_calls → LiveToolCall shape for executeVoiceToolCalls.
                const liveCalls = toolCalls.map((tc: any) => {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* */ }
                    return { id: tc.id, name: tc.function?.name ?? "", args } satisfies LiveToolCall;
                });

                for (const c of liveCalls) this.inflightToolIds.add(c.id);
                this.emitEvent("tool_call", liveCalls);

                const results = await executeVoiceToolCalls(liveCalls);

                if (turnId !== this.hybridTurn) return;

                for (const r of results) {
                    this.hybridHistory.push({
                        role: "tool",
                        tool_call_id: r.id,
                        content: typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? {}),
                    });
                    const wasCancelled = !this.inflightToolIds.has(r.id);
                    this.inflightToolIds.delete(r.id);
                    if (!wasCancelled) this.emitEvent("tool_result", r);
                }
                continue; // loop back to the model with tool results in history
            }

            // No tool calls — this is the final spoken reply.
            if (text.trim()) {
                this.hybridHistory.push({ role: "assistant", content: text });
                this.emitEvent("response_transcript", text);
                // Feed to Kokoro. speaker.append will split on sentence boundaries
                // and enqueue each sentence for synthesis.
                this.speaker.append(text);
                this.speaker.flush();
            }
            this.turnCount++;
            this.emitEvent("turn_complete");
            return;
        }
        console.warn("[LIVE-SESSION] Hybrid turn exceeded 6 tool-call steps");
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
