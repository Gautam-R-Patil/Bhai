// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Session — Main Orchestrator ───────

import { EventEmitter } from "node:events";
import { fenceToolResult } from "../../context-scrubber.js";
import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { nativeVadAnyFrame16Khz } from "../../native/index.js";
import { holdCursorWarm } from "../../screen/agent-cursor.js";
import { noteOwnerMessage } from "../../security/consent.js";
import { anySecretTyped } from "../../security/vault.js";
import { getAck, isAckBankReady, startAckBankWarmup } from "./ack-bank.js";
import { AudioPlayer } from "./audio/audio-player.js";
import { MicCapture } from "./audio/mic-capture.js";
import type { LiveVoiceBackend } from "./backends/base.js";
import { GeminiLiveBackend } from "./backends/gemini-live.js";
import { HybridPipelineBackend } from "./backends/hybrid-pipeline.js";
import { OpenAIRealtimeBackend } from "./backends/openai-realtime.js";
import { detectMemoryVerb, getLightMemoryRefresh } from "./memory-bridge.js";
import { buildVoiceSystemPrompt } from "./prompt-builder.js";
import { startScreenShare, stopScreenShare } from "./screen-share.js";
import { executeVoiceToolCalls, getVoiceToolDeclarations, getVoiceToolSchemas } from "./tool-bridge.js";
import { TranscriptSpeaker } from "./transcript-speaker.js";
import type { LiveSessionConfig, LiveToolCall, LiveVoiceConfig, LiveVoiceEvent, LiveVoiceEventType } from "./types.js";
import { DEFAULT_LIVE_CONFIG } from "./types.js";

// ── Session State ────────────────────────────────

type SessionState = "idle" | "connecting" | "active" | "stopping";

// Barge-in threshold: 16-bit signed PCM samples are in [-32768, 32767]; RMS
// of Kokoro echo bleeding through a MacBook's built-in mic typically sits
// around 200-600, room noise at 100-200, intentional speech at 1500+. Pick
// 1200 as a starting floor; env-overrideable for tuning in the field.
const BARGE_IN_RMS_THRESHOLD = Number(process.env.BHAI_BARGE_IN_RMS) || 1200;

// libfvad-backed barge-in gate. Opt-IN: set `BHAI_NATIVE_VAD=true` AND build
// the native module with the `vad` cargo feature (`napi build --features vad`)
// to enable. The RMS threshold above is a crude amplitude gate that
// false-positives on background noise / music; libfvad classifies the actual
// signal spectrum. Aggressiveness 2 is the sensible default — mode 3 (very
// aggressive) cuts even legitimate quiet speech.
//
// When enabled but native is missing the function (build without `vad` feature),
// the gate transparently falls back to RMS. No hard failure.
const NATIVE_VAD_ENABLED = process.env.BHAI_NATIVE_VAD === "true";
const VAD_AGGRESSIVENESS = (() => {
    const n = Number(process.env.BHAI_VAD_MODE);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 3) return 2;
    return n;
})();

// One-shot warnings for the silent-fallback cases — printed once per process
// per reason so a misconfigured BHAI_NATIVE_VAD doesn't waste debugging time.
const _vadWarnedReasons = new Set<string>();
function warnVadFallbackOnce(reason: "missing-feature" | "frame-shape", err?: unknown): void {
    if (_vadWarnedReasons.has(reason)) return;
    _vadWarnedReasons.add(reason);
    if (reason === "missing-feature") {
        console.warn(
            "[LIVE-SESSION] BHAI_NATIVE_VAD=true but native binary lacks `vad` feature — falling back to RMS. " +
                "Rebuild with `cd native && npx napi build --features vad --release`.",
        );
    } else {
        console.warn(
            "[LIVE-SESSION] Native VAD threw on a mic frame; falling back to RMS:",
            err instanceof Error ? err.message : String(err),
        );
    }
}

function computePcmRms(buf: Buffer): number {
    if (buf.length < 2) return 0;
    let sumSq = 0;
    const n = buf.length >>> 1;
    for (let i = 0; i < n; i++) {
        const s = buf.readInt16LE(i << 1);
        sumSq += s * s;
    }
    return Math.sqrt(sumSq / n);
}

