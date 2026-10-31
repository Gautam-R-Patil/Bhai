// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── TranscriptSpeaker — on-device TTS fallback for live voice ──
//
// When Gemini Live produces text output but no inline audio (as the
// 2.5-native-audio model sometimes does for tool-heavy turns), this speaker
// pipes the accumulated transcript through an on-device TTS so the user
// still hears a spoken reply. Runs per-sentence so speech starts as soon as
// the first sentence finishes, not at end-of-turn.
//
// TTS chain, tried in order per sentence:
//   1. Kokoro 82M ONNX → WAV file → platform-native player (natural voice).
//   2. Platform-native TTS (say / PowerShell SpeechSynthesizer / espeak) —
//      robotic but instant; used before Kokoro's cold load finishes.
//
// Playback path: Kokoro's raw PCM is wrapped in a 44-byte WAV header, written
// to an os.tmpdir() file, and played via the platform's canonical WAV player:
//   - macOS:   afplay (always at /usr/bin/afplay)
//   - Windows: PowerShell + System.Media.SoundPlayer.PlaySync (no bundling)
//   - Linux:   paplay → aplay → ffplay fallback chain (probed at module load)
//
// We used to pipe raw PCM into sox `play` via stdin, but multi-second
// utterances at 24 kHz × 2 B overflow the OS's 64 KB pipe buffer; sox would
// read one buffer-full, see EOF (because `.end()` raced drain), and exit —
// truncating output to ~1 second. File-based playback sidesteps the pipe
// entirely and is the pattern node-wav-player, kokoro-js, and every
// production Node-TTS wrapper uses.
//
// It disables itself for the current turn as soon as any inline audio
// arrives from Gemini — we don't want to speak on top of the model's own
// voice. Reset on each new user turn.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initKokoro, synthesize as kokoroSynthesize, hasKokoroFailed, isKokoroReady } from "./kokoro-tts.js";
import { stripTtsMarkup } from "../tts.js";

// ── Cross-platform subprocess lookup ─────────────────────
// Check once at module load which binaries are present. Linux ships a mix of
// paplay / aplay / ffplay depending on distro + sound server (PipeWire vs Pulse
// vs plain ALSA); we detect rather than assume.
function hasCommand(bin: string): boolean {
    const probe = process.platform === "win32"
        ? spawnSync("where", [bin], { stdio: "ignore" })
        : spawnSync("command", ["-v", bin], { stdio: "ignore", shell: true });
    return probe.status === 0;
}

// ── Kokoro PCM format (matches kokoro-tts.ts output) ──
const KOKORO_SAMPLE_RATE = 24000;
const KOKORO_CHANNELS = 1;
const KOKORO_BIT_DEPTH = 16;

/**
 * Build a 44-byte RIFF/WAVE header for a 16-bit LE PCM payload.
 * We wrap Kokoro's raw PCM in a WAV container and spawn the platform's native
 * WAV player rather than piping PCM into sox via stdin. Why: Node's
 * child_process stdin goes through the OS pipe buffer (~64 KB). A multi-second
 * utterance at 24 kHz × 2 bytes fills one pipe-buffer in ~0.7 s, and calling
 * `.end()` immediately after `.write(bigBuf)` races against drain — the player
 * sees EOF after reading the first buffer-full and exits, truncating the tail.
 * Writing to a temp file bypasses the pipe entirely.
 */
function buildWavHeader(
    pcmByteLength: number,
    sampleRate = KOKORO_SAMPLE_RATE,
    channels = KOKORO_CHANNELS,
    bitDepth = KOKORO_BIT_DEPTH,
): Buffer {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcmByteLength, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);                                 // fmt chunk size
    h.writeUInt16LE(1, 20);                                  // PCM
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28); // byte rate
    h.writeUInt16LE(channels * (bitDepth / 8), 32);          // block align
    h.writeUInt16LE(bitDepth, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcmByteLength, 40);
    return h;
}

