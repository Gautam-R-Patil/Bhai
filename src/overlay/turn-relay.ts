// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// One overlay turn's events as WS messages (`turn_*`, each with `turn` and `seq`). Answer and
// note deltas are coalesced; the relay keeps what it sent so a rejoining socket gets a snapshot.

import type { TurnEvent, TurnEventSink } from "../turn-events.js";

export type TurnSnapshot = {
    status?: { text: string; step: number; elapsed: number };
    steps: { id: number; text: string; state: string }[];
    notes: string[];
    answer: string;
};

type Delta = { kind: "note"; text: string } | { kind: "answer"; attempt: number; text: string };

export function createTurnRelay(opts: {
    turn: string;
    send: (msg: object) => void;
    owner: boolean;
    coalesceMs?: number;
}): { sink: TurnEventSink; snapshot(): TurnSnapshot & { seq: number }; finish(): void } {
    const coalesceMs = opts.coalesceMs ?? 40;
    const state: TurnSnapshot = { steps: [], notes: [], answer: "" };
    let seq = 0;
    let done = false;
    let pending: Delta[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const out = (type: string, fields: object) => opts.send({ type, turn: opts.turn, seq: ++seq, ...fields });
    const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const batch = pending;
        pending = [];
        for (const d of batch) {
            if (d.kind === "note") {
                state.notes.push(d.text);
                out("turn_note", { text: d.text });
            } else {
                state.answer += d.text;
                out("turn_answer", { attempt: d.attempt, text: d.text });
            }
        }
    };
    const queue = (d: Delta) => {
        const last = pending.at(-1);
        const same =
            last?.kind === "note"
                ? d.kind === "note"
                : last?.kind === "answer" && d.kind === "answer" && last.attempt === d.attempt;
        if (last && same) last.text += d.text;
        else pending.push(d);
        if (!timer) {
            timer = setTimeout(flush, coalesceMs);
            timer.unref?.();
        }
    };
    const finish = () => {
        flush();
        done = true;
    };

    const sink = (e: TurnEvent) => {
        if (done) return;
        switch (e.type) {
            case "note":
                // Thinking and narration are the owner's: never on a guest socket.
                if (opts.owner && e.text) queue({ kind: "note", text: e.text });
                return;
            case "answer":
                if (e.text) queue({ kind: "answer", attempt: e.attempt, text: e.text });
                return;
            case "end":
                return finish();
        }
        flush(); // keep order: what was pending goes out before this
        if (e.type === "status") {
            state.status = { text: e.text, step: e.step, elapsed: e.elapsedSec };
            out("turn_status", state.status);
        } else if (e.type === "step") {
            const s = { id: e.id, text: e.text, state: e.state };
            const i = state.steps.findIndex((x) => x.id === e.id);
            if (i >= 0) state.steps[i] = s;
            else state.steps.push(s);
            out("turn_step", s);
        } else {
            state.answer = "";
            out("turn_answer_reset", { attempt: e.attempt });
        }
    };

    return {
        sink,
        snapshot: () => ({ ...state, steps: state.steps.map((s) => ({ ...s })), notes: [...state.notes], seq }),
        finish,
    };
}