/**
 * Normalize text for echo-overlap comparison: lowercase, strip punctuation,
 * collapse whitespace. Keeps Unicode letters (Devanagari, CJK, etc) so the
 * same check works for Hindi / mixed scripts.
 */
export function normalizeForEcho(s: string): string {
    // Keep letters (\p{L}), combining marks (\p{M} — e.g. Devanagari vowel
    // matras, Arabic diacritics), numbers (\p{N}), and whitespace. Strip
    // everything else (punctuation, widget markers). Without \p{M}, Hindi
    // text like "अभी" loses the ी matra and becomes just "अभ".
    return s
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Fraction of tokens from `candidate` that appear in `reference`.
 * Returns 0-1. Higher = more overlap. Used to detect Bhai's own words
 * being re-transcribed as user speech (echo). Token-set overlap (not
 * string-similarity) so "opening WhatsApp now" matches "now opening"
 * regardless of order.
 */
export function tokenOverlap(candidate: string, reference: string): number {
    const cTokens = candidate.split(/\s+/).filter((t) => t.length >= 2);
    if (cTokens.length === 0) return 0;
    const refSet = new Set(reference.split(/\s+/).filter((t) => t.length >= 2));
    if (refSet.size === 0) return 0;
    let hits = 0;
    for (const t of cTokens) if (refSet.has(t)) hits++;
    return hits / cTokens.length;
}

// Echo is declared when ≥60% of candidate tokens appear in recent-spoken.
// Conservative enough that a human echoing "I think it's 26 degrees" after
// Bhai says it doesn't trigger (<60% overlap once their actual words
// arrive), but strict enough to catch "opening WhatsApp now" looping.
const ECHO_OVERLAP_THRESHOLD = Number(process.env.BHAI_ECHO_OVERLAP) || 0.6;

// Connective / function words that commonly appear mid-thought. When the
// user's pending transcript ends in one of these, they almost certainly
// have more to say — extend the end-of-speech window instead of dispatching
// a fragment. Prevents the classic "Can you find" → [fire turn] → "me a
// power bank" → [fire ANOTHER turn] → "under 5K" race seen in production logs.
// Intentionally NARROW. Only words that are STRONG indicators of an unfinished
// thought. Pronouns are excluded because sentences legitimately end with them
// ("tell me about it"), same for "no" / "yes" / "thanks" which aren't here.
// Transitive verbs like "find"/"get" are included because when they end a
// chunk, the object is almost always coming ("find [a power bank]").
const MID_SENTENCE_TAILS: ReadonlySet<string> = new Set([
    // Articles + determiners
    "a",
    "an",
    "the",
    "some",
    "any",
    "my",
    "your",
    "our",
    "their",
    // Prepositions (strong signal of "next phrase coming")
    "of",
    "in",
    "on",
    "at",
    "by",
    "for",
    "to",
    "with",
    "from",
    "into",
    "onto",
    "about",
    "over",
    "under",
    "through",
    "between",
    "against",
    // Conjunctions
    "and",
    "or",
    "but",
    "nor",
    "yet",
    "because",
    "although",
    "while",
    "unless",
    // Auxiliaries / modals (always need a main verb following)
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "am",
    "do",
    "does",
    "did",
    "have",
    "has",
    "had",
    "can",
    "could",
    "should",
    "would",
    "will",
    "may",
    "might",
    "must",
    "shall",
    // Transitive verbs that usually take an object ("find X", "check Y")
    "find",
    "get",
    "make",
    "take",
    "give",
    "send",
    "show",
    "tell",
    "ask",
    "bring",
    "buy",
    "put",
    "call",
    "open",
    "close",
    "check",
    "want",
    "need",
]);

/** Is the pending transcript likely unfinished (ends in a function word)? */
export function looksLikeMidSentence(text: string): boolean {
    const trimmed = text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
        .trim();
    if (!trimmed) return false;
    const words = trimmed.split(/\s+/);
    const lastWord = words[words.length - 1];
    return MID_SENTENCE_TAILS.has(lastWord);
}

// Tool results going into voice-turn history. Large payloads (os_scan
// accessibility tree, web_search results, browser_* page dumps) otherwise
// balloon the next llm.chat input from ~30K to ~400K tokens and make every
// subsequent turn 5-6s slower.
const MAX_TOOL_RESULT_CHARS = Number(process.env.ATLAS_VOICE_TOOL_RESULT_MAX) || 2000;

function truncateToolResult(result: unknown): string {
    const s = typeof result === "string" ? result : JSON.stringify(result ?? {});
    if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
    const head = s.slice(0, Math.floor(MAX_TOOL_RESULT_CHARS * 0.6));
    const tail = s.slice(-Math.floor(MAX_TOOL_RESULT_CHARS * 0.3));
    return `${head}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]…\n${tail}`;
}

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
    private releaseCursorWarm: (() => void) | null = null;
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
    private hybridMode = process.env.BHAI_VOICE_MODE !== "native";
    private hybridHistory: import("openai/resources/chat/completions.js").ChatCompletionMessageParam[] = [];
    // Bumped whenever the user starts a new turn so an in-flight llm.chat()
    // response from the prior turn can recognize it's been orphaned and drop.
    private hybridTurn = 0;
    // Gemini emits inputTranscription in chunks ("He"→"llo"→" what's the time").
    // Accumulate chunks and wait for 700ms of silence before dispatching the
    // full utterance to the LLM — otherwise we'd fire one turn per chunk.
    private pendingUserText = "";
    private pendingUserTimer: NodeJS.Timeout | null = null;
    // Silence window before dispatching accumulated user speech. Natural
    // mid-utterance pauses > this fire a premature turn; tune up for users
    // who speak slowly or tune down for snappier dispatch.
    private static readonly END_OF_SPEECH_MS = Number(process.env.BHAI_END_OF_SPEECH_MS) || 700;
    // Minimum transcript-chunk length (trimmed chars) to trigger barge-in
    // while Kokoro is playing. Under this we assume it's a Gemini hallucination
    // on speaker echo (common: one-letter or two-letter fake words) and drop
    // it. Loud, substantive user speech transcribes as longer chunks and
    // DOES cross this bar. Tuned to 5 so short interjections like "Wait",
    // "Stop", "Hey?" trigger — at 8 we'd lose those single-word barge-ins.
    private static readonly BARGE_IN_MIN_CHARS = Number(process.env.BHAI_BARGE_IN_MIN_CHARS) || 5;
    // Echo-filter: Bhai's most-recent spoken text (normalized). When a
    // user transcript arrives right after we spoke, we compare it against
    // this — if it substantially overlaps, it's the mic picking up the
    // speaker. Dropped. Windowed: cleared when speaker goes idle + a few
    // seconds pass.
    private lastSpokenNormalized = "";
    private lastSpokenAt = 0;
    // How long the echo window stays armed after a reply. Mic leakage is
    // always immediate (<2 s), so a short window is fine and prevents
    // dropping genuine user speech that happens to overlap the reply.
    private static readonly ECHO_WINDOW_MS = Number(process.env.BHAI_ECHO_WINDOW_MS) || 5000;

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
            // so it doesn't need the full Bhai identity/memory prompt — a
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
            // Voice tools click without a model call first: keep the ghost cursor's windows loaded.
            this.releaseCursorWarm = holdCursorWarm();
            this.emitEvent("session_started");
            console.log("[LIVE-SESSION] Live voice session ACTIVE");

            // Warm up the ack bank in the background. Poll until Kokoro is
            // ready (up to 60 s) — the model can take 25-60 s on cold load
            // the first time, so a fixed setTimeout would miss. Once warm,
            // the bank has 6-12 "got it" PCM buffers ready to fire in <50 ms
            // when a tool call starts. A fresh install skips this on the
            // first session since Kokoro is still downloading — acceptable.
            (async () => {
                for (let i = 0; i < 60; i++) {
                    if (this.state !== "active") return;
                    try {
                        startAckBankWarmup();
                    } catch {
                        /* */
                    }
                    if (isAckBankReady()) return;
                    await new Promise((r) => setTimeout(r, 1000));
                }
            })();

            // 9. Start screen sharing — gives the model eyes so "click that",
            // "make a PPT", "open Bluetooth settings" work against the real UI.
            // Paused while the mic is muted (privacy).
            //
            // We emit a screen_share_started event AND log a prominent
            // notice so downstream UIs (overlay, panel, tray) can render a
            // visible "Bhai is watching your screen" indicator. Without
            // this signal users had no way to tell that screencaptures
            // were being uploaded to the live-voice provider every 1.5s.
            if (process.env.BHAI_LIVE_SCREEN_SHARE !== "false") {
                try {
                    this.screenShare = startScreenShare(
                        (b64, mime) => this.backend?.sendVideo(b64, mime),
                        // Paused while a vault secret has been typed this task: these frames go to
                        // the voice provider, and pixels of a filled card/password field can't be
                        // masked (screenshots elsewhere are already withheld then).
                        () => this.micMuted || this.state !== "active" || anySecretTyped(),
                    );
                    console.log(
                        "👁  [LIVE-SESSION] Screen sharing ACTIVE — your screen is being streamed to the live-voice model while the mic is unmuted. Mute the mic to pause.",
                    );
                    this.emitEvent("screen_share_started");
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
        this.releaseCursorWarm?.();
        this.releaseCursorWarm = null;

        // Stop screen share
        if (this.screenShare) {
            stopScreenShare(this.screenShare);
            this.screenShare = null;
            console.log("[LIVE-SESSION] Screen sharing stopped.");
            this.emitEvent("screen_share_stopped");
        }

        // Kill any in-flight on-device TTS
        console.log("[LIVE-SESSION] stop() → cancelling speaker");
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
        if (this.pendingUserTimer) {
            clearTimeout(this.pendingUserTimer);
            this.pendingUserTimer = null;
        }

        // Reset session-scoped caches in downstream tools.
        try {
            const spotify = await import("../../tools/spotify.js");
            spotify.resetSpotifySession?.();
        } catch {
            /* optional */
        }

        this.emitEvent("session_ended");
        console.log(`[LIVE-SESSION] Session ended (${(duration / 1000).toFixed(0)}s, ${turns} turns)`);
    }

    // ── Backend Selection ─────────────────────────

    /**
     * Hybrid-mode barge-in gate. While Kokoro is speaking through the speaker
     * (no AEC on the sox path), the mic picks up our own voice. We must
     * forward the mic ONLY when the user is genuinely speaking, otherwise we
     * feedback-loop the AI's own words back through STT.
     *
     * Two strategies, picked at runtime:
     *   1. libfvad (when BHAI_NATIVE_VAD=true AND the native module was
     *      built with the `vad` cargo feature): spectrum-aware, ignores
     *      background noise / music far better than RMS.
     *   2. RMS threshold (default and fallback): cheap amplitude gate. Loud
     *      bleed-through and any sustained noise above ~1200 RMS passes.
     *
     * `pcm` is 100ms (3200 bytes) of 16kHz mono i16 from mic-capture. For
     * libfvad, that's 5 × 20ms sub-frames; we return true if ANY sub-frame
     * is classified as speech (early-exit on first hit).
     */
    private passesBargeInGate(pcm: Buffer): boolean {
        if (NATIVE_VAD_ENABLED) {
            try {
                const r = nativeVadAnyFrame16Khz(pcm, VAD_AGGRESSIVENESS);
                if (r !== null) return r;
                // native unavailable (module built without `vad` feature) → fall through
                warnVadFallbackOnce("missing-feature");
            } catch (err) {
                // bad frame shape → fall through to RMS, don't crash the mic loop
                warnVadFallbackOnce("frame-shape", err);
            }
        }
        return computePcmRms(pcm) >= BARGE_IN_RMS_THRESHOLD;
    }

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
            // Echo-aware barge-in. In hybrid mode Kokoro plays through sox —
            // macOS doesn't do AEC on that path, so the mic picks up the AI's
            // own voice. Naive gating (native-style) kills barge-in; naive
            // pass-through creates a feedback loop where the AI transcribes
            // itself. Compromise: while speaker is active, forward ONLY if
            // the mic sample is clearly above the echo floor (user's voice
            // louder than Kokoro bleed-through). Rough RMS threshold works
            // well enough at room volume; if barge-in feels flaky we can
            // tune BARGE_IN_RMS_THRESHOLD.
            if (this.speaker.isSpeaking()) {
                if (!this.hybridMode) return; // native: hard gate
                if (!this.passesBargeInGate(pcm)) return;
            }
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

        // Backend → Input transcript (filtered). Native mode relays it to UI
        // for live/partial display; hybrid mode ignores it here and emits a
        // single clean final transcript when the debouncer fires — the
        // per-chunk filter drops single-letter words so fragmented partial
        // display would look broken ("Ho are you" with missing "w").
        this.backend.on("user_transcript", (text: string) => {
            if (!this.hybridMode) {
                this.emitEvent("user_transcript", text);
                // Not a consent answer: native mode sends partial chunks (a fragment "yes" of
                // "yes, but not now"), and its own playback isn't gated, so Bhai's spoken question
                // could come back as the answer. Hybrid mode's one clean final transcript (below)
                // still counts; otherwise confirm in chat.
            }
            this.speaker.onNewTurn();
        });

        // Backend → RAW input transcript chunks (hybrid-mode dispatch path).
        // We must use raw (pre-filter) chunks so short fragments like "w" or "I"
        // survive concat — otherwise "How are you" becomes "Hoareyou".
        this.backend.on("user_transcript_raw", (rawChunk: string) => {
            if (!this.hybridMode) return;
            // Barge-in policy while Kokoro is speaking:
            //   - Short echo-likely chunks (< BARGE_IN_MIN_CHARS) → drop. The
            //     mic RMS gate only forwards loud audio to Gemini, but one-word
            //     transcripts can still slip through from brief louder peaks.
            //   - Substantive chunks OR chunks that extend an already-accepted
            //     barge-in → accept, cancel the speaker, treat as user turn.
            //     This is what makes interrupting Bhai actually work.
            // Barge-in gate fires ONLY while the player subprocess is actively
            // running, not during the post-playback quiet window. quietUntil
            // is for mic-echo decay, not user-input suppression — a user ACK
            // like "okay" / "yes" / "no" arriving right after Bhai finishes
            // is a legitimate reply and must pass through. Previously we
            // used `isSpeaking()` which includes quietUntil and wrongly
            // dropped these short replies.
            if (this.speaker.activelyPlaying()) {
                const shortEchoLikely = rawChunk.trim().length < LiveVoiceSession.BARGE_IN_MIN_CHARS;
                const alreadyBargeIn = this.pendingUserText.length > 0;
                if (shortEchoLikely && !alreadyBargeIn) {
                    console.log(
                        `[HYBRID] dropped short chunk during playback (echo-likely): "${rawChunk.slice(0, 40)}"`,
                    );
                    return;
                }
                // Only cancel speaker on the FIRST chunk of a barge-in. Gemini
                // emits raw chunks every ~100 ms; re-entering cancel() per
                // chunk floods logs with redundant SIGTERM + stack traces.
                if (!alreadyBargeIn) {
                    console.log(
                        `[HYBRID] BARGE-IN during playback — cancelling speaker, accepting: "${rawChunk.slice(0, 40)}"`,
                    );
                    this.speaker.cancel();
                }
            }
            this.pendingUserText += rawChunk;
            // ── Echo-self-loop guard ──
            // Within the ECHO_WINDOW right after Bhai spoke, check whether
            // the accumulated pending text is just the mic picking up our
            // own voice. Observed bug: user says "Yeah", then Bhai replies
            // "opening WhatsApp now", Gemini transcribes both as two user
            // chunks, and we fire a turn asking Bhai "Yeah, opening WhatsApp
            // now." which the LLM responds to as if the user said it.
            if (this.lastSpokenNormalized && Date.now() - this.lastSpokenAt < LiveVoiceSession.ECHO_WINDOW_MS) {
                const pendingNorm = normalizeForEcho(this.pendingUserText);
                if (pendingNorm.length >= 4) {
                    const overlap = tokenOverlap(pendingNorm, this.lastSpokenNormalized);
                    if (overlap >= ECHO_OVERLAP_THRESHOLD) {
                        console.log(
                            `[HYBRID] ECHO detected (overlap=${overlap.toFixed(2)}) — dropping "${this.pendingUserText.slice(0, 60)}"`,
                        );
                        this.pendingUserText = "";
                        if (this.pendingUserTimer) {
                            clearTimeout(this.pendingUserTimer);
                            this.pendingUserTimer = null;
                        }
                        return;
                    }
                }
            }
            console.log(
                `[HYBRID] raw chunk accepted: "${rawChunk.slice(0, 40)}" pendingLen=${this.pendingUserText.length}`,
            );
            if (this.pendingUserTimer) clearTimeout(this.pendingUserTimer);
            // Smart end-of-speech window. If the pending text ends in a
            // function word ("find", "for", "the", ...), the user almost
            // certainly has more to say — extend the wait instead of firing
            // a fragmentary turn that the LLM must respond to mid-thought.
            // Was hit repeatedly in prod: "Can you find" → [dispatch] →
            // "me a power bank" → [dispatch] → "under 5K" → 400 race.
            const wait = looksLikeMidSentence(this.pendingUserText)
                ? LiveVoiceSession.END_OF_SPEECH_MS * 2
                : LiveVoiceSession.END_OF_SPEECH_MS;
            this.pendingUserTimer = setTimeout(() => {
                const finalText = this.pendingUserText.replace(/\s+/g, " ").trim();
                this.pendingUserText = "";
                this.pendingUserTimer = null;
                if (!finalText) return;
                console.log(`[HYBRID] end-of-speech fired (waited ${wait}ms), dispatching: "${finalText}"`);
                // Emit the clean final transcript for UI display.
                this.emitEvent("user_transcript", finalText);
                noteOwnerMessage(finalText); // a spoken yes answers a consent question
                // Memory-verb shortcut: "remember that X" / "note that Y" /
                // "don't forget Z" saves to sqlite BEFORE llm.chat so the
                // model doesn't waste a turn on memory_store and the fact
                // lands immediately. Fire-and-forget — worst case the user
                // repeats it.
                try {
                    const memMatch = detectMemoryVerb(finalText);
                    if (memMatch) {
                        import("../../memory/sqlite.js")
                            .then(async ({ remember }) => {
                                try {
                                    // Importance 5 (not 7): casual "remember milk"
                                    // shouldn't compete with real identity facts
                                    // in core-memory rails (importance>=7 is the
                                    // core-memory promotion threshold).
                                    const id = await remember(memMatch.content, "voice", "voice-capture", 5, "user");
                                    if (id === null) {
                                        console.log("[HYBRID] memory-verb content rejected by value gate");
                                    } else {
                                        console.log(
                                            `[HYBRID] memory-verb saved id=${id} content="${memMatch.content.slice(0, 60)}"`,
                                        );
                                    }
                                } catch (err) {
                                    console.warn("[HYBRID] memory-verb save failed:", (err as Error).message);
                                }
                            })
                            .catch(() => {
                                /* optional */
                            });
                    }
                } catch {
                    /* detector should never throw, belt+braces */
                }
                this.runHybridTurn(finalText).catch((err) => {
                    console.error("[LIVE-SESSION] Hybrid turn errored:", err);
                    this.emitEvent("error", err);
                });
            }, wait);
        });

        // Backend → Tool call cancelled by server (native only).
        this.backend.on("tool_cancelled", (ids: string[]) => {
            const toCancel = ids.length > 0 ? ids : [...this.inflightToolIds];
            for (const id of toCancel) this.inflightToolIds.delete(id);
            this.emitEvent("tool_cancelled", toCancel);
        });

        // Backend → Interrupted (Gemini's server-side VAD thinks user spoke).
        // In HYBRID mode we can't trust this signal: Gemini doesn't get to
        // hear Kokoro (we don't route our audio output through it), so when
        // speaker echo bleeds into the mic it gets transcribed as "user
        // speech" and fires interrupted spuriously — killing Kokoro mid-word.
        // User-perceived behavior: response starts playing, cuts after 2-5
        // words, silence. We ignore it in hybrid mode; real barge-in is
        // handled via the mute button (and will return with mic-side
        // RMS-based detection in a follow-up).
        this.backend.on("interrupted", () => {
            if (this.hybridMode) {
                console.log("[LIVE-SESSION] Gemini interrupted (hybrid — ignoring)");
                this.emitEvent("interrupted");
                return;
            }
            this.player!.flush();
            this.speaker.cancel();
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
        this.reconnectTimes = this.reconnectTimes.filter((t) => now - t < 30_000);
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
                await oldBackend.disconnect().catch(() => {
                    /* already dead */
                });
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
                if (half)
                    await half.disconnect().catch(() => {
                        /* */
                    });
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
                    console.warn(
                        "[LIVE-SESSION] Reconnect happened during tool execution — dropping stale tool response",
                    );
                    return;
                }
                // Send results back to the model so it can generate a voice response
                if (this.backend?.isConnected()) {
                    console.log(`[LIVE-SESSION] Sending ${results.length} tool result(s) back to model`);
                    this.backend.sendToolResponse(
                        results.map((r) =>
                            typeof r.result === "string" ? { ...r, result: fenceToolResult(r.name, r.result) } : r,
                        ),
                    );
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
        console.log(
            `[HYBRID] runHybridTurn START turnId=${turnId} userText="${userText.slice(0, 80)}" speakerBusy=${this.speaker.isSpeaking()}`,
        );

        // Cancel any in-flight Kokoro audio from the previous turn.
        console.log(`[HYBRID] about to cancel prior speaker (turnId=${turnId})`);
        this.speaker.cancel();

        // Lazy-init system prompt on first turn. Built once per session.
        if (this.hybridHistory.length === 0) {
            const basePrompt = await buildVoiceSystemPrompt();
            // Voice-specific guidance: always emit brief acknowledgment text
            // alongside tool calls. OpenAI function-calling allows both
            // `content` and `tool_calls` in one message — use it so the user
            // hears "sure, opening that..." while the tool runs, instead of
            // silence for 1-2s until the tool-result re-call produces text.
            const ackHint =
                '\n\nVOICE MODE RULE: When you call a tool, ALWAYS also emit a short acknowledgment sentence in the same message (e.g. "Sure, opening that now.", "Got it, checking...", "One sec."). Never call a tool silently — the user needs audible feedback that you heard them.';
            this.hybridHistory.push({ role: "system", content: basePrompt + ackHint });
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
                // Speak acknowledgment text BEFORE executing tools so the
                // user hears immediate feedback ("sure, opening that...").
                // Kokoro synth + playback happens in parallel with tool
                // execution — by the time Kokoro finishes the ack, the tool
                // result is usually already back and the next llm.chat fires.
                if (text.trim()) {
                    this.emitEvent("response_transcript", text);
                    this.emitEvent("response_audio", { pcm: Buffer.alloc(0), sampleRate: 24000, channels: 1 as const });
                    this.speaker.speak(text);
                    // Arm echo guard for the ack text too — mic can pick up
                    // "opening that now" just as easily as the final reply.
                    this.lastSpokenNormalized = normalizeForEcho(text);
                    this.lastSpokenAt = Date.now();
                }

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
                    try {
                        args = JSON.parse(tc.function?.arguments || "{}");
                    } catch {
                        /* */
                    }
                    return { id: tc.id, name: tc.function?.name ?? "", args } satisfies LiveToolCall;
                });

                for (const c of liveCalls) this.inflightToolIds.add(c.id);
                this.emitEvent("tool_call", liveCalls);

                // INSTANT ACK: if the model didn't emit any ack text AND the
                // ack bank is ready, play a pre-synthesized "one sec" / topical
                // ack RIGHT NOW so the user hears feedback within ~50 ms of
                // their utterance ending, instead of 500-2000 ms of dead air
                // while the tool + 2nd LLM call runs.
                if (!text.trim() && isAckBankReady() && liveCalls.length > 0) {
                    const ack = getAck(liveCalls[0].name);
                    if (ack) {
                        console.log(`[HYBRID] instant ack (tool=${liveCalls[0].name}) phrase="${ack.phrase}"`);
                        this.speaker.playRawPcm(ack.pcm);
                    }
                }

                const results = await executeVoiceToolCalls(liveCalls);

                if (turnId !== this.hybridTurn) return;

                for (const r of results) {
                    // Truncate big tool results. os_scan / web_search / browser_*
                    // can return 300K+ tokens of raw content which makes every
                    // subsequent llm.chat dwell 5-6s. Voice turns don't need
                    // the full payload — the model used it already. Keep
                    // head+tail so it can still cite specific items.
                    this.hybridHistory.push({
                        role: "tool",
                        tool_call_id: r.id,
                        content: fenceToolResult(r.name, truncateToolResult(r.result)),
                    });
                    const wasCancelled = !this.inflightToolIds.has(r.id);
                    this.inflightToolIds.delete(r.id);
                    if (!wasCancelled) this.emitEvent("tool_result", r);
                }
                // Rolling window: keep system + last 30 non-system messages.
                // Prevents unbounded growth over long sessions.
                this.trimHybridHistory();
                continue; // loop back to the model with tool results in history
            }

            // No tool calls — this is the final spoken reply.
            if (text.trim()) {
                console.log(
                    `[HYBRID] final reply turnId=${turnId} step=${step} textLen=${text.length} text="${text.slice(0, 100)}"`,
                );
                this.hybridHistory.push({ role: "assistant", content: text });
                this.trimHybridHistory();
                this.emitEvent("response_transcript", text);
                // Signal "speaking" state to the UI. We emit an empty response_audio
                // event with a zero-length PCM so existing overlay listeners flip
                // to the speaking orb without needing a new event type.
                this.emitEvent("response_audio", { pcm: Buffer.alloc(0), sampleRate: 24000, channels: 1 as const });
                // speak() synthesizes the whole utterance in ONE Kokoro call —
                // no sentence-splitting, no 1s inter-sentence gaps.
                this.speaker.speak(text);
                // Arm the echo-self-loop guard: record what we just said so
                // incoming transcripts in the next ~5 s can be matched
                // against it and rejected if they overlap substantially.
                this.lastSpokenNormalized = normalizeForEcho(text);
                this.lastSpokenAt = Date.now();
                // Hold turn_complete until Kokoro has actually finished speaking
                // the whole utterance. Otherwise the UI flips to "Listening"
                // mid-sentence and the user thinks it's their turn.
                console.log(`[HYBRID] awaiting speaker idle turnId=${turnId}`);
                await this.waitForSpeakerIdle(turnId);
                console.log(`[HYBRID] speaker idle done turnId=${turnId} currentTurn=${this.hybridTurn}`);
                // If the user barged in while we were waiting, the new turn
                // owns the UI state — don't stomp it with a stale turn_complete.
                if (turnId !== this.hybridTurn) return;
            } else {
                console.log(`[HYBRID] WARN turnId=${turnId} step=${step} — no text AND no tool calls`);
            }
            this.turnCount++;
            this.emitEvent("turn_complete");
            console.log(`[HYBRID] runHybridTurn END turnId=${turnId}`);
            return;
        }
        console.warn("[LIVE-SESSION] Hybrid turn exceeded 6 tool-call steps");
    }

    // Poll until Kokoro's speaker queue drains OR the turn is superseded.
    // Capped at 30s so a stuck synth can't wedge the session forever.
    // Rolling window: keep system message + last MAX_HYBRID_HISTORY non-system
    // messages. Prevents unbounded growth over long sessions from turning
    // every subsequent llm.chat into a multi-second request.
    private trimHybridHistory(): void {
        const MAX_HYBRID_HISTORY = Number(process.env.BHAI_VOICE_HISTORY_MAX) || 30;
        if (this.hybridHistory.length <= MAX_HYBRID_HISTORY + 1) return;
        const system = this.hybridHistory[0]?.role === "system" ? [this.hybridHistory[0]] : [];
        const recent = this.hybridHistory.slice(-MAX_HYBRID_HISTORY);
        this.hybridHistory = [...system, ...recent];
    }

    private waitForSpeakerIdle(turnId: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const started = Date.now();
            const poll = () => {
                if (turnId !== this.hybridTurn) return resolve();
                if (!this.speaker.isSpeaking()) return resolve();
                if (Date.now() - started > 30_000) return resolve();
                setTimeout(poll, 200);
            };
            poll();
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
