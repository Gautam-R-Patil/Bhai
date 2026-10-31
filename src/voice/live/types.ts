// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Mode — Shared Types ───────────────

// ── Backend Types ────────────────────────────────

export type LiveVoiceBackendType = "gemini-live" | "openai-realtime" | "hybrid";

// ── Configuration ────────────────────────────────

export interface LiveVoiceConfig {
    backend: LiveVoiceBackendType | "auto";
    /** API keys fetched from Convex at boot (held in memory only) */
    keys: {
        google?: string;
        openai?: string;
        deepgram?: string;
    };
    /** Audio settings */
    inputSampleRate: number;    // 16000 for Gemini/OpenAI
    outputSampleRate: number;   // 24000 for Gemini, 24000 for OpenAI
    inputChannels: 1;
    /** Voice ID — Gemini: "Aoede"/"Charon"/"Kore"/"Fenrir"/"Puck", OpenAI: "alloy"/"shimmer"/"echo" */
    voiceName?: string;
    /** If true, pure-action commands (play music, open app) produce no speech */
    silentActions: boolean;
    /** Allow user to cut off model mid-response */
    interruptEnabled: boolean;
    /** Safety limit — auto-disconnect after this duration (ms). Default 30 min */
    maxSessionDurationMs: number;
    /** Refresh memory context every N turns */
    memoryRefreshInterval: number;
}

export const DEFAULT_LIVE_CONFIG: Omit<LiveVoiceConfig, "keys"> = {
    backend: "auto",
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    inputChannels: 1,
    silentActions: true,
    interruptEnabled: true,
    maxSessionDurationMs: 30 * 60 * 1000,
    memoryRefreshInterval: 15,
};

// ── Events ───────────────────────────────────────

export type LiveVoiceEventType =
    | "session_started"
    | "listening"
    | "user_speaking"
    | "user_transcript"
    | "processing"
    | "response_audio"
    | "response_text"
    | "response_transcript"
    | "tool_call"
    | "tool_result"
    | "tool_cancelled"
    | "interrupted"
    | "turn_complete"
    | "session_ended"
    | "reconnecting"
    | "reconnected"
    | "muted"
    | "unmuted"
    | "screen_share_started"
    | "screen_share_stopped"
    | "error";

export interface LiveVoiceEvent {
    type: LiveVoiceEventType;
    data?: unknown;
    timestamp: number;
}

// ── Tool Call Types ──────────────────────────────

export interface LiveToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export interface LiveToolResult {
    id: string;
    name: string;
    result: unknown;
}

// ── Gemini Function Declaration Format ───────────

export interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parametersJsonSchema?: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}

// ── Session Config (passed to backend.connect) ───

export interface LiveSessionConfig {
    systemPrompt: string;
    tools: GeminiFunctionDeclaration[];
    voiceName?: string;
    responseModalities: ("AUDIO" | "TEXT")[];
    inputSampleRate: number;
    outputSampleRate: number;
}

// ── Audio Chunk ──────────────────────────────────

export interface AudioChunk {
    /** Raw PCM data (16-bit signed integer, little-endian) */
    pcm: Buffer;
    sampleRate: number;
    channels: 1;
}

// ── Backend Event Emitter Interface ──────────────

export interface LiveBackendEvents {
    audio: (chunk: AudioChunk) => void;
    text: (text: string) => void;
    transcript: (transcript: string) => void;
    user_transcript: (text: string) => void;
    user_transcript_raw: (chunk: string) => void;
    tool_call: (calls: LiveToolCall[]) => void;
    tool_cancelled: (ids: string[]) => void;
    interrupted: () => void;
    turn_complete: () => void;
    error: (error: Error) => void;
    connected: () => void;
    disconnected: () => void;
    user_speech_started: () => void;
    user_speech_ended: () => void;
}

// ── Voice-Appropriate Tool Names ─────────────────
// Tight curated list (~30 tools) optimized for Gemini Live's latency budget.
// Larger lists (~100+) regressed audio response — model would run one tool
// and go silent, possibly because of token budget or internal tool-routing
// overhead on the model side.
//
// Rule: include tools the user commonly invokes BY VOICE directly. Complex
// tools (video editing, presentation authoring, deep research) are reached
// via swarm_task / start_long_task delegation — the model speaks an ack
// ("on it") and the background agent does the heavy work.

export function getVoiceToolNames(): string[] {
    const names = [
        // Core identity & time
        "get_current_time", "weather", "get_location",

        // Memory (session-persistent knowledge)
        "memory_store", "memory_search",
        "core_memory_read", "core_memory_append",

        // Media (highest-used voice intent)
        "spotify", "set_volume",

        // Browser (screen-aware with screen-share active)
        "browser_navigate", "browser_click", "browser_type",
        "web_search",

        // App launch (cross-platform)
        "open_in_app", "app_manager",

        // OS control (Gemini sees the screen → can act on it)
        "os_click_element", "os_type", "os_multi_action",
        "clipboard",
        "wifi_control", "bluetooth_control",
        "dark_mode", "set_brightness",

        // Productivity (most common voice requests)
        "gmail", "calendar_tool", "reminders_tool",
        "whatsapp_send", "contact_lookup",
        "set_reminder", "schedule_task",

        // No generate_image: a create takes 13-19s against the bridge's 8s timeout,
        // and the voice loop has no caller context to deliver it. The agent does images.

        // Delegation — EVERYTHING complex routes through these.
        // The system prompt tells Gemini to speak a short ack and use
        // swarm_task for multi-step work rather than trying to drive it
        // tool-by-tool in a voice loop.
        "swarm_task",
        "start_long_task", "check_long_task",
        "deep_research", "check_deep_research",
    ];
    if (process.platform === "darwin") {
        names.push("apple_script");
    }
    return names;
}

