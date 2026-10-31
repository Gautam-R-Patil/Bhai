// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A quick turn shows no live line (no face, "Thinking…", seconds or bar) and leaves no "Worked for"
// line; a turn past 15 s shows its line with everything it has by then. The chat bar
// (src/overlay/overlay.html), the in-app Chats (panel.html) and the Chrome side panel
// (chrome-extension/sidepanel.js), each run from its own source in a page with fake timers.
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const between = (src, from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`marker missing: ${from} … ${to}`);
    return src.slice(a, b);
};

// A page whose timers, clock and frames are vitest's fake ones.
function page(body) {
    vi.useFakeTimers();
    const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: "outside-only", url: "http://localhost/" });
    const w = dom.window;
    Object.assign(w, {
        Date,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        requestAnimationFrame: (cb) => setTimeout(cb, 16),
        cancelAnimationFrame: (id) => clearTimeout(id),
    });
    return w;
}
const frame = () => vi.advanceTimersByTime(20);

afterEach(() => {
    vi.useRealTimers();
});

describe("chat bar (overlay.html)", () => {
    const html = read("src/overlay/overlay.html");
    const code =
        between(html, "      // One turn's live view as plain data", "      let activeTasks") +
        between(html, "      // ── Live turn (turn_* from the bot)", "      // ── Task Drawer ──");
    function bar() {
        const w = page(
            '<div id="reply-box"><div id="reply-text"></div></div><div class="icon" id="icon"></div><input id="input"><div id="progress"></div>',
        );
        w.eval(`
            const replyBox = document.getElementById('reply-box'), replyText = document.getElementById('reply-text');
            const icon = document.getElementById('icon'), input = document.getElementById('input'), progress = document.getElementById('progress');
            let waiting = false;
            const esc = (t) => String(t), renderStreamingMd = (t) => t;
            const setAgentBusy = () => {}, replyArriving = () => {};
            const setMood = (m) => { icon.dataset.mood = m; }, moodFromProgress = () => 'working';
            ${code}
            window.t = { liveStart, liveFinish, onTurnEvent, live: () => live };
        `);
        const replyText = w.document.getElementById("reply-text");
        const icon = w.document.getElementById("icon");
        const replyBox = w.document.getElementById("reply-box");
        // What the socket handler does for `thinking` with a turn id.
        const think = (turn) => {
            icon.classList.add("thinking");
            w.t.liveStart(turn, "");
        };
        return { w, t: w.t, replyText, icon, replyBox, think, view: () => replyText.querySelector(".turn-view") };
    }

    it("hides a quiet line in CSS", () => {
        expect(html).toMatch(/\.turn-view\.quiet, \.icon\.thinking\.quiet::after \{ display: none; \}/);
    });

    it("a quick turn: no live line, no ripple, no Worked for line; the answer streams at once", () => {
        const { t, replyText, icon, replyBox, think, view } = bar();
        think("t1");
        t.onTurnEvent({ type: "turn_status", turn: "t1", seq: 1, text: "Thinking", step: 0, elapsed: 0 });
        frame();
        expect(view().classList.contains("quiet")).toBe(true);
        expect(icon.classList.contains("quiet")).toBe(true);
        expect(icon.dataset.mood).toBeUndefined();
        expect(replyBox.classList.contains("visible")).toBe(false);
        t.onTurnEvent({ type: "turn_answer", turn: "t1", seq: 2, attempt: 0, text: "Hi" });
        frame();
        expect(replyBox.classList.contains("visible")).toBe(true);
        expect(replyText.querySelector(".turn-answer").textContent).toBe("Hi");
        vi.advanceTimersByTime(2000);
        expect(view().classList.contains("quiet")).toBe(true);
        t.liveFinish({ secs: 2, steps: 0 }).innerHTML = "Hi there";
        expect(view()).toBeNull();
        expect(icon.classList.contains("quiet")).toBe(false);
        expect(replyText.textContent).toBe("Hi there");
    });

    it("a retry in a quick turn takes the empty reply box down until its words come", () => {
        const { t, replyBox, think } = bar();
        think("t1");
        t.onTurnEvent({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Hi" });
        frame();
        expect(replyBox.classList.contains("visible")).toBe(true);
        t.onTurnEvent({ type: "turn_answer_reset", turn: "t1", seq: 2, attempt: 0 });
        frame();
        expect(replyBox.classList.contains("visible")).toBe(false);
        t.onTurnEvent({ type: "turn_answer", turn: "t1", seq: 3, attempt: 1, text: "Hello" });
        frame();
        expect(replyBox.classList.contains("visible")).toBe(true);
    });

    it("a retry keeps a reply box that was already up when the turn began", () => {
        const { t, replyBox, think } = bar();
        replyBox.classList.add("visible");
        think("t1");
        t.onTurnEvent({ type: "turn_answer", turn: "t1", seq: 1, attempt: 0, text: "Hi" });
        frame();
        t.onTurnEvent({ type: "turn_answer_reset", turn: "t1", seq: 2, attempt: 0 });
        frame();
        expect(replyBox.classList.contains("visible")).toBe(true);
    });

    it("a long turn shows its line at 15 s with its steps, then Worked for", () => {
        const { t, icon, think, view } = bar();
        think("t1");
        t.onTurnEvent({ type: "turn_status", turn: "t1", seq: 1, text: "Searching the web", step: 1, elapsed: 0 });
        t.onTurnEvent({ type: "turn_step", turn: "t1", seq: 2, id: 1, text: "Search", state: "running" });
        t.onTurnEvent({ type: "turn_note", turn: "t1", seq: 3, text: "Looking for flights." });
        frame();
        vi.advanceTimersByTime(14_000);
        expect(view().classList.contains("quiet")).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(view().classList.contains("quiet")).toBe(false);
        expect(icon.classList.contains("quiet")).toBe(false);
        expect(icon.dataset.mood).toBe("working");
        expect(view().querySelector(".turn-now").textContent).toBe("Searching the web");
        expect(view().querySelector(".turn-count").textContent).toBe("step 1 · 15s");
        expect(view().querySelectorAll(".turn-step")).toHaveLength(1);
        expect(view().querySelector(".turn-notes").textContent).toBe("Looking for flights.");
        t.liveFinish({ secs: 18, steps: 1 });
        expect(view().querySelector(".turn-now").textContent).toBe("Worked for 18s · 1 step");
    });

    it("a rejoin snapshot past 15 s shows the line at once; under 15 s, when it gets there", () => {
        const { t, view } = bar();
        const snap = (turn, elapsed) => ({
            type: "turn_snapshot",
            turn,
            seq: 5,
            status: { text: "Comparing flights", step: 3, elapsed },
            steps: [{ id: 1, text: "Search flights", state: "done" }],
            notes: [],
            answer: "",
        });
        t.onTurnEvent(snap("t1", 21));
        expect(view().classList.contains("quiet")).toBe(false);
        expect(view().querySelector(".turn-count").textContent).toBe("step 3 · 21s");
        t.liveFinish(null);
        t.onTurnEvent(snap("t2", 10));
        expect(view().classList.contains("quiet")).toBe(true);
        vi.advanceTimersByTime(5000);
        expect(view().classList.contains("quiet")).toBe(false);
    });
});

describe("in-app Chats (panel.html)", () => {
    const html = read("desktop/panel.html");
    const code = between(html, "        // ── In-app chat: talk to Bhai right here", "        function sendFromComposer");
    function chats() {
        const w = page(
            '<div id="tab-chats" class="active"></div><div id="chatsThread"></div><button id="chatsSendBtn"></button><textarea id="chatsInput"></textarea>',
        );
        const listeners = [];
        w.bhai = { chatSend: async () => ({ ok: true }), chatStop: () => {}, onChatEvent: (cb) => listeners.push(cb) };
        w.eval(`
            let chatsOpenId = null;
            const markOpenChat = () => {}, loadChats = () => {}, loadRecentChats = () => {}, showToast = () => {};
            const chatHtml = (t) => t;
            function chatBubble(role, text) { const d = document.createElement('div'); d.className = 'chats-msg ' + role; d.textContent = text; return d; }
            ${code}
            window.t = { sendChat };
        `);
        const thread = w.document.getElementById("chatsThread");
        const emit = (msg) => listeners.forEach((cb) => cb({ chat: "c1", msg }));
        return { t: w.t, thread, emit, view: () => thread.querySelector(".chats-turn") };
    }

    it("hides a quiet line in CSS", () => {
        expect(read("desktop/styles.css")).toContain(".chats-turn.quiet > :not(.turn-answer) { display: none; }");
    });

    it("a quick turn: no live line and no Worked for line", () => {
        const { t, thread, emit, view } = chats();
        t.sendChat("hello how re you", "c1");
        emit({ type: "thinking", turn: "t1" });
        emit({ type: "turn_status", turn: "t1", seq: 1, text: "Thinking", step: 0, elapsed: 0 });
        emit({ type: "turn_answer", turn: "t1", seq: 2, attempt: 0, text: "Hey" });
        frame();
        expect(view().classList.contains("quiet")).toBe(true);
        expect(view().querySelector(".turn-answer").hidden).toBe(false); // the answer streams at once
        vi.advanceTimersByTime(2000);
        expect(view().classList.contains("quiet")).toBe(true);
        emit({ type: "response", turn: "t1", text: "Hey! Doing great.", worked: { secs: 2, steps: 0 } });
        expect(view()).toBeNull();
        expect(thread.textContent).not.toMatch(/Worked for/);
        expect(thread.lastElementChild.textContent).toBe("Hey! Doing great.");
    });

    it("a long turn shows its line at 15 s with its steps, then Worked for", () => {
        const { t, emit, view } = chats();
        t.sendChat("book a flight", "c1");
        emit({ type: "thinking", turn: "t1" });
        emit({ type: "turn_step", turn: "t1", seq: 1, id: 1, text: "Search flights", state: "running" });
        frame();
        vi.advanceTimersByTime(14_000);
        expect(view().classList.contains("quiet")).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(view().classList.contains("quiet")).toBe(false);
        expect(view().querySelectorAll(".turn-step")).toHaveLength(1);
        expect(view().querySelector(".turn-count").textContent).toBe("15s");
        emit({ type: "response", turn: "t1", text: "Booked.", worked: { secs: 18, steps: 1 } });
        expect(view().querySelector(".turn-now").textContent).toBe("Worked for 18s · 1 step");
    });

    it("a silent reply (a file reply that cleaned down to nothing) ends the turn", async () => {
        const { t, emit, view } = chats();
        t.sendChat("what's in this?", "c1");
        emit({ type: "thinking", turn: "t1" });
        emit({ type: "silent" });
        expect(view()).toBeNull();
        expect(await t.sendChat("hello?", "c1")).toBe(true);
    });
});

describe("Chrome side panel (sidepanel.js)", () => {
    const src = read("chrome-extension/sidepanel.js");
    const code = between(src, "let lastProgress = 0;", "// ── Status, tab, selection");
    const view0 = (turn) => ({ turn, seq: 0, status: null, steps: [], notes: [], answer: "", attempt: 0, open: false });
    function side() {
        const w = page('<div id="thread"></div><button id="btnSend"></button>');
        w.eval(`
            const $ = (id) => document.getElementById(id);
            const thread = $('thread'), sendBtn = $('btnSend');
            let busy = false;
            const updateSendState = () => {}, renderMarkdown = (t) => t, icon = () => document.createElement('i');
            const chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
            ${code}
            window.t = { setBusy, onTurnUpdate, liveFinish };
        `);
        const thread = w.document.getElementById("thread");
        return { w, t: w.t, thread, view: () => thread.querySelector(".turn") };
    }

    it("hides a quiet line in CSS", () => {
        expect(read("chrome-extension/sidepanel.html")).toContain(".turn.quiet > :not(.turn-answer) { display: none; }");
    });

    it("a quick turn: no working row, no live line, no Worked for line", () => {
        const { w, t, thread, view } = side();
        t.setBusy(true, "Thinking…"); // sent
        vi.advanceTimersByTime(300);
        expect(w.document.getElementById("workingRow")).toBeNull();
        t.onTurnUpdate({ state: view0("t1"), start: Date.now(), text: "" });
        t.onTurnUpdate({ state: { ...view0("t1"), seq: 1, answer: "Hey" }, start: Date.now() });
        frame();
        expect(view().classList.contains("quiet")).toBe(true);
        expect(view().querySelector(".turn-answer").textContent).toBe("Hey");
        vi.advanceTimersByTime(2000);
        t.liveFinish({ secs: 2, steps: 0 });
        expect(view()).toBeNull();
        expect(thread.textContent).not.toMatch(/Worked for|Thinking/);
    });

    it("a long turn shows its line at 15 s with its steps, then Worked for", () => {
        const { t, view } = side();
        t.setBusy(true, "Thinking…");
        const start = Date.now();
        const state = { ...view0("t1"), seq: 1, steps: [{ id: 1, text: "Search", state: "running" }] };
        t.onTurnUpdate({ state: view0("t1"), start, text: "" });
        t.onTurnUpdate({ state, start });
        frame();
        vi.advanceTimersByTime(14_000);
        expect(view().classList.contains("quiet")).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(view().classList.contains("quiet")).toBe(false);
        expect(view().querySelectorAll(".turn-step")).toHaveLength(1);
        t.onTurnUpdate({ state, start, done: { secs: 18, steps: 1 } });
        expect(view().querySelector(".turn-now").textContent).toBe("Worked for 18s · 1 step");
    });

    it("reopened mid-turn past 15 s shows the line at once", () => {
        const { t, view } = side();
        t.onTurnUpdate({ state: view0("t1"), start: Date.now() - 21_000, text: "" });
        expect(view().classList.contains("quiet")).toBe(false);
        expect(view().querySelector(".turn-count").textContent).toBe("21s");
    });

    it("an old bot's working row shows only after 15 s", () => {
        const { w, t } = side();
        t.setBusy(true, "Thinking…");
        vi.advanceTimersByTime(14_000);
        expect(w.document.getElementById("workingRow")).toBeNull();
        t.setBusy(true, "Reading the page…");
        vi.advanceTimersByTime(1000);
        expect(w.document.getElementById("workingRow").textContent).toBe("Reading the page…");
        t.setBusy(false);
        expect(w.document.getElementById("workingRow")).toBeNull();
    });
});
