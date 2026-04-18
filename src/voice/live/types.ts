// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Mode — Shared Types ───────────────

import type { EventEmitter } from "node:events";

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
    memoryRefreshInterval: 5,
};

// ── Events ───────────────────────────────────────

export type LiveVoiceEventType =
    | "session_started"
    | "listening"
    | "user_speaking"
    | "processing"
    | "response_audio"
    | "response_text"
    | "response_transcript"
    | "tool_call"
    | "tool_result"
    | "interrupted"
    | "turn_complete"
    | "session_ended"
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
    "audio": (chunk: AudioChunk) => void;
    "text": (text: string) => void;
    "transcript": (transcript: string) => void;
    "tool_call": (calls: LiveToolCall[]) => void;
    "interrupted": () => void;
    "turn_complete": () => void;
    "error": (error: Error) => void;
    "connected": () => void;
    "disconnected": () => void;
    "user_speech_started": () => void;
    "user_speech_ended": () => void;
}

// ── Voice-Appropriate Tool Names ─────────────────

export const VOICE_TOOL_NAMES = [
    // Media
    "spotify", "music_control", "set_volume",
    // System
    "shell_exec", "apple_script", "set_brightness",
    // Info
    "web_search", "get_current_time",
    // Memory
    "memory_store", "memory_search",
    // Productivity
    "schedule_task", "set_reminder",
    // Files (quick notes)
    "read", "write",
    // Communication
    "send_file",
] as const;
