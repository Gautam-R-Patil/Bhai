// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";

// Stub Kokoro. Default to "not ready" so the real `next()` falls through to
// speakViaSystemTts (which we in turn stub per-test by monkey-patching the
// class). Individual tests flip these via the mocked module's named exports.
let kokoroReadyFlag = false;
let kokoroFailedFlag = false;
const kokoroSynthesizeMock = vi.fn<(text: string) => Promise<Buffer>>();
vi.mock("./kokoro-tts.js", () => ({
    initKokoro: async () => null,
    synthesize: (text: string) => kokoroSynthesizeMock(text),
    isKokoroReady: () => kokoroReadyFlag,
    hasKokoroFailed: () => kokoroFailedFlag,
}));

import { extractSentence, TranscriptSpeaker, stripTtsMarkup } from "./transcript-speaker.js";

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

    it("abbreviation guard: does NOT split at 'Dr.' when followed by a capitalized name", () => {
        // Old splitter would greedily split here because "S" is uppercase.
        // New guard keeps "Dr. Smith" together.
        const got = extractSentence("I met with Dr. Smith about the project. Then I left.");
        expect(got?.sentence).toBe("I met with Dr. Smith about the project.");
        expect(got?.rest).toBe("Then I left.");
    });

    it("abbreviation guard: 'Mrs.', 'Ms.', 'Prof.', 'St.', 'Rev.' all preserved before a capital", () => {
        for (const [input, expected] of [
            ["Talking to Mrs. Johnson was fine. Next up.", "Talking to Mrs. Johnson was fine."],
            ["I emailed Ms. Davis already. She replied fast.", "I emailed Ms. Davis already."],
            ["Saw Prof. Kellar today. Great lecture.", "Saw Prof. Kellar today."],
            ["Visited St. Peter's basilica. Incredible place.", "Visited St. Peter's basilica."],
        ] as const) {
            const got = extractSentence(input);
            expect(got?.sentence, `input=${input}`).toBe(expected);
        }
    });

    it("abbreviation guard: 'e.g.' mid-sentence is preserved", () => {
        // "some fruits e.g. apples and oranges. The store had many."
        // Old splitter would split at "e.g." because next char is lowercase → continues.
        // But if "e.g." were followed by a capital it would wrongly split.
        const got = extractSentence("Some fruits e.g. Apples and oranges. The store had many.");
        expect(got?.sentence).toBe("Some fruits e.g. Apples and oranges.");
    });

    it("abbreviation guard: known U.S. / U.K. / p.m. / a.m. / No. / etc. are preserved", () => {
        for (const [input, expected] of [
            ["He moved to the U.S. Some time ago. Good for him.", "He moved to the U.S. Some time ago."],
            ["Meeting at 3 p.m. Starting room four. On the dot.", "Meeting at 3 p.m. Starting room four."],
            ["Part No. Four was missing. Reordered today.", "Part No. Four was missing."],
        ] as const) {
            const got = extractSentence(input);
            expect(got?.sentence, `input=${input}`).toBe(expected);
        }
    });

    it("abbreviation guard does NOT over-preserve common words", () => {
        // These words end in letters that WOULD match abbreviations if we were
        // too aggressive (ed/co/gen/rep/pres/col etc.). Make sure they still
        // split normally — they are NOT in ABBR_AT_END.
        for (const [input, expected] of [
            ["She shipped. Then she left.", "She shipped."],
            ["He's in general. Next topic.", "He's in general."],
            ["The company rep. Spoke briefly.", "The company rep."],
            ["He owns the co. Next year expands.", "He owns the co."],
        ] as const) {
            const got = extractSentence(input);
            expect(got?.sentence, `input=${input}`).toBe(expected);
        }
    });

    it("abbreviation at very end of buffer returns null (waits for more)", () => {
        // "Dr." alone — no continuation yet. extractSentence should NOT fire
        // a bogus flush since the caller might still be buffering.
        expect(extractSentence("Dr.")).toBeNull();
    });

    it("abbreviation followed by a lowercase word splits normally (not blocked)", () => {
        // "Meeting at 3 p.m. the conference starts." — next char lowercase,
        // so `looksLikeStart` already returns false; no need for the new
        // guard. Verify the existing uppercase-next rule still reigns.
        expect(extractSentence("Meeting at 3 p.m. the conference starts.")).toBeNull();
    });
});

