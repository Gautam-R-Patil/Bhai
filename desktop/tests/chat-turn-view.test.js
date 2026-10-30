// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The in-app chat's live turn view (desktop/panel.html): the same turnView/turnRoute contract as
// the overlay's and the side panel's, pulled out of the page's inline script.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(path.join(__dirname, "..", "panel.html"), "utf8");
const fn = (name) => html.match(new RegExp(` {8}function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {8}\\}\\n`))?.[0] ?? "";
const ctx = vm.createContext({});
vm.runInContext(`${fn("turnView")}${fn("turnRoute")}`, ctx);

const view = (msgs, start = null) => JSON.parse(JSON.stringify(msgs.reduce((s, m) => ctx.turnView(s, m), start)));

describe("turnView", () => {
    it("answer deltas append, reset clears", () => {
        const a = (seq, attempt, text) => ({ type: "turn_answer", turn: "t", seq, attempt, text });
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
        const s = view([snap, { type: "turn_answer", turn: "t", seq: 8, attempt: 0, text: " stale" }], { ...before, open: true });
        expect(s).toEqual({ ...before, seq: 9, status: snap.status, steps: snap.steps, notes: snap.notes, answer: "Cheapest is", open: true, attempt: null });
        expect(view([{ type: "turn_answer", turn: "t", seq: 10, attempt: 2, text: " IndiGo" }], s).answer).toBe("Cheapest is IndiGo");
    });

    it("a step done after running keeps its order", () => {
        const step = (seq, id, state) => ({ type: "turn_step", turn: "t", seq, id, text: `step ${id}`, state });
        const s = view([step(1, 1, "running"), step(2, 1, "done"), step(3, 2, "running"), step(4, 2, "failed"), step(5, 3, "running")]);
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
        expect(ctx.turnView(s, { type: "progress", text: "hi", background: true })).toBe(s);
    });
});

describe("turnRoute", () => {
    it("only this chat's own turn reaches the view; another turn's reply is ignored", () => {
        const route = (liveTurn, running, msg) => ctx.turnRoute(liveTurn, running, msg);
        expect(route("a", true, { type: "turn_answer", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "turn_note", turn: "a" })).toBe("apply");
        expect(route("a", true, { type: "response", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "response", turn: "a" })).toBe("finish");
        expect(route("a", true, { type: "response" })).toBe("finish");
        expect(route("a", true, { type: "error" })).toBe("finish");
        expect(route(null, false, { type: "response" })).toBe("plain");
    });
});
