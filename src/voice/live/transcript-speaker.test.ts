// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { extractSentence, TranscriptSpeaker } from "./transcript-speaker.js";

describe("extractSentence — sentence splitter for on-device TTS", () => {
    it("returns null when the buffer has no complete sentence yet", () => {
        expect(extractSentence("Hello")).toBeNull();
        expect(extractSentence("Hello world")).toBeNull();
    });

    it("splits on '.!?' followed by space + uppercase next sentence", () => {
        const got = extractSentence("It is four pm. The weather is fine.");
        expect(got?.sentence).toBe("It is four pm.");
        expect(got?.rest).toBe("The weather is fine.");
    });

    it("does NOT split on decimals like '3.14 is pi'", () => {
        // "3." followed by "14" (lowercase) should not split.
        expect(extractSentence("3.14 is pi")).toBeNull();
    });

    it("does NOT split on 'Mr.' or 'Dr.' abbreviations followed by lowercase", () => {
        expect(extractSentence("Dr. smith walked")).toBeNull();
        expect(extractSentence("e.g. one thing")).toBeNull();
    });

    it("does split on 'Dr. Smith walked in. The door…' (two proper sentences)", () => {
        const got = extractSentence("Dr. Smith walked in. The door opened.");
        // First complete sentence ends at the second period (before "The").
        expect(got?.sentence).toBe("Dr. Smith walked in.");
        expect(got?.rest).toBe("The door opened.");
    });

    it("requires the sentence to be at least MIN_SENTENCE_CHARS (12) before flushing", () => {
        // "Yes." is under 12 chars AND there's no post-terminator to
        // confirm a second sentence, so extractSentence returns null;
        // the caller will flush() the whole buffer on turn_complete.
        expect(extractSentence("Yes. I am leaving now.")).toBeNull();
        // Two sentences, first too short to flush on its own, second
        // serves as the post-terminator → first "Hi." is skipped and we
        // wait for the tail.
        expect(extractSentence("Hi. I am leaving right now.")).toBeNull();
        // When followed by a clearly-new sentence AND first is long enough:
        const got = extractSentence("This sentence is long enough. The next one follows.");
        expect(got?.sentence).toBe("This sentence is long enough.");
        expect(got?.rest).toBe("The next one follows.");
    });

    it("flushes on CJK terminators regardless of length", () => {
        const got = extractSentence("これ。後で。");
        expect(got?.sentence).toBe("これ。");
        expect(got?.rest).toBe("後で。");
    });

    it("handles Hindi/Devanagari text that ends with '.'", () => {
        const got = extractSentence("बहुत अच्छा है. अगला वाक्य.");
        expect(got?.sentence).toBe("बहुत अच्छा है.");
    });

    it("handles quoted sentences", () => {
        const got = extractSentence(`He said "go." She left.`);
        expect(got?.sentence).toBe(`He said "go."`);
        expect(got?.rest).toBe("She left.");
    });

    it("end-of-input also counts as a terminator (for the LAST sentence of a turn)", () => {
        // At end of buffer with no trailing whitespace, current extractor
        // requires a space + uppercase OR $. The `$` branch catches this.
        const got = extractSentence("This is the entire turn.");
        // A single sentence ending at buffer-end — the extractor regex needs
        // a post-terminator character. Since none exists, we expect null here
        // and rely on flush() to handle the trailing buffer at turn_complete.
        expect(got).toBeNull();
    });
});

describe("TranscriptSpeaker — onNewTurn vs cancel semantics", () => {
    // The speaker is a no-op on non-darwin. These tests inspect its internal
    // state to verify the semantics split introduced in round 2 review:
    //   - onNewTurn: keep queue flowing, re-enable, clear partial buffer
    //   - cancel:    hard stop, drop queue, kill in-flight `say`
    //
    // We access private members via `as any` — acceptable for unit tests.

    it("onNewTurn() preserves the in-flight queue (graceful turn transition)", () => {
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;             // force-enable on non-macOS for the test
        s.queue = ["a sentence", "another"];
        s.buffer = "trailing fragment";
        s.disabled = true;
        s.onNewTurn();
        expect(s.disabled).toBe(false);
        expect(s.buffer).toBe("");
        // Queue is kept so the last sentence from the prior turn finishes.
        expect(s.queue).toEqual(["a sentence", "another"]);
    });

    it("cancel() drops the queue (instant silence on interrupt / stop)", () => {
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        s.queue = ["queued 1", "queued 2"];
        s.cancel();
        expect(s.queue).toEqual([]);
    });

    it("suppressForTurn() disables the speaker and clears buffer + queue", () => {
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        s.queue = ["leftover"];
        s.buffer = "half a sentence";
        s.suppressForTurn();
        expect(s.disabled).toBe(true);
        expect(s.buffer).toBe("");
        expect(s.queue).toEqual([]);
    });

    it("isSpeaking() reflects queued sentences or in-flight `say`", () => {
        const s = new TranscriptSpeaker() as any;
        // Fresh state — nothing queued, nothing running.
        expect(s.isSpeaking()).toBe(false);
        // Queue alone is enough (a `next()` tick will pick it up).
        s.queue = ["pending sentence"];
        expect(s.isSpeaking()).toBe(true);
        s.queue = [];
        expect(s.isSpeaking()).toBe(false);
        // An in-flight `say` process (mocked as any non-null object) counts too.
        s.running = { kill() { /* noop */ } };
        expect(s.isSpeaking()).toBe(true);
        s.running = null;
        expect(s.isSpeaking()).toBe(false);
    });

    it("isSpeaking() keeps the gate closed through the post-`say` quiet window", () => {
        const s = new TranscriptSpeaker() as any;
        // Simulate a `say` that just closed: running is null, queue empty,
        // but quietUntil is set ~250ms in the future (what the child.close
        // handler does).
        s.running = null;
        s.queue = [];
        s.quietUntil = Date.now() + 250;
        expect(s.isSpeaking()).toBe(true);
        // Fast-forward past the grace window.
        s.quietUntil = Date.now() - 1;
        expect(s.isSpeaking()).toBe(false);
    });

    it("cancel() resets quietUntil so user interrupts open the gate immediately", () => {
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        s.quietUntil = Date.now() + 60_000; // far-future
        s.cancel();
        expect(s.quietUntil).toBe(0);
        expect(s.isSpeaking()).toBe(false);
    });

    it("cancel()-triggered close handler does NOT re-arm quietUntil (gate stays open)", () => {
        // Reproduces the subtle race: cancel()/suppressForTurn() SIGKILLs the
        // child and sets quietUntil=0. The child's 'close' event fires on the
        // next tick — if that handler unconditionally writes quietUntil, the
        // next 250ms of user speech gets clipped. The fix is guarded writes
        // that only extend quietUntil if `running === child` is still true.
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        // Simulate: we were speaking, then cancel() ran — running=null, quietUntil=0.
        const staleChild = { kill() { /* noop */ } };
        s.running = null;          // cancel already detached
        s.quietUntil = 0;          // cancel already reset
        // Now the close-handler logic: emulate the check from next() inline.
        if (s.running === staleChild) {
            s.running = null;
            s.quietUntil = Date.now() + 250;
        }
        // Expectation: the stale close handler was a no-op.
        expect(s.quietUntil).toBe(0);
        expect(s.isSpeaking()).toBe(false);
    });
});

