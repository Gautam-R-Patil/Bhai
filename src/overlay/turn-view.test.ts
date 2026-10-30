// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The chat bar's live turn view (turn_* messages) and streaming markdown, pulled out of the
// page's inline script the same way inline-scripts.test.ts does.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(path.join(__dirname, "overlay.html"), "utf8");
const fn = (name: string) =>
    html.match(new RegExp(` {6}function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {6}\\}\\n`))?.[0] ?? "";
const esc = html.match(/ {6}function esc\(t\) .*\n/)?.[0] ?? "";
const ctx = vm.createContext({});
vm.runInContext(
    `${esc}${fn("renderMd")}${fn("renderStreamingMd")}${fn("turnView")}${fn("turnRoute")}${fn("turnHasDetail")}${fn("workedLine")}`,
    ctx,
);

type State = {
    turn: string;
    seq: number;
    status: unknown;
    steps: { id: number; text: string; state: string }[];
    notes: string[];
    answer: string;
    open: boolean;
};
const view = (msgs: object[], start: State | null = null): State =>
    JSON.parse(JSON.stringify(msgs.reduce((s, m) => ctx.turnView(s, m), start)));

describe("turnView", () => {
    it("answer deltas append, reset clears", () => {
        const a = (seq: number, attempt: number, text: string) => ({
            type: "turn_answer",
            turn: "t",
            seq,
            attempt,
            text,
        });
        expect(view([a(1, 0, "Hel"), a(2, 0, "lo")]).answer).toBe("Hello");
        expect(view([a(1, 0, "Hel"), a(1, 0, "Hel"), a(2, 0, "lo")]).answer).toBe("Hello"); // a repeated seq is dropped
        const reset = { type: "turn_answer_reset", turn: "t", seq: 3, attempt: 0 };
        expect(view([a(1, 0, "Hel"), a(2, 0, "lo"), reset]).answer).toBe("");
        expect(view([a(1, 0, "Hel"), reset, a(4, 1, "Hi"), a(5, 0, "late")]).answer).toBe("Hi");
    });

    it("snapshot replaces state", () => {
        const before = view([
            { type: "turn_note", turn: "t", seq: 1, text: "old" },
            { type: "turn_answer", turn: "t", seq: 2, attempt: 0, text: "old answer" },
        ]);
        const snap = {
            type: "turn_snapshot",
            turn: "t",
            seq: 9,
            status: { text: "Comparing flights", step: 3, elapsed: 21 },
            steps: [{ id: 1, text: "Search flights", state: "done" }],
            notes: ["Price matters most.\n"],
            answer: "Cheapest is",
        };
        const s = view([snap, { type: "turn_answer", turn: "t", seq: 8, attempt: 0, text: " stale" }], {
            ...before,
            open: true,
        });
        expect(s).toEqual({
            ...before,
            seq: 9,
            status: snap.status,
            steps: snap.steps,
            notes: snap.notes,
            answer: "Cheapest is",
            open: true,
            attempt: null,
        });
        // The answer continues whatever attempt it is on: the snapshot doesn't say.
        expect(view([{ type: "turn_answer", turn: "t", seq: 10, attempt: 2, text: " IndiGo" }], s).answer).toBe(
            "Cheapest is IndiGo",
        );
        // A fresh page joining mid-turn starts from the snapshot.
        expect(view([snap]).answer).toBe("Cheapest is");
    });

    it("a step done after running keeps its order", () => {
        const step = (seq: number, id: number, state: string) => ({
            type: "turn_step",
            turn: "t",
            seq,
            id,
            text: `step ${id}`,
            state,
        });
        const s = view([
            step(1, 1, "running"),
            step(2, 1, "done"),
            step(3, 2, "running"),
            step(4, 2, "failed"),
            step(5, 3, "running"),
        ]);
        expect(s.steps).toEqual([
            { id: 1, text: "step 1", state: "done" },
            { id: 2, text: "step 2", state: "failed" },
            { id: 3, text: "step 3", state: "running" },
        ]);
    });

    it("another turn starts fresh; other messages change nothing", () => {
        const s = view([{ type: "turn_note", turn: "a", seq: 5, text: "x" }]);
        const t = view([{ type: "turn_note", turn: "b", seq: 1, text: "y" }], { ...s, open: true });
        expect(t).toMatchObject({ turn: "b", seq: 1, notes: ["y"], answer: "", steps: [], open: true });
        expect(ctx.turnView(s, { type: "progress", text: "hi" })).toBe(s);
    });
});

