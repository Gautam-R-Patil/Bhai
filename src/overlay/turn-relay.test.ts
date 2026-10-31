// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { afterEach, expect, it, vi } from "vitest";
import { createTurnRelay } from "./turn-relay.js";

type Sent = { type: string; turn: string; seq: number; [k: string]: unknown };

function relay(owner = true) {
    const sent: Sent[] = [];
    const r = createTurnRelay({ turn: "t1", owner, send: (m) => sent.push(m as Sent) });
    return { ...r, sent };
}

afterEach(() => vi.useRealTimers());

it("coalesces answer deltas", () => {
    vi.useFakeTimers();
    const r = relay();
    for (const t of ["He", "ll", "o", " wor", "ld"]) {
        r.sink({ type: "answer", attempt: 0, text: t });
        vi.advanceTimersByTime(5);
    }
    expect(r.sent).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(r.sent).toEqual([{ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Hello world" }]);
    // A step goes out at once, after what was pending, in order.
    r.sink({ type: "answer", attempt: 0, text: "!" });
    r.sink({ type: "step", id: 1, text: "Opening Chrome", state: "running" });
    expect(r.sent.slice(1)).toEqual([
        { type: "turn_answer", turn: "t1", seq: 2, attempt: 0, text: "!" },
        { type: "turn_step", turn: "t1", seq: 3, id: 1, text: "Opening Chrome", state: "running" },
    ]);
    r.finish();
});

it("notes never go to a guest relay", () => {
    vi.useFakeTimers();
    const r = relay(false);
    r.sink({ type: "note", text: "thinking about the inbox" });
    r.sink({ type: "answer", attempt: 0, text: "hi" });
    r.sink({ type: "end" });
    expect(r.sent.map((m) => m.type)).toEqual(["turn_answer"]);
    expect(r.snapshot().notes).toEqual([]);
});

it("snapshot reflects state after a reset", () => {
    vi.useFakeTimers();
    const r = relay();
    r.sink({ type: "status", text: "Reading mail", step: 1, elapsedSec: 3 });
    r.sink({ type: "step", id: 1, text: "Reading mail", state: "running" });
    r.sink({ type: "note", text: "Checking unread" });
    r.sink({ type: "answer", attempt: 0, text: "draft that gets withdrawn" });
    r.sink({ type: "answer_reset", attempt: 0 });
    r.sink({ type: "step", id: 1, text: "Reading mail", state: "done" });
    r.sink({ type: "answer", attempt: 1, text: "3 unread" });
    r.sink({ type: "end" });
    expect(r.snapshot()).toMatchObject({
        status: { text: "Reading mail", step: 1, elapsed: 3 },
        steps: [{ id: 1, text: "Reading mail", state: "done" }],
        notes: ["Checking unread"],
        answer: "3 unread",
        seq: r.sent.length,
    });
    // Nothing goes out after the turn ended.
    r.sink({ type: "answer", attempt: 1, text: "late" });
    vi.advanceTimersByTime(100);
    expect(r.sent.at(-1)).toMatchObject({ type: "turn_answer", text: "3 unread" });
});

it("logs live and first-word timings", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = relay();
    vi.advanceTimersByTime(100);
    r.sink({ type: "status", text: "Reading mail", step: 1, elapsedSec: 0 });
    vi.advanceTimersByTime(400);
    r.sink({ type: "answer", attempt: 0, text: "hi" });
    vi.advanceTimersByTime(300); // flushed at +40, the turn ends at +300
    r.sink({ type: "end" });
    r.finish(); // a second finish never logs twice
    expect(log.mock.calls.map((c) => c[0])).toEqual(["⏱️ [overlay] turn t1 live=100 firstWord=540 total=800"]);

    log.mockClear();
    const quiet = relay(); // no status, no answer, and a guest never logs
    quiet.sink({ type: "end" });
    const guest = relay(false);
    guest.sink({ type: "end" });
    expect(log.mock.calls.map((c) => c[0])).toEqual(["⏱️ [overlay] turn t1 live=- firstWord=- total=0"]);
    log.mockRestore();
});
