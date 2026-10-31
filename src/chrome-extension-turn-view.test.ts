// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The Chrome side panel's live turn view (chrome-extension/turn-view.js): the same contract and
// cases as the overlay's (src/overlay/turn-view.test.ts), plus the extension's own one.
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// A variable specifier: the extension's plain JS stays outside the TS project.
const modUrl = new URL("../chrome-extension/turn-view.js", import.meta.url).href;
const { turnView, turnRoute, isAwaiting, restorePanelTurn, restoredSilent, AWAIT_TURN_MS, RESTORED_SILENT_MS } =
    await import(modUrl);
// The side panel's own render helpers (a classic script), pulled out the way the overlay's are.
const sidepanel = fs.readFileSync(new URL("../chrome-extension/sidepanel.js", import.meta.url), "utf8");
const panelFn = (name: string) =>
    sidepanel.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
const panel = vm.createContext({});
vm.runInContext(`${panelFn("turnHasDetail")}${panelFn("workedLine")}`, panel);

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
    JSON.parse(JSON.stringify(msgs.reduce((s, m) => turnView(s, m), start)));

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
        expect(view([{ type: "turn_answer", turn: "t", seq: 10, attempt: 2, text: " IndiGo" }], s).answer).toBe(
            "Cheapest is IndiGo",
        );
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
        expect(turnView(s, { type: "progress", text: "hi" })).toBe(s);
    });

    it("a background progress message doesn't start a turn", () => {
        const research = { type: "progress", text: "Research: reading 12 sources", background: true };
        expect(turnView(null, research)).toBeNull();
        const s = view([{ type: "turn_status", turn: "t", seq: 1, text: "Searching", step: 1, elapsed: 2 }]);
        expect(turnView(s, research)).toBe(s);
    });
});

describe("turnRoute", () => {
    const route = (liveTurn: string | null, running: boolean, msg: object) =>
        turnRoute(liveTurn, running, msg) as string;

    it("a stray event of another turn can't take over a running view; a snapshot can", () => {
        expect(route("a", true, { type: "turn_answer", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "turn_step", turn: "b" })).toBe("ignore");
        expect(route("a", true, { type: "turn_snapshot", turn: "b" })).toBe("start");
        expect(route("a", true, { type: "turn_note", turn: "a" })).toBe("apply");
        expect(route("a", false, { type: "turn_status", turn: "b" })).toBe("start");
        expect(route(null, false, { type: "turn_status", turn: "b" })).toBe("start");
        expect(route("a", false, { type: "turn_answer", turn: "a" })).toBe("apply");
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

describe("the Notes/Steps panel", () => {
    it("says there's nothing yet instead of an empty box", () => {
        expect(sidepanel).toContain('<div class="turn-empty">Nothing to show yet.</div>');
        expect(panel.turnHasDetail({ steps: [], notes: [] })).toBe(false);
        expect(panel.turnHasDetail({ steps: [], notes: [" \n"] })).toBe(false);
        expect(panel.turnHasDetail({ steps: [], notes: ["Checking"] })).toBe(true);
        expect(panel.turnHasDetail({ steps: [{ id: 1, text: "Search", state: "running" }], notes: [] })).toBe(true);
    });
});

describe("the Worked for line", () => {
    it("stays after every turn that showed a live line, a toggle only when there's something to open", () => {
        const s = (steps: number, notes: string[] = []) => ({
            steps: Array.from({ length: steps }, (_, i) => ({ id: i, text: "x", state: "done" })),
            notes,
        });
        // A plain or stopped answer: the line stays, but there's nothing to open.
        expect(panel.workedLine(s(0), { secs: 4, steps: 0 }, 0)).toEqual({ text: "Worked for 4s", toggle: false });
        expect(panel.workedLine(s(0, ["Thinking it over"]), { secs: 4, steps: 0 }, 0)).toEqual({
            text: "Worked for 4s",
            toggle: true,
        });
        expect(panel.workedLine(s(1), { secs: 3, steps: 1 }, 0)).toEqual({
            text: "Worked for 3s · 1 step",
            toggle: true,
        });
        expect(panel.workedLine(s(2), { secs: 9, steps: 2 }, 0)).toEqual({
            text: "Worked for 9s · 2 steps",
            toggle: true,
        });
        // No count from the bot: timed from the turn's start.
        expect(panel.workedLine(s(0), null, Date.now() - 5000).text).toBe("Worked for 5s");
    });
});

describe("the panel's own turn across a worker restart", () => {
    const now = 1_000_000;

    it("a send waits for its thinking only so long", () => {
        expect(AWAIT_TURN_MS).toBe(60_000);
        expect(isAwaiting(0, now)).toBe(false);
        expect(isAwaiting(now - 5_000, now)).toBe(true);
        expect(isAwaiting(now - 61_000, now)).toBe(false);
    });

    it("restores the running turn as a fresh view, and a fresh wait", () => {
        expect(restorePanelTurn({ awaitingSince: 0, ownTurn: "t1", draftStart: now - 9_000 }, now)).toEqual({
            awaitingSince: 0,
            ownTurn: "t1",
            draftStart: now - 9_000,
            restoredAt: now,
            draft: { turn: "t1", seq: 0, status: null, steps: [], notes: [], answer: "", attempt: 0, open: false },
        });
        expect(restorePanelTurn({ awaitingSince: now - 5_000, ownTurn: null, draftStart: 0 }, now)).toMatchObject({
            awaitingSince: now - 5_000,
            ownTurn: null,
            draft: null,
        });
    });

    it("drops a stale wait and anything malformed", () => {
        const empty = { awaitingSince: 0, ownTurn: null, draft: null, draftStart: 0, restoredAt: 0 };
        expect(restorePanelTurn({ awaitingSince: now - 61_000, ownTurn: null }, now)).toEqual(empty);
        for (const bad of [undefined, null, "x", { ownTurn: 5, awaitingSince: "1" }])
            expect(restorePanelTurn(bad, now)).toEqual(empty);
    });

    // The server sends a turn's events only to the socket that started it, so a view restored
    // after a worker restart may never hear from its turn again: it must not stay busy for good.
    it("a restored view that hears nothing from its turn is dropped after a while", () => {
        expect(RESTORED_SILENT_MS).toBe(60_000);
        expect(restoredSilent(0, now)).toBe(false); // not restored, or its turn spoke since
        expect(restoredSilent(now - 5_000, now)).toBe(false);
        expect(restoredSilent(now - 61_000, now)).toBe(true);
    });

    it("a second restart keeps the first restore's clock", () => {
        const saved = { awaitingSince: 0, ownTurn: "t1", draftStart: now - 90_000, restoredAt: now - 50_000 };
        expect(restorePanelTurn(saved, now).restoredAt).toBe(now - 50_000);
        expect(restorePanelTurn({ ...saved, restoredAt: 0 }, now).restoredAt).toBe(now);
    });
});

describe("side panel markdown links", () => {
    const md = vm.createContext({});
    vm.runInContext(`${panelFn("escapeHtml")}${panelFn("inline")}`, md);
    const a = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

    it("a link whose URL holds another URL stays one link", () => {
        const url = "https://web.archive.org/web/2020/https://example.com/page";
        expect(md.inline(`[snapshot](${url})`)).toBe(a(url, "snapshot"));
    });

    it("bare URLs still autolink", () => {
        expect(md.inline("see https://example.com/x.")).toBe(`see ${a("https://example.com/x", "https://example.com/x")}.`);
    });
});
