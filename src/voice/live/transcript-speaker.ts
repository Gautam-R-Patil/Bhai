// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── TranscriptSpeaker — on-device TTS fallback for live voice ──
//
// When Gemini Live produces text output but no inline audio (as the
// 2.5-native-audio model sometimes does for tool-heavy turns), this speaker
// pipes the accumulated transcript through macOS `say` so the user still
// hears a spoken reply. Runs per-sentence so speech starts as soon as the
// first sentence finishes, not at end-of-turn.
//
// It disables itself for the current turn as soon as any inline audio
// arrives from Gemini — we don't want to speak on top of the model's own
// voice. Reset on each new user turn.

import { spawn, type ChildProcess } from "node:child_process";

const SAY_VOICE = process.env.ATLAS_SAY_VOICE || "Samantha";
// Default pace ~200 wpm. Parse-and-validate so a bad env var doesn't break
// the spawn; `say` requires an integer rate.
const SAY_RATE = (() => {
    const raw = Number(process.env.ATLAS_SAY_RATE);
    return Number.isFinite(raw) && raw >= 80 && raw <= 400 ? String(Math.round(raw)) : "200";
})();

// Minimum spoken fragment before we flush. Stops "3.14" from being split
// into "3." "14" and gives breath-sized sentences instead of staccato.
const MIN_SENTENCE_CHARS = 12;

/**
 * Try to extract one sentence from the front of `buf`. Scans every
 * terminator position and accepts the FIRST one that passes sanity
 * checks: next non-space char is an uppercase letter / any non-Latin
 * letter / end of buffer, AND the candidate sentence is ≥ MIN_SENTENCE_CHARS.
 *
 * Rejects: "Mr. Smith", "3.14", "e.g.", "U.S." (next char lowercase).
 * Accepts: "It is four pm. The weather…", "बहुत अच्छा है. अगला…",
 *          "He said \"go.\" She left.", "これ。後で。".
 *
 * Returns null if no sentence is ready — caller should keep buffering.
 */
export function extractSentence(buf: string): { sentence: string; rest: string } | null {
    // CJK terminators always flush (they only appear at true ends).
    const cjk = buf.match(/^([\s\S]*?[。！？]+)([\s\S]*)$/);
    if (cjk && cjk[1].trim().length >= 2) {
        return { sentence: cjk[1].trim(), rest: cjk[2] };
    }

    // Walk every `.!?` in the buffer and find the first one where the
    // following whitespace is followed by a sentence-starter character
    // (uppercase Latin OR any non-Latin letter OR end of buffer).
    const pattern = /[.!?]["')\]]?/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(buf)) !== null) {
        const endIdx = m.index + m[0].length;
        const after = buf.slice(endIdx);
        // End of buffer → only accept on explicit flush(), not here.
        if (after.length === 0) return null;
        // Need at least one whitespace char separating sentences.
        const wsMatch = after.match(/^(\s+)([\s\S]*)$/);
        if (!wsMatch) continue;
        const nextChar = wsMatch[2][0] || "";
        const looksLikeStart =
            /[A-Z]/.test(nextChar) ||
            (/\p{L}/u.test(nextChar) && !/[a-z]/.test(nextChar));
        if (!looksLikeStart) continue;
        const sentence = buf.slice(0, endIdx).trim();
        if (sentence.length < MIN_SENTENCE_CHARS) continue;
        return { sentence, rest: wsMatch[2] };
    }
    return null;
}

export class TranscriptSpeaker {
    private buffer = "";
    private queue: string[] = [];
    private running: ChildProcess | null = null;
    private disabled = false;
    private readonly enabled: boolean;

    constructor() {
        // Only macOS has `say` built-in. On other platforms the fallback is
        // a no-op — the overlay transcript still displays, just no voice.
        this.enabled = process.platform === "darwin";
        if (!this.enabled) {
            console.log("[TRANSCRIPT-SPEAKER] disabled (not macOS)");
        }
    }

    /** Call when Gemini emits a transcript delta. */
    append(delta: string): void {
        if (!this.enabled || this.disabled) return;
        this.buffer += delta;
        // Flush as many complete sentences as we can, greedy from the left.
        // Feels more responsive than waiting for turn-complete.
        while (true) {
            const next = extractSentence(this.buffer);
            if (!next) break;
            this.buffer = next.rest;
            if (next.sentence) this.enqueue(next.sentence);
        }
    }

    /** Call on turn_complete — flushes any trailing fragment. */
    flush(): void {
        if (!this.enabled || this.disabled) return;
        const tail = this.buffer.trim();
        this.buffer = "";
        if (tail) this.enqueue(tail);
    }

    /**
     * Call when Gemini starts producing inline audio for this turn. The
     * speaker stays quiet for the rest of the turn so the two audio
     * streams don't overlap. Reset via onNewTurn().
     */
    suppressForTurn(): void {
        if (!this.enabled || this.disabled) return;
        this.disabled = true;
        this.buffer = "";
        this.queue = [];
        this.cancel();
    }

    /**
     * Call on each new user turn (or at turn_complete).
     *   - Re-enables the speaker so the NEXT model turn can speak.
     *   - Clears the partial buffer (no leftover fragment should leak across turns).
     *   - Keeps the queue + any in-flight `say` process alive so the last
     *     sentence from the prior turn finishes speaking naturally.
     * If the user interrupts (barge-in), call cancel() separately.
     */
    onNewTurn(): void {
        if (!this.enabled) return;
        this.disabled = false;
        this.buffer = "";
    }

    /**
     * Stop immediately — kills any in-flight `say` process AND drops any
     * queued sentences. Use on interruption / session stop where we want
     * instant silence. If you only want to pause between turns, use
     * onNewTurn() instead.
     */
    cancel(): void {
        this.queue = [];
        if (this.running) {
            try { this.running.kill("SIGKILL"); } catch { /* already dead */ }
            this.running = null;
        }
    }

    private enqueue(sentence: string): void {
        this.queue.push(sentence);
        if (!this.running) this.next();
    }

    private next(): void {
        const sentence = this.queue.shift();
        if (!sentence) {
            this.running = null;
            return;
        }
        const child = spawn("say", ["-v", SAY_VOICE, "-r", SAY_RATE, sentence], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        this.running = child;
        child.on("error", () => { this.running = null; this.next(); });
        child.on("close", () => {
            if (this.running === child) this.running = null;
            this.next();
        });
    }
}