const SAY_VOICE = process.env.BHAI_SAY_VOICE || "Samantha";
// Default pace ~200 wpm (macOS `say` rate; espeak and SpeechSynthesizer
// interpret the number differently but this is a reasonable middle).
// Parse-and-validate so a bad env var doesn't break the spawn.
const SAY_RATE = (() => {
    const raw = Number(process.env.BHAI_SAY_RATE);
    return Number.isFinite(raw) && raw >= 80 && raw <= 400 ? String(Math.round(raw)) : "200";
})();

// ── Platform-specific WAV playback command ───────────────
// Resolve at module load so we know up-front whether TTS can play on this box.
// Returns null if nothing usable is installed (Linux with no audio tools).
interface PlaybackCommand {
    cmd: string;
    buildArgs: (wavPath: string) => string[];
    // Node spawn options — Windows needs windowsHide to suppress the PowerShell
    // flash window; other platforms fine with defaults.
    spawnOpts?: { windowsHide?: boolean };
}

function pickPlaybackCommand(): PlaybackCommand | null {
    if (process.platform === "darwin") {
        // afplay ships at /usr/bin/afplay on every macOS. Hardcode the
        // absolute path — Electron launched from Finder gets a minimal PATH
        // that we don't want to depend on.
        return { cmd: "/usr/bin/afplay", buildArgs: (p) => [p] };
    }
    if (process.platform === "win32") {
        // PowerShell + System.Media.SoundPlayer is the canonical pattern
        // (node-wav-player source). PlaySync blocks until EOF, so `close`
        // fires when audio finishes. -WindowStyle Hidden + windowsHide
        // prevents a console flash on spawn from Electron.
        return {
            cmd: "powershell.exe",
            buildArgs: (p) => [
                "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                "-Command",
                // Double single-quotes escape the path inside the PS literal.
                `(New-Object System.Media.SoundPlayer '${p.replace(/'/g, "''")}').PlaySync()`,
            ],
            spawnOpts: { windowsHide: true },
        };
    }
    // Linux: try PulseAudio first (ubiquitous on desktop; works on PipeWire
    // via pipewire-pulse), fall back to plain ALSA, last resort ffplay.
    if (hasCommand("paplay")) return { cmd: "paplay", buildArgs: (p) => [p] };
    if (hasCommand("aplay"))  return { cmd: "aplay", buildArgs: (p) => ["-q", p] };
    if (hasCommand("ffplay")) {
        return { cmd: "ffplay", buildArgs: (p) => ["-nodisp", "-autoexit", "-loglevel", "quiet", p] };
    }
    return null;
}

// ── Platform-specific fallback TTS (used before Kokoro loads or if it fails) ──
// macOS: /usr/bin/say (always present). Windows: PowerShell SpeechSynthesizer
// (always present via .NET). Linux: `espeak` if installed, otherwise we just
// drop the utterance (the user will get Kokoro audio once the model is ready).
interface FallbackTts {
    cmd: string;
    buildArgs: (text: string) => string[];
    spawnOpts?: { windowsHide?: boolean };
}

function pickFallbackTts(): FallbackTts | null {
    if (process.platform === "darwin") {
        // Absolute path for the same Electron-PATH reason as afplay above.
        return { cmd: "/usr/bin/say", buildArgs: (t) => ["-v", SAY_VOICE, "-r", SAY_RATE, t] };
    }
    if (process.platform === "win32") {
        // System.Speech.Synthesis.SpeechSynthesizer ships with every Windows.
        // Single-quote escape the user text to prevent PS injection.
        return {
            cmd: "powershell.exe",
            buildArgs: (t) => [
                "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                "-Command",
                `Add-Type -AssemblyName System.Speech; ` +
                `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
                `$s.Speak('${t.replace(/'/g, "''")}')`,
            ],
            spawnOpts: { windowsHide: true },
        };
    }
    if (hasCommand("espeak")) {
        return { cmd: "espeak", buildArgs: (t) => ["-s", SAY_RATE, t] };
    }
    return null;
}

// Resolved at module load. Used in the constructor + playback paths.
const PLAYBACK_COMMAND = pickPlaybackCommand();
const FALLBACK_TTS = pickFallbackTts();

