// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure merge helper for Personalize step. Validates fields, normalizes wake-word
// phrase default, and keeps unrelated prefs keys intact.
"use strict";

const VALID_VOICE_BACKENDS = ["gemini-live", "openai-realtime"];
const VALID_THEMES = ["light", "dark", "system"];
const VALID_PERSONALITY_PRESETS = [
    "casual_playful",
    "professional_concise",
    "warm_supportive",
    "direct_terse",
    "unhinged",
];
const PERSONALITY_NOTES_MAX = 800;

function mergePersonalize(prefs, update) {
    const next = Object.assign({}, prefs || {});
    const p = Object.assign({}, next.personalize || {});
    const u = update || {};

    if ("hotkey" in u) {
        if (typeof u.hotkey !== "string" || !u.hotkey.trim()) {
            throw new Error("hotkey must be a non-empty string");
        }
        p.hotkey = u.hotkey.trim();
    }
    if ("theme" in u) {
        if (VALID_THEMES.indexOf(u.theme) < 0) {
            throw new Error("theme must be light|dark|system");
        }
        p.theme = u.theme;
    }
    if ("voice" in u && u.voice) {
        if (VALID_VOICE_BACKENDS.indexOf(u.voice.backend) < 0) {
            throw new Error("voice.backend must be one of " + VALID_VOICE_BACKENDS.join("|"));
        }
        p.voice = { backend: u.voice.backend, name: String(u.voice.name || "") };
    }
    if ("wakeWord" in u && u.wakeWord) {
        const phrase = u.wakeWord.phrase && String(u.wakeWord.phrase).trim();
        p.wakeWord = { enabled: !!u.wakeWord.enabled, phrase: phrase || "Hey Bhai" };
    }
    if ("personality" in u && u.personality) {
        const preset = u.personality.preset;
        if (preset && VALID_PERSONALITY_PRESETS.indexOf(preset) < 0) {
            throw new Error("personality.preset must be one of " + VALID_PERSONALITY_PRESETS.join("|"));
        }
        const notes = u.personality.notes != null ? String(u.personality.notes).slice(0, PERSONALITY_NOTES_MAX) : "";
        p.personality = {
            preset: preset || "casual_playful",
            notes: notes,
        };
    }
    next.personalize = p;
    return next;
}

// E3d-3: derive the ATLAS_* env keys that map a personalize block into .env.enc.
// Returns a flat kv object suitable for saveEnvKVs().
function envKVsFromPersonalize(p) {
    const out = {};
    if (!p) return out;
    if (p.hotkey) out.ATLAS_OVERLAY_HOTKEY = String(p.hotkey);
    if (p.voice && p.voice.backend) out.ATLAS_LIVE_VOICE_BACKEND = String(p.voice.backend);
    if (p.voice && p.voice.name) out.ATLAS_LIVE_VOICE_NAME = String(p.voice.name);
    if (p.wakeWord) {
        out.ATLAS_WAKE_WORD_ENABLED = p.wakeWord.enabled ? "true" : "false";
        out.ATLAS_WAKE_WORD_PHRASE = String(p.wakeWord.phrase || "Hey Bhai");
    }
    return out;
}

module.exports = { mergePersonalize, envKVsFromPersonalize, VALID_VOICE_BACKENDS, VALID_THEMES, VALID_PERSONALITY_PRESETS, PERSONALITY_NOTES_MAX };
