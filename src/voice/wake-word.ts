// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Voice Wake Word Detection ─────────────────
// Listens for a trigger phrase using local speech recognition
// Requires external VAD (voice activity detection) library

// ── Types ─────────────────────────────────────

interface WakeWordConfig {
    triggerPhrase: string;
    sensitivity: number;
    onWake: () => void;
}

// ── State ─────────────────────────────────────

let isListening = false;
let config: WakeWordConfig | null = null;

// ── Start Listening ───────────────────────────

export function startWakeWordDetection(cfg: WakeWordConfig): void {
    config = cfg;
    isListening = true;
    console.log(`👂 Wake word detection started. Trigger: "${cfg.triggerPhrase}"`);

    // Note: Full implementation requires a local speech recognition library
    // like Picovoice Porcupine or Vosk. This provides the interface and
    // can be connected to the audio input stream.
    //
    // For now, the wake word can be triggered via the /talk command in Telegram
    // or by sending a voice message containing the trigger phrase.
}

// ── Check Trigger ─────────────────────────────

export function checkWakeWord(transcribedText: string): boolean {
    if (!config || !isListening) return false;

    const text = transcribedText.toLowerCase().trim();
    const trigger = config.triggerPhrase.toLowerCase().trim();

    if (text.includes(trigger)) {
        console.log(`👂 Wake word detected: "${trigger}"`);
        config.onWake();
        return true;
    }

    return false;
}

// ── Stop Listening ────────────────────────────

export function stopWakeWordDetection(): void {
    isListening = false;
    console.log("👂 Wake word detection stopped");
}

// ── Status ────────────────────────────────────

export function isWakeWordActive(): boolean {
    return isListening;
}