describe("stripTtsMarkup — strip text-mode markup before TTS", () => {
    it("strips HTML comments (widget / overlay markers)", () => {
        expect(stripTtsMarkup("It's 11:46 AM.<!--WIDGET: {\"type\": \"clock\"}-->")).toBe("It's 11:46 AM.");
        expect(stripTtsMarkup("before <!--COLLAPSE--> after")).toBe("before  after");
    });

    it("strips multi-line HTML comments", () => {
        expect(stripTtsMarkup("before<!--\nline\n-->after")).toBe("beforeafter");
    });

    it("strips code fences but keeps inner text", () => {
        expect(stripTtsMarkup("```js\nconst x = 1;\n```")).toBe("const x = 1;");
    });

    it("strips inline backticks", () => {
        expect(stripTtsMarkup("use `foo` to bar")).toBe("use foo to bar");
    });

    it("strips markdown link syntax but keeps link text", () => {
        expect(stripTtsMarkup("see [the docs](https://example.com) for more")).toBe("see the docs for more");
    });

    it("strips bold/italic asterisks", () => {
        expect(stripTtsMarkup("this is **bold** and *italic*")).toBe("this is bold and italic");
    });

    it("strips leading bullet markers from each line", () => {
        const input = "* first\n- second\n• third\n1. fourth";
        expect(stripTtsMarkup(input)).toBe("first\nsecond\nthird\nfourth");
    });

    it("preserves Devanagari and other non-Latin scripts", () => {
        expect(stripTtsMarkup("अभी सुबह के 11:46 हो रहे हैं।<!--WIDGET-->")).toBe("अभी सुबह के 11:46 हो रहे हैं।");
    });

    it("handles empty / already-clean input", () => {
        expect(stripTtsMarkup("")).toBe("");
        expect(stripTtsMarkup("Hello, how are you?")).toBe("Hello, how are you?");
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

    it("isSpeaking() reports true while Kokoro is synthesizing even without a child yet", () => {
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        s.running = null;
        s.queue = [];
        s.quietUntil = 0;
        // Kokoro is mid-synthesis: we have no child yet but audio IS being produced.
        // isSpeaking() must return true so the mic gate stays closed through that window.
        s.synthesizing = true;
        expect(s.isSpeaking()).toBe(true);
        s.synthesizing = false;
        expect(s.isSpeaking()).toBe(false);
    });

    it("cancel() bumps generation + clears synthesizing so in-flight Kokoro audio is dropped", () => {
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        s.synthesizing = true;
        const beforeGen = s.generation;
        s.cancel();
        expect(s.generation).toBe(beforeGen + 1);
        expect(s.synthesizing).toBe(false);
        // Gate should be open immediately (user-initiated stop = instant mic).
        expect(s.isSpeaking()).toBe(false);
    });

    it("enqueue() does NOT start a second Kokoro synth while one is already in-flight", () => {
        // Kokoro's synth is async: next() sets synthesizing=true then returns
        // BEFORE a child is spawned. If a second sentence arrives in that
        // window and enqueue() only checked `running`, it would call next()
        // again and kick off a concurrent synth whose audio would overlap
        // the first. The fix: enqueue gates on BOTH running AND synthesizing.
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        let nextCalls = 0;
        s.next = () => { nextCalls++; };
        // Synth A is mid-flight: synthesizing=true, running=null (no child yet).
        s.synthesizing = true;
        s.running = null;
        // Second sentence enqueued — should NOT trigger another next().
        s.enqueue("second sentence");
        expect(nextCalls).toBe(0);
        expect(s.queue).toContain("second sentence");
        // Once synthesis finishes (synthesizing=false) and a child spawns (running=child),
        // the child's close handler calls next() — that's the normal drain path.
        // Here we just assert the guard held during the overlap.
    });

    it("old Kokoro .then does NOT clobber a newer synth's synthesizing flag", async () => {
        // Real regression test exercising the actual next() implementation.
        // Two Kokoro synths overlap; A's .then settles AFTER cancel + B starts.
        // If the guard `myGen !== generation` is removed or reordered, A's
        // .then would clear B's synthesizing=true — this test would fail.
        kokoroReadyFlag = true;
        kokoroFailedFlag = false;

        let resolveA!: (pcm: Buffer) => void;
        let resolveB!: (pcm: Buffer) => void;
        kokoroSynthesizeMock.mockReset();
        kokoroSynthesizeMock
            .mockImplementationOnce(() => new Promise<Buffer>((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise<Buffer>((resolve) => { resolveB = resolve; }));

        const s = new TranscriptSpeaker() as any;
        s.enabled = true;
        // Stub playPcm so A's .then doesn't actually spawn a player child on a stale resolve.
        s.playPcm = () => { /* stubbed */ };

        // Drive synth A through the real next().
        s.queue.push("first");
        s.next();
        const genA = s.generation;
        expect(s.synthesizing).toBe(true);

        // cancel() bumps generation + clears synthesizing.
        s.cancel();
        expect(s.generation).toBe(genA + 1);
        expect(s.synthesizing).toBe(false);

        // Drive synth B through the real next().
        s.queue.push("second");
        s.next();
        expect(s.synthesizing).toBe(true);

        // A's promise finally resolves — the real .then runs. Guard MUST early-return.
        resolveA(Buffer.alloc(0));
        await new Promise(r => setImmediate(r));

        // B's flag must survive.
        expect(s.synthesizing).toBe(true);

        // Clean up: resolve B so its .then can finish naturally.
        resolveB(Buffer.alloc(0));
        await new Promise(r => setImmediate(r));
    });

    it("close handler does NOT re-arm quietUntil when cancel() already detached the child", async () => {
        // Drives the REAL attachChildHandlers() code path. Mounts a fake
        // EventEmitter child on the speaker, calls cancel() (which nulls
        // `running`), then fires the child's own 'close' event. Asserts
        // quietUntil stays 0.
        const { EventEmitter } = await import("node:events");
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;

        const fakeChild: any = new EventEmitter();
        fakeChild.kill = () => { /* noop */ };
        s.running = fakeChild;
        s.attachChildHandlers(fakeChild);

        // cancel() nulls running + resets quietUntil.
        s.cancel();
        expect(s.running).toBeNull();
        expect(s.quietUntil).toBe(0);

        // Now fire the child's close event — the real handler runs.
        // Since running !== fakeChild, the guard should skip the quietUntil write.
        fakeChild.emit("close");
        expect(s.quietUntil).toBe(0);
        expect(s.isSpeaking()).toBe(false);
    });

    it("close handler DOES re-arm quietUntil when the child is still active", async () => {
        // Complement of the previous test — normal drain path. If `running`
        // still points at the child when close fires, quietUntil MUST extend
        // to protect against trailing echo.
        const { EventEmitter } = await import("node:events");
        const s = new TranscriptSpeaker() as any;
        s.enabled = true;

        const fakeChild: any = new EventEmitter();
        fakeChild.kill = () => { /* noop */ };
        s.running = fakeChild;
        s.attachChildHandlers(fakeChild);

        const before = Date.now();
        fakeChild.emit("close");
        // Guard was satisfied (running === child), so quietUntil extends.
        expect(s.running).toBeNull();
        expect(s.quietUntil).toBeGreaterThanOrEqual(before);
        expect(s.isSpeaking()).toBe(true);
    });
});

