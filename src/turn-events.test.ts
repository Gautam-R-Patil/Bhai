// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusCoalescer, createTurnStream, type TurnEvent } from "./turn-events.js";

const status = (text: string) => ({ type: "status" as const, text, step: 1, elapsedSec: 0 });

describe("createStatusCoalescer", () => {
    afterEach(() => vi.useRealTimers());

    it("coalescer keeps the latest status", () => {
        vi.useFakeTimers();
        const seen: TurnEvent[] = [];
        const c = createStatusCoalescer((e) => seen.push(e), 3000);
        c.push(status("a"));
        vi.advanceTimersByTime(300);
        c.push(status("b"));
        vi.advanceTimersByTime(300);
        c.push(status("c"));
        c.flush();
        expect(seen.at(-1)).toEqual(status("c"));
        expect(seen.map((e) => (e as { text: string }).text)).not.toContain("b");
        c.stop();
    });

    it("emits the pending status once the gap has passed, without a flush", () => {
        vi.useFakeTimers();
        const seen: TurnEvent[] = [];
        const c = createStatusCoalescer((e) => seen.push(e), 3000);
        c.push(status("a"));
        c.push(status("b"));
        expect(seen).toEqual([status("a")]);
        vi.advanceTimersByTime(3000);
        expect(seen).toEqual([status("a"), status("b")]);
        c.flush(); // nothing pending: no repeat
        expect(seen).toHaveLength(2);
        c.stop();
    });

    it("stop drops the timer so nothing fires after the turn", () => {
        vi.useFakeTimers();
        const seen: TurnEvent[] = [];
        const c = createStatusCoalescer((e) => seen.push(e), 3000);
        c.push(status("a"));
        c.push(status("b"));
        c.stop();
        vi.advanceTimersByTime(10_000);
        expect(seen).toEqual([status("a")]);
    });
});

describe("createTurnStream", () => {
    it("void_tools (a refusal fallback) keeps the answer shown and ends the notes", () => {
        const seen: TurnEvent[] = [];
        const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: true });
        const onDelta = t.live();
        onDelta({ kind: "note", text: "Weighing it up. " });
        onDelta({ kind: "text", text: "Here is the plan " });
        onDelta({ kind: "void_tools" });
        onDelta({ kind: "text", text: "in detail." });
        expect(seen.some((e) => e.type === "answer_reset")).toBe(false);
        expect(seen.filter((e) => e.type === "note").length).toBeGreaterThan(0);
        expect(t.partial()).toBe("Here is the plan in detail.");
    });

    it("reset still withdraws the answer", () => {
        const seen: TurnEvent[] = [];
        const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: true });
        const onDelta = t.live();
        onDelta({ kind: "text", text: "Here is the plan " });
        onDelta({ kind: "reset" });
        expect(seen.filter((e) => e.type === "answer_reset")).toEqual([{ type: "answer_reset", attempt: 0 }]);
        expect(t.partial()).toBe("");
    });
});