describe("turnRoute", () => {
    const route = (liveTurn: string | null, running: boolean, msg: object) =>
        ctx.turnRoute(liveTurn, running, msg) as string;

    it("a stray event of another turn can't take over a running view; a snapshot can", () => {
        expect(route("a", true, { type: "turn_answer", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "turn_step", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "turn_snapshot", turn: "b" })).toBe("start");
        expect(route("a", true, { type: "turn_note", turn: "a" })).toBe("apply");
        expect(route("a", false, { type: "turn_status", turn: "b" })).toBe("start"); // the last one finished
        expect(route(null, false, { type: "turn_status", turn: "b" })).toBe("start");
        expect(route("a", false, { type: "turn_answer", turn: "a" })).toBe("apply"); // the view drops it: done
    });

    it("another turn's response is ignored while a view runs", () => {
        expect(route("a", true, { type: "response", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "response", turn: "a" })).toBe("finish");
        expect(route("a", true, { type: "response" })).toBe("finish");
        expect(route("a", true, { type: "error" })).toBe("finish");
        expect(route("a", false, { type: "response", turn: "b" })).toBe("plain");
        expect(route(null, false, { type: "response" })).toBe("plain");
    });
});

describe("renderStreamingMd", () => {
    it("an unclosed fence renders as a code block", () => {
        const out = ctx.renderStreamingMd("x\n```js\nconst a") as string;
        expect(out).toContain("<pre");
        expect(out).toContain(">const a</code>");
        expect(ctx.renderStreamingMd("**a**") as string).toBe(ctx.renderMd("**a**") as string);
    });
});

describe("the Notes/Steps panel", () => {
    it("says there's nothing yet instead of an empty box", () => {
        expect(html).toContain('<div class="turn-empty">Nothing to show yet.</div>');
        expect(ctx.turnHasDetail({ steps: [], notes: [] })).toBe(false);
        expect(ctx.turnHasDetail({ steps: [], notes: [" \n"] })).toBe(false);
        expect(ctx.turnHasDetail({ steps: [], notes: ["Checking"] })).toBe(true);
        expect(ctx.turnHasDetail({ steps: [{ id: 1, text: "Search", state: "running" }], notes: [] })).toBe(true);
    });
});

describe("the Worked for line", () => {
    it("stays after every turn that showed a live line, a toggle only when there's something to open", () => {
        const s = (steps: number, notes: string[] = []) => ({
            steps: Array.from({ length: steps }, (_, i) => ({ id: i, text: "x", state: "done" })),
            notes,
        });
        // A plain or stopped answer: the line stays, but there's nothing to open.
        expect(ctx.workedLine(s(0), { secs: 4, steps: 0 }, 0)).toEqual({ text: "Worked for 4s", toggle: false });
        expect(ctx.workedLine(s(0, ["Thinking it over"]), { secs: 4, steps: 0 }, 0)).toEqual({
            text: "Worked for 4s",
            toggle: true,
        });
        expect(ctx.workedLine(s(1), { secs: 3, steps: 1 }, 0)).toEqual({
            text: "Worked for 3s · 1 step",
            toggle: true,
        });
        expect(ctx.workedLine(s(2), { secs: 9, steps: 2 }, 0)).toEqual({
            text: "Worked for 9s · 2 steps",
            toggle: true,
        });
        // No count from the bot: timed from the turn's start.
        expect(ctx.workedLine(s(0), null, Date.now() - 5000).text).toBe("Worked for 5s");
    });
});
