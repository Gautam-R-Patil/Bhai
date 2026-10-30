// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Structured turn events for live chat surfaces: the status line, the step list,
// owner-only notes (thinking, narration) and the streamed answer with its resets.

import type { LLMDelta } from "./llm-stream.js";
import { AnswerStreamFilter, NoteStreamFilter } from "./stream-filter.js";

export type TurnEvent =
    | { type: "status"; text: string; step: number; elapsedSec: number }
    | { type: "step"; id: number; text: string; state: "running" | "done" | "failed" }
    | { type: "note"; text: string }
    | { type: "answer"; attempt: number; text: string }
    | { type: "answer_reset"; attempt: number }
    | { type: "end" };

export type TurnEventSink = (e: TurnEvent) => void;

type StatusEvent = Extract<TurnEvent, { type: "status" }>;

/** "🔍 Searching: x" → "Searching: x": status and step text go out plain, so every surface shows the same words. */
const plainText = (text: string) => text.replace(/^(?:\p{Extended_Pictographic}|\u200d|\ufe0f|\s)+/u, "");

/** Status updates at most every `minGapMs`, but the latest one is never dropped: it goes out late or on flush. */
export function createStatusCoalescer(
    sink: TurnEventSink,
    minGapMs = 3000,
): { push(e: StatusEvent): void; flush(): void; stop(): void } {
    let lastAt = Number.NEGATIVE_INFINITY;
    let pending: StatusEvent | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    const flush = () => {
        stop();
        if (!pending) return;
        const e = pending;
        pending = null;
        lastAt = Date.now();
        sink(e);
    };
    return {
        push(e) {
            pending = e;
            const wait = lastAt + minGapMs - Date.now();
            if (wait <= 0) return flush();
            if (!timer) {
                timer = setTimeout(flush, wait);
                timer.unref?.();
            }
        },
        flush,
        stop,
    };
}

/**
 * One turn's event stream. `live()` starts a main-loop model call and returns its onDelta;
 * `withdraw` takes back a streamed answer (a check sent it back, the call failed, it was
 * narration before tools). Filters are per attempt: fresh after every withdraw and call.
 */
export function createTurnStream(unsafeSink: TurnEventSink, opts: { channel: string; notes: boolean }) {
    // Fail-open: a surface that throws never breaks the turn (like sendProgress).
    const sink: TurnEventSink = (e) => {
        try {
            unsafeSink(e);
        } catch (err) {
            console.warn(`[turn-events] sink failed on ${e.type}: ${(err as Error).message}`);
        }
    };
    const status = createStatusCoalescer(sink);
    let attempt = 0;
    let answer = new AnswerStreamFilter({ channel: opts.channel });
    let note = new NoteStreamFilter();
    let raw = "";
    let shown = "";
    let stepId = 0;
    let openStep: { id: number; text: string } | null = null;
    let lastStep = 0; // the last status's step, so a status sent here carries on from it

    const emitNote = (text: string) => {
        if (text && opts.notes) sink({ type: "note", text });
    };
    const endNotes = () => {
        if (!opts.notes) return;
        emitNote(note.flush());
        note = new NoteStreamFilter();
    };
    const withdraw = (asNote = false) => {
        endNotes();
        if (!raw) return;
        if (asNote && opts.notes) {
            const n = new NoteStreamFilter();
            emitNote(n.push(raw) + n.flush());
        }
        sink({ type: "answer_reset", attempt });
        attempt++;
        answer = new AnswerStreamFilter({ channel: opts.channel });
        raw = "";
        shown = "";
    };
    const onDelta = (d: LLMDelta) => {
        switch (d.kind) {
            case "text": {
                raw += d.text;
                const out = answer.push(d.text);
                if (!out) return;
                shown += out;
                sink({ type: "answer", attempt, text: out });
                return;
            }
            case "note":
                if (opts.notes) emitNote(note.push(d.text));
                return;
            case "tool":
                return withdraw(true);
            case "void_tools": // a refusal fallback continues the text shown; only the thinking before it ends
                return endNotes();
            default: // reset: that attempt's text is void
                return withdraw();
        }
    };
    const closeStep = (state: "done" | "failed" = "done") => {
        if (!openStep) return false;
        sink({ type: "step", ...openStep, state });
        openStep = null;
        return true;
    };
    const pushStatus = (text: string, step: number, elapsedSec: number) => {
        lastStep = step;
        status.push({ type: "status", text: plainText(text), step, elapsedSec });
    };

    return {
        /** A main-loop model call starts: anything still shown from an earlier one is withdrawn. */
        live() {
            withdraw();
            return onDelta;
        },
        withdraw,
        /** A check sent the candidate reply back for more work. */
        sendBack(stepText: string) {
            withdraw();
            this.step(stepText);
        },
        step(text: string) {
            closeStep();
            openStep = { id: ++stepId, text: plainText(text) };
            sink({ type: "step", ...openStep, state: "running" });
        },
        /**
         * A tool step finished: the live line moves on from its "Searching…" to its results, at once
         * (a step boundary isn't churn). It replaces any older status still waiting on the throttle.
         */
        stepEnd(state: "done" | "failed", elapsedSec: number) {
            if (!closeStep(state)) return;
            pushStatus(state === "done" ? "Reading what I found" : "Seeing what went wrong", lastStep, elapsedSec);
            status.flush();
        },
        status: pushStatus,
        /** The filtered answer streamed so far (the turn was stopped). */
        partial(): string {
            return shown + answer.flush();
        },
        end() {
            endNotes();
            closeStep();
            status.flush();
            status.stop();
            sink({ type: "end" });
        },
    };
}

export type TurnStream = ReturnType<typeof createTurnStream>;
