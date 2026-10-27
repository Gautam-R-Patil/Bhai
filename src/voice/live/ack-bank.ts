// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Ack Bank — pre-synthesized acknowledgments for instant feedback ──
//
// Tool calls can take 100-2000 ms (spotify, web_search, dark_mode, gmail).
// Without an immediate audible response, the user hears dead air and thinks
// Bhai has hung. This module pre-synthesizes a handful of short "got it"
// acks on boot using Kokoro, then plays one instantly when a tool fires.
//
// Design:
//   - On boot (after Kokoro is ready), synth 6 short phrases to RAM buffers.
//   - When a tool call starts, pick the best ack (random from topic-matched
//     pool, or generic "one sec") and hand its PCM to TranscriptSpeaker to
//     play. The speak() path still works; we just inject PCM directly
//     instead of going through another synth round-trip.
//   - Ack playback is fire-and-forget — the real LLM reply will follow
//     after the tool returns, and the speaker's queue serialization handles
//     ordering.
//
// Why pre-synth instead of a cached tiny Kokoro call? Because even a tiny
// call costs ~150-200 ms of synth + 50 ms of afplay spawn. Pre-synth lets
// the ack drop in immediately after user's utterance ends.

import { synthesize as kokoroSynthesize, isKokoroReady, hasKokoroFailed } from "./kokoro-tts.js";

// Generic acks (played if no topical match). Intentionally varied so the
// user doesn't hear the same phrase repeatedly.
const GENERIC_ACKS = [
    "One sec.",
    "Got it.",
    "Sure.",
    "On it.",
    "Okay.",
    "Mhmm.",
];

// Topical acks keyed by tool-name prefix. Add as needed — if a tool-name
// doesn't match any prefix here, generic acks are used.
const TOPICAL_ACKS: Record<string, string[]> = {
    spotify: ["Playing that now.", "Pulling it up."],
    weather: ["Checking the weather.", "One sec."],
    web_search: ["Let me look that up.", "Searching now."],
    browser: ["Opening that.", "On it."],
    gmail: ["Checking your inbox.", "One sec."],
    calendar: ["Pulling up your calendar.", "Let me check."],
    dark_mode: ["Switching that.", "On it."],
    set_volume: ["Adjusting that.", "Got it."],
    memory: ["Got it, remembering that.", "Saved."],
    open_in_app: ["Opening that.", "On it."],
    app_manager: ["Opening.", "One sec."],
    os_click: ["Clicking now.", "Got it."],
};

const bank: Record<string, Buffer> = {};
let synthesized = false;
let synthPromise: Promise<void> | null = null;

/**
 * Fire-and-forget synth of every ack phrase into RAM. Call after
 * initKokoro() resolves. Total cost ≈ 6 × 150 ms = ~1 s one-time, runs in
 * the background while the user connects the mic.
 */
export function startAckBankWarmup(): void {
    if (synthesized || synthPromise) return;
    if (hasKokoroFailed() || !isKokoroReady()) {
        // Kokoro not ready yet — try again later via getAck()'s lazy path.
        return;
    }
    synthPromise = (async () => {
        const all = new Set<string>([...GENERIC_ACKS, ...Object.values(TOPICAL_ACKS).flat()]);
        let done = 0;
        for (const phrase of all) {
            try {
                const pcm = await kokoroSynthesize(phrase);
                bank[phrase] = pcm;
                done++;
            } catch (err) {
                console.warn(`[ACK-BANK] synth failed for "${phrase}": ${(err as Error).message}`);
            }
        }
        synthesized = true;
        console.log(`[ACK-BANK] warmup done (${done}/${all.size} acks ready)`);
    })();
}

/**
 * Return a pre-synthesized PCM buffer and the phrase that produced it, or
 * null if the bank isn't ready yet. Picks a topical ack when the tool name
 * matches, otherwise falls back to a random generic ack. Deterministic
 * pick-by-hash would reduce variety; random keeps it fresh.
 */
export function getAck(toolName: string): { pcm: Buffer; phrase: string } | null {
    if (!synthesized) return null;
    // Topical match by prefix
    for (const [prefix, phrases] of Object.entries(TOPICAL_ACKS)) {
        if (toolName.startsWith(prefix)) {
            const pick = phrases[Math.floor(Math.random() * phrases.length)];
            const pcm = bank[pick];
            if (pcm) return { pcm, phrase: pick };
        }
    }
    // Generic fallback
    const pick = GENERIC_ACKS[Math.floor(Math.random() * GENERIC_ACKS.length)];
    const pcm = bank[pick];
    if (!pcm) return null;
    return { pcm, phrase: pick };
}

/** Returns true when every ack is pre-synthed and ready in RAM. */
export function isAckBankReady(): boolean {
    return synthesized;
}
