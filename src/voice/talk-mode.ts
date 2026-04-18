// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Talk Mode ─────────────────────────────────
// Continuous voice conversation: record → transcribe → LLM → TTS → play

import type { LLMClient } from "../llm.js";
import { runAgent } from "../agent.js";
import { classifyQuery } from "../memory/classifier.js";

// ── State ─────────────────────────────────────

let talkModeActive = false;
let onTalkResponse: ((text: string, audioBuffer: Buffer) => Promise<void>) | null = null;

// ── Toggle ────────────────────────────────────

export function isTalkModeActive(): boolean {
    return talkModeActive;
}

export function enableTalkMode(
    _llm: LLMClient,
    responseHandler: (text: string, audioBuffer: Buffer) => Promise<void>
): void {
    talkModeActive = true;
    onTalkResponse = responseHandler;
    console.log("🎙️ Talk mode ENABLED");
}

export function disableTalkMode(): void {
    talkModeActive = false;
    onTalkResponse = null;
    console.log("🎙️ Talk mode DISABLED");
}

// ── Process Talk Input ────────────────────────

export async function processTalkInput(
    llm: LLMClient,
    transcribedText: string,
    generateSpeech: (text: string) => Promise<Buffer>
): Promise<{ text: string; audio: Buffer }> {
    console.log(`🎙️ Talk input: "${transcribedText}"`);

    // Process through agent — fast-path hint for simple greetings
    const voiceHint = classifyQuery(transcribedText) === "llm_only" ? "simple" as const : undefined;
    const response = await runAgent(llm, transcribedText, undefined, undefined, undefined, undefined, voiceHint);

    // Generate audio
    const audio = await generateSpeech(response.text);

    // Notify handler if set
    if (onTalkResponse) {
        await onTalkResponse(response.text, audio);
    }

    return { text: response.text, audio };
}