// Minimum spoken fragment before we flush. Stops "3.14" from being split
// into "3." "14" and gives breath-sized sentences instead of staccato.
const MIN_SENTENCE_CHARS = 12;

// Grace period after the player subprocess exits before we re-open the mic
// gate. close fires when the process ends, but the tail of the last sentence
// still lives in the OS audio buffer + room acoustics for ~100-300 ms — long
// enough to leak back through the mic and re-ignite the feedback loop.
const POST_SPEAK_QUIET_MS = 250;

// Common English abbreviations that end in `.` and are followed by a capital
// word — "I spoke to Dr. Smith about…" must NOT split at "Dr.". Checked against
// the end of a candidate sentence; case-insensitive.
//
// Selection rule: only abbreviations that (a) genuinely occur mid-sentence
// followed by a capital name, and (b) are NOT also common whole English words.
// Rejected candidates like "ed", "co", "pp", "gen", "col", "rep", "sen",
// "gov", "hon", "pres" would over-preserve — they're frequent sentence-ending
// words ("…in general.", "…company rep.") and the \b boundary doesn't save
// us because those words ARE the ending token.
const ABBR_AT_END =
    /\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Prof|Rev|Sgt|Capt|Lt|Fr|e\.g|i\.e|vs|etc|Inc|Ltd|Corp|U\.S|U\.K|U\.N|p\.m|a\.m|No|Vol|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.["')\]]?$/i;

/**
 * Try to extract one sentence from the front of `buf`. Scans every
 * terminator position and accepts the FIRST one that passes sanity
 * checks: next non-space char is an uppercase letter / any non-Latin
 * letter / end of buffer, AND the candidate sentence is ≥ MIN_SENTENCE_CHARS,
 * AND the candidate doesn't end in a known abbreviation.
 *
 * Rejects: "Mr. Smith", "3.14", "e.g.", "U.S." (next char lowercase),
 *          "I spoke to Dr. Smith" (abbreviation guard).
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
        // Abbreviation guard — "I spoke to Dr. Smith." must NOT split at "Dr."
        // even though the next char ("S") looks like a sentence-starter.
        if (ABBR_AT_END.test(sentence)) continue;
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
    private quietUntil = 0;
    // True while Kokoro is synthesizing — no child yet but audio IS coming,
    // so the mic echo gate stays closed. Bumped via `generation` on cancel()
    // so a stale .then can recognize it should skip.
    private synthesizing = false;
    private generation = 0;
    // Rate-limit the "no fallback TTS" warning so a long session without
    // espeak doesn't spam the console once per utterance.
    private warnedNoFallback = false;
    // Pipelined next-sentence synth. While playPcm is playing sentence N, we
    // eagerly kick off synth for sentence N+1 so by the time afplay closes,
    // the PCM for N+1 is (usually) already waiting. Keeps multi-sentence
    // playback seamless instead of gapping 1-2 s between sentences.
    private prefetchedPcm: Promise<Buffer> | null = null;
    private prefetchedGen = -1;

    constructor() {
        // Enabled as long as we have SOMETHING to play audio on this OS. The
        // primary path is Kokoro→WAV→PLAYBACK_COMMAND; if Kokoro isn't ready
        // yet we fall back to the OS's built-in speech synth (say / PS /
        // espeak). On a Linux box with no audio tooling at all, disable.
        this.enabled = PLAYBACK_COMMAND !== null || FALLBACK_TTS !== null;
        if (!this.enabled) {
            console.log(
                "[TRANSCRIPT-SPEAKER] disabled — no audio playback or TTS found. " +
                "Install one of: paplay (pulseaudio-utils), aplay (alsa-utils), " +
                "ffplay (ffmpeg), or espeak for fallback speech."
            );
            return;
        }
        // Background model download. Skip under vitest so tests don't pull 96 MB.
        if (!process.env.VITEST) {
            initKokoro().catch(err => {
                console.warn("[TRANSCRIPT-SPEAKER] Kokoro init error:", (err as Error).message);
            });
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
     * Play an already-synthesized PCM buffer directly — used by the ack bank
     * to fire pre-generated "one sec" / "got it" acknowledgments the moment
     * a tool call starts, with no Kokoro synth round-trip. If there's already
     * a child playing, we SIGTERM it first (its PCM is stale now — a new
     * tool-call ack means a new turn is happening) and bump the generation
     * so any prefetched synth is dropped.
     */
    playRawPcm(pcm: Buffer): void {
        if (!this.enabled || this.disabled || pcm.length === 0) return;
        if (this.running) {
            // Stale child from a prior turn — kill it so we don't get two
            // afplays blasting simultaneously. attachChildHandlers's onExit
            // will still fire and clean up the temp wav; `stillActive` will
            // be false by then since we null `running` below.
            try { this.running.kill("SIGTERM"); } catch { /* already dead */ }
            this.running = null;
        }
        // Bump generation so any stale Kokoro `.then` or prefetch drops.
        this.generation++;
        this.synthesizing = false;
        this.queue = [];
        this.prefetchedPcm = null;
        this.prefetchedGen = -1;
        this.playPcm(pcm);
    }

    /**
     * Speak a complete utterance. Splits into sentences so the first sentence
     * starts playing as soon as Kokoro finishes synthing it (~1 s for a short
     * sentence, vs ~6 s if we synth the whole utterance first). Subsequent
     * sentences are pre-synthed while the current one plays, so there's no
     * gap between them — they flow back-to-back like natural speech.
     */
    speak(fullText: string): void {
        const t = stripTtsMarkup(fullText.trim());
        console.log(`[SPEAKER] speak() called: enabled=${this.enabled} disabled=${this.disabled} len=${t.length} preview="${t.slice(0, 60)}"`);
        if (!this.enabled || this.disabled) return;
        if (!t) return;
        // Sentence-split into the queue. Each extracted sentence becomes its
        // own Kokoro synth + afplay child — but we pipeline the synth work
        // (see prefetchNext in playPcm) so playback feels continuous.
        let remaining = t;
        let sentenceCount = 0;
        while (true) {
            const next = extractSentence(remaining);
            if (!next) break;
            if (next.sentence) {
                this.enqueue(next.sentence);
                sentenceCount++;
            }
            remaining = next.rest;
        }
        const tail = remaining.trim();
        if (tail) {
            this.enqueue(tail);
            sentenceCount++;
        }
        console.log(`[SPEAKER] speak() split into ${sentenceCount} sentences`);
    }

    /**
     * Call when Gemini starts producing inline audio for this turn. The
     * speaker stays quiet for the rest of the turn so the two audio
     * streams don't overlap. Reset via onNewTurn().
     */
    suppressForTurn(): void {
        if (!this.enabled || this.disabled) return;
        console.log("[SPEAKER] suppressForTurn() — disabling until next turn");
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
        console.log(`[SPEAKER] onNewTurn() — re-enabling, was disabled=${this.disabled}`);
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
        const hadRunning = this.running !== null;
        const qLen = this.queue.length;
        const wasSynth = this.synthesizing;
        const hadPrefetch = this.prefetchedPcm !== null;
        // Capture the stack trace so we can see WHERE cancel came from —
        // the truncation bug we chased for days turns out to be someone
        // calling cancel() mid-playback, and stack is the only way to tell.
        const caller = new Error().stack?.split("\n")[2]?.trim() ?? "?";
        console.log(`[SPEAKER] cancel() — hadRunning=${hadRunning} queueLen=${qLen} wasSynth=${wasSynth} hadPrefetch=${hadPrefetch} gen=${this.generation}→${this.generation + 1} from=${caller}`);
        this.queue = [];
        this.quietUntil = 0;
        this.generation++;          // signals any in-flight Kokoro synth to drop
        this.synthesizing = false;
        // Drop the prefetched synth — its .then() will early-return via the
        // generation check. We don't need to cancel the Kokoro worker: it
        // will finish synthing and the PCM will just be discarded.
        this.prefetchedPcm = null;
        this.prefetchedGen = -1;
        if (this.running) {
            // SIGTERM lets the player subprocess exit cleanly (within ~10 ms)
            // so its close handler fires and we clean up any temp WAV file.
            // SIGKILL also fires close, but SIGTERM is the documented pattern
            // for afplay / paplay / PowerShell cancel. Indistinguishable for
            // the user's perceived latency.
            try { this.running.kill("SIGTERM"); } catch { /* already dead */ }
            this.running = null;
        }
    }

    // Used by LiveVoiceSession to gate the mic→backend path. Includes a
    // short post-close quiet window so the audio tail doesn't leak back
    // through the mic and re-ignite the feedback loop.
    isSpeaking(): boolean {
        if (this.running !== null || this.queue.length > 0 || this.synthesizing) return true;
        return Date.now() < this.quietUntil;
    }

    /**
     * Strict variant: true ONLY while the player subprocess is running or
     * a synth is in flight — NOT during the post-playback quiet window.
     * Used for barge-in short-chunk gating so user ACKs like "okay" / "yes"
     * arriving right after Bhai finishes don't get wrongly dropped as
     * echo-fragments.
     */
    activelyPlaying(): boolean {
        return this.running !== null || this.queue.length > 0 || this.synthesizing;
    }

    private enqueue(sentence: string): void {
        this.queue.push(sentence);
        console.log(`[SPEAKER] enqueue len=${sentence.length} queueNow=${this.queue.length} running=${this.running !== null} synth=${this.synthesizing}`);
        // Also gate on `synthesizing`: Kokoro's async start means `next()` returns
        // without setting `running`, so two overlapping sentences could otherwise
        // launch two concurrent syntheses whose audio would play simultaneously.
        if (!this.running && !this.synthesizing) this.next();
    }

    private next(): void {
        // Fast path: a prefetched synth from the previous playPcm is already
        // in flight (or done). Consume it — its sentence has already been
        // shifted from the queue, so we don't shift again.
        if (this.prefetchedPcm && this.prefetchedGen === this.generation) {
            const p = this.prefetchedPcm;
            this.prefetchedPcm = null;
            this.prefetchedGen = -1;
            const myGen = this.generation;
            this.synthesizing = true;
            const t0 = Date.now();
            p.then(pcm => {
                const ms = Date.now() - t0;
                if (myGen !== this.generation) {
                    console.log(`[SPEAKER] next() prefetch STALE gen=${myGen} — dropping ${pcm.length} bytes`);
                    return;
                }
                console.log(`[SPEAKER] next() prefetch resolved gen=${myGen} pcmBytes=${pcm.length} waitMs=${ms} → playPcm`);
                this.synthesizing = false;
                this.playPcm(pcm);
            }).catch(err => {
                if (myGen !== this.generation) return;
                this.synthesizing = false;
                console.warn(`[SPEAKER] next() prefetch FAILED: ${(err as Error).message}`);
                this.next();  // try the regular path on whatever is next
            });
            return;
        }

        const sentence = this.queue.shift();
        if (!sentence) {
            console.log("[SPEAKER] next() — queue empty, idle");
            this.running = null;
            return;
        }
        // Only use Kokoro when the model is fully loaded. Otherwise the first
        // sentence would block 25-60s on the cold download — fall back to the
        // OS's built-in TTS during that window so the user hears something
        // immediately.
        const myGen = this.generation;
        if (!hasKokoroFailed() && isKokoroReady()) {
            console.log(`[SPEAKER] next() → Kokoro synth start gen=${myGen} len=${sentence.length}`);
            this.synthesizing = true;
            const t0 = Date.now();
            kokoroSynthesize(sentence)
                .then(pcm => {
                    const ms = Date.now() - t0;
                    // Stale-path check MUST come before touching synthesizing.
                    // Otherwise the old .then clobbers a newer synth's flag and
                    // opens the mic gate while Kokoro is still producing audio.
                    if (myGen !== this.generation) {
                        console.log(`[SPEAKER] next() synth resolved STALE (gen ${myGen} vs ${this.generation}) — dropping ${pcm.length} bytes after ${ms}ms`);
                        return;
                    }
                    console.log(`[SPEAKER] next() synth resolved gen=${myGen} pcmBytes=${pcm.length} durMs=${ms} → playPcm`);
                    this.synthesizing = false;
                    this.playPcm(pcm);
                })
                .catch(err => {
                    const ms = Date.now() - t0;
                    if (myGen !== this.generation) {
                        console.log(`[SPEAKER] next() synth REJECTED stale gen=${myGen}: ${(err as Error).message}`);
                        return;
                    }
                    this.synthesizing = false;
                    console.warn(`[SPEAKER] next() Kokoro synth FAILED after ${ms}ms, falling back to OS TTS: ${(err as Error).message}`);
                    this.speakViaSystemTts(sentence);
                });
            return;
        }
        console.log(`[SPEAKER] next() → OS TTS (kokoroReady=${isKokoroReady()} kokoroFailed=${hasKokoroFailed()})`);
        this.speakViaSystemTts(sentence);
    }

    /**
     * While the current sentence's afplay plays, eagerly start synthesizing
     * the next queued sentence. Result is stashed in `prefetchedPcm` and
     * consumed by the next `next()` call — so sentences flow back-to-back
     * with no audible synth gap between them.
     */
    private prefetchNext(): void {
        if (this.prefetchedPcm) return;           // already prefetching
        if (this.queue.length === 0) return;      // nothing to prefetch
        if (hasKokoroFailed() || !isKokoroReady()) return;  // Kokoro unusable
        const sentence = this.queue.shift()!;
        const myGen = this.generation;
        console.log(`[SPEAKER] prefetchNext gen=${myGen} len=${sentence.length} qRemaining=${this.queue.length}`);
        this.prefetchedGen = myGen;
        this.prefetchedPcm = kokoroSynthesize(sentence);
    }

    private playPcm(pcm: Buffer): void {
        // Wrap PCM in a WAV container on disk, then spawn the platform-picked
        // player (afplay / PowerShell SoundPlayer / paplay|aplay|ffplay).
        // See buildWavHeader() above for why stdin piping was unreliable.
        const samples = pcm.length / 2;
        const expectedSec = samples / KOKORO_SAMPLE_RATE;
        console.log(`[SPEAKER] playPcm pcmBytes=${pcm.length} samples=${samples} expected=${expectedSec.toFixed(2)}s`);
        if (!PLAYBACK_COMMAND) {
            console.warn("[SPEAKER] playPcm — no PLAYBACK_COMMAND, falling through");
            // No player on this box — fall through to OS TTS (or drop).
            this.speakViaSystemTts("");  // no text means: just advance queue
            return;
        }
        const wavPath = join(tmpdir(), `bhai-tts-${randomUUID()}.wav`);
        try {
            writeFileSync(wavPath, Buffer.concat([buildWavHeader(pcm.length), pcm]));
        } catch (err) {
            console.warn("[SPEAKER] WAV temp-file write failed:", (err as Error).message);
            this.running = null;
            this.next();
            return;
        }
        const { cmd, buildArgs, spawnOpts } = PLAYBACK_COMMAND;
        let child: ChildProcess;
        const tSpawn = Date.now();
        try {
            child = spawn(cmd, buildArgs(wavPath), {
                stdio: ["ignore", "ignore", "ignore"],
                ...(spawnOpts ?? {}),
            });
        } catch (err) {
            // Rare path: spawn() can throw synchronously on EINVAL / resource
            // limits. Without this catch the temp WAV would leak into tmpdir.
            console.warn(`[SPEAKER] spawn(${cmd}) failed synchronously:`, (err as Error).message);
            try { unlinkSync(wavPath); } catch { /* already gone */ }
            this.running = null;
            this.next();
            return;
        }
        console.log(`[SPEAKER] playPcm spawned ${cmd} pid=${child.pid} wav=${wavPath} expected=${expectedSec.toFixed(2)}s`);
        this.running = child;
        // Remember the temp file so attachChildHandlers can delete it once
        // playback exits. Any-cast because ChildProcess has no user slot.
        (child as unknown as { __bhaiTempFile?: string; __bhaiSpawnTs?: number; __bhaiExpectedMs?: number })
            .__bhaiTempFile = wavPath;
        (child as unknown as { __bhaiSpawnTs?: number }).__bhaiSpawnTs = tSpawn;
        (child as unknown as { __bhaiExpectedMs?: number }).__bhaiExpectedMs = Math.round(expectedSec * 1000);
        this.attachChildHandlers(child);
        // Pipeline: kick off synth of the NEXT queued sentence RIGHT NOW so
        // by the time afplay closes, its PCM is already (or nearly) ready.
        // Turns multi-sentence playback from chunky "synth 1 s, play 2 s,
        // synth 1 s, play 2 s" → seamless "play 2 s, play 2 s" flow.
        this.prefetchNext();
    }

    private speakViaSystemTts(sentence: string): void {
        // Fallback path: used before Kokoro has finished its first cold load,
        // or if Kokoro synthesis fails. On Linux with no espeak available,
        // we just drop the utterance — the user will get Kokoro audio once
        // the model is ready.
        if (!sentence.trim()) {
            // Internal queue-advance signal from playPcm's no-player branch.
            this.running = null;
            this.next();
            return;
        }
        if (!FALLBACK_TTS) {
            // Real sentence but no fallback binary. Warn once so a Linux user
            // without espeak can see WHY their voice assistant went silent.
            if (!this.warnedNoFallback) {
                this.warnedNoFallback = true;
                console.warn(
                    "[TRANSCRIPT-SPEAKER] Kokoro not ready and no fallback TTS installed. " +
                    "Install `espeak` (e.g. `apt install espeak`) to hear audio during Kokoro's cold start."
                );
            }
            this.running = null;
            this.next();
            return;
        }
        const { cmd, buildArgs, spawnOpts } = FALLBACK_TTS;
        let child: ChildProcess;
        try {
            child = spawn(cmd, buildArgs(sentence), {
                stdio: ["ignore", "ignore", "ignore"],
                ...(spawnOpts ?? {}),
            });
        } catch (err) {
            console.warn(`[TRANSCRIPT-SPEAKER] spawn(${cmd}) failed synchronously:`, (err as Error).message);
            this.running = null;
            this.next();
            return;
        }
        this.running = child;
        this.attachChildHandlers(child);
    }

    // Common close/error handling for the WAV-player child (afplay / PS /
    // paplay etc.) AND the fallback OS-TTS child (say / PS SpeechSynthesizer /
    // espeak). cancel() detaches by nulling `running`; only the handler whose
    // child is still the active one should extend the quiet window. Otherwise
    // a cancel()-triggered SIGTERM close handler would clobber `quietUntil=0`
    // and clip the next 250 ms of user mic input.
    //
    // Node emits BOTH `error` and `close` for the same child on ENOENT, so we
    // gate shared work behind a per-child `fired` flag — otherwise `next()`
    // would drain the queue by 2 per failure and we'd spawn overlapping audio.
    private attachChildHandlers(child: ChildProcess): void {
        let fired = false;
        const onExit = (reason: "close" | "error", code?: number | null, signal?: NodeJS.Signals | null) => {
            if (fired) return;
            fired = true;
            const meta = child as unknown as { __bhaiTempFile?: string; __bhaiSpawnTs?: number; __bhaiExpectedMs?: number };
            const actualMs = meta.__bhaiSpawnTs ? Date.now() - meta.__bhaiSpawnTs : -1;
            const expectedMs = meta.__bhaiExpectedMs ?? -1;
            const stillActive = this.running === child;
            const short = expectedMs > 0 && actualMs > 0 && actualMs < expectedMs * 0.9;
            console.log(`[SPEAKER] child ${reason} pid=${child.pid} code=${code} signal=${signal} actualMs=${actualMs} expectedMs=${expectedMs} short=${short} stillActive=${stillActive} qLen=${this.queue.length}`);
            const path = meta.__bhaiTempFile;
            if (path) {
                try { unlinkSync(path); } catch { /* already gone */ }
            }
            if (stillActive) {
                this.running = null;
                this.quietUntil = Date.now() + POST_SPEAK_QUIET_MS;
            }
            this.next();
        };
        child.on("error", () => onExit("error", null, null));
        child.on("close", (code, signal) => onExit("close", code, signal));
    }
}
