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
    | "muted"
    | "unmuted"
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
// Full-agent parity: live voice gets the same surfaces as text mode, with
// platform gating for OS-native surfaces. Gemini Live handles ~100 tool
// declarations without issue; keep this list in sync with what the agent
// itself uses so "make a PPT", "send an email", "run a deep research on X"
// all work whether the user types or speaks.

export function getVoiceToolNames(): string[] {
    const names = [
        // Core
        "get_current_time",

        // Memory
        "memory_store", "memory_search", "memory_list", "memory_delete",
        "core_memory_read", "core_memory_append", "core_memory_replace",

        // Media
        "spotify", "music_control", "set_volume", "sonos_control",

        // Browser / web
        "browser_navigate", "browser_click", "browser_type", "browser_scan",
        "browser_extract", "browser_scroll", "browser_back", "browser_analyze",
        "browser_wait", "browser_select", "browser_hover", "browser_keyboard",
        "browser_switch_tab", "browser_close", "browser_multi_action",
        "browser_network_requests", "browser_extract_article",
        "web_search",

        // App launch / focus (cross-platform)
        "open_in_app", "app_manager", "window_manage",

        // OS control (Gemini can see the screen now — these let it act)
        "os_screenshot", "os_click", "os_click_element", "os_type",
        "os_scan", "os_accessibility_tree", "os_multi_action", "os_nav",
        "os_ocr_click", "os_visual_verify", "os_keyboard_shortcuts",
        "clipboard", "system_info", "platform_info",
        "wifi_control", "bluetooth_control", "set_do_not_disturb",
        "dark_mode", "set_brightness", "lock_screen",

        // Shell (fallback for things without a dedicated tool)
        "shell_exec",

        // Files
        "read", "write", "edit", "append_file",
        "grep", "glob", "list_directory", "file_metadata",

        // Productivity / presentations / documents
        "create_presentation", "modify_presentation", "list_presentations", "export_presentation",
        "create_document", "update_document", "append_resume_work", "list_documents",
        "load_document", "delete_document", "export_document", "list_templates",

        // Calendars / reminders / notes / messaging
        "calendar_tool", "reminders_tool", "messages_tool", "apple_notes",
        "google_calendar", "gmail", "email_send",
        "whatsapp_send", "whatsapp_group_info", "contact_lookup",
        "send_message_on_channel", "ask_owner",

        // Scheduling
        "schedule_task", "set_reminder", "list_scheduled_tasks", "cancel_task",
        "task_queue", "cron",

        // Research (delegated — short ack + result comes back via channel)
        "deep_research", "check_deep_research", "cancel_deep_research",

        // Orchestration (delegate complex work to the full agent swarm)
        "swarm_task",
        "start_long_task", "check_long_task", "cancel_long_task", "resume_long_task",

        // Creative
        "generate_image", "gif_search", "stock_image_search", "icon_search",

        // Weather / location
        "weather", "get_location",

        // Communication deliverables
        "send_file", "send_screenshot", "screen_record",

        // Code-action (for "run this command" / "check the repo")
        "code_action", "code_execute",
    ];
    if (process.platform === "darwin") {
        names.push("apple_script", "run_shortcut");
    }
    return names;
}

