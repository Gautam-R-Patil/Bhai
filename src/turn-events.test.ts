// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

    it("an ask shows at once and the next model call's reply streams on under it", () => {
        const seen: TurnEvent[] = [];
        const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: true });
        t.ask("Enter the code the shop sent to your phone");
        const onDelta = t.live();
        onDelta({ kind: "text", text: "Send me the code." });
        expect(seen.some((e) => e.type === "answer_reset")).toBe(false);
        const answers = seen.flatMap((e) => (e.type === "answer" ? [e] : []));
        expect(answers.map((e) => e.attempt)).toEqual([0, 0]);
        expect(answers.map((e) => e.text).join("")).toBe(
            "Enter the code the shop sent to your phone\n\nSend me the code.",
        );
    });

    it("a finished step moves the live line on to its results; the next step's status still wins", () => {
        vi.useFakeTimers();
        try {
            const seen: TurnEvent[] = [];
            const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: false });
            const statuses = () => seen.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
            t.step("Searching the web");
            t.status("Searching the web", 1, 2);
            vi.advanceTimersByTime(4000);
            t.stepEnd("done", 9); // the caller's clock, not the last status's 2s plus the 4s waited
            expect(seen.at(-1)).toEqual({ type: "status", text: "Reading what I found", step: 1, elapsedSec: 9 });
            t.step("Opening the page");
            t.stepEnd("failed", 6);
            t.status("Opening the page", 2, 6); // inside the 3s gap: waits, but still goes out
            vi.advanceTimersByTime(3000);
            expect(statuses()).toEqual([
                "Searching the web",
                "Reading what I found",
                "Seeing what went wrong",
                "Opening the page",
            ]);
            t.step("Trying another way");
            t.status("Trying another way", 3, 10);
            vi.advanceTimersByTime(3000);
            t.stepEnd("failed", 13);
            expect(statuses().at(-1)).toBe("Seeing what went wrong");
            // A step closed by the next one or by the turn's end leaves no extra status.
            const before = statuses().length;
            t.step("Last look");
            t.end();
            expect(statuses().length).toBe(before);
        } finally {
            vi.useRealTimers();
        }
    });

    it("fast steps: each step's own status reaches the live line at once, in order", () => {
        vi.useFakeTimers();
        try {
            const seen: TurnEvent[] = [];
            const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: false });
            const names = ["Opening Spotify", "Clicking Play", "Taking a screenshot", "Checking volume"];
            names.forEach((name, i) => {
                t.step(name);
                t.status(name, i + 1, i * 2); // as agent.ts starts a step; then 1s tool, 1s model call
                vi.advanceTimersByTime(1000);
                t.stepEnd("done", i * 2 + 1);
                vi.advanceTimersByTime(1000);
            });
            t.end();
            const own = seen
                .filter((e) => e.type === "status" && e.text !== "Reading what I found")
                .map((e) => `${(e as { step: number }).step}:${(e as { text: string }).text}`);
            expect(own).toEqual(names.map((n, i) => `${i + 1}:${n}`));
        } finally {
            vi.useRealTimers();
        }
    });

    it("a finished step's status goes out at once with the real elapsed time, and nothing older follows it", () => {
        vi.useFakeTimers();
        try {
            const seen: TurnEvent[] = [];
            const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: false });
            t.step("Searching the web");
            t.status("Searching the web", 1, 5); // goes out: the throttle window starts here
            vi.advanceTimersByTime(500);
            t.status("Searching: bhai", 1, 5); // inside the window: waits
            vi.advanceTimersByTime(1500);
            t.stepEnd("done", 7);
            // Not up to 3s late, and not the previous status's clock.
            expect(seen.at(-1)).toEqual({ type: "status", text: "Reading what I found", step: 1, elapsedSec: 7 });
            vi.advanceTimersByTime(10_000);
            // The older waiting status was replaced, so it never lands on top.
            expect(seen.filter((e) => e.type === "status").at(-1)).toMatchObject({ text: "Reading what I found" });
            // A newer status inside the new window still goes out (late, never dropped).
            t.step("Opening the page");
            t.status("Opening the page", 2, 17);
            vi.advanceTimersByTime(3000);
            expect(seen.filter((e) => e.type === "status").at(-1)).toMatchObject({ text: "Opening the page" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("status and step text lose a leading emoji once, at the source", () => {
        const seen: TurnEvent[] = [];
        const t = createTurnStream((e) => seen.push(e), { channel: "overlay", notes: false });
        t.step("🔍 Searching: bhai news");
        t.status("🔍 Searching: bhai news", 1, 0);
        t.step("  ✂️ Pasting 3 items");
        t.step("Step 2 of 3"); // plain text and leading digits stay as they are
        expect(
            seen.filter((e) => e.type === "step" && e.state === "running").map((e) => (e as { text: string }).text),
        ).toEqual(["Searching: bhai news", "Pasting 3 items", "Step 2 of 3"]);
        expect(seen.find((e) => e.type === "status")).toMatchObject({ text: "Searching: bhai news" });
        t.end();
    });
});
