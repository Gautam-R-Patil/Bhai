// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createAgentCursor, parseCursorLine, pickDisplay, toLocal, glideMs, HIDE_SETTLE_MS } from "../agent-cursor.js";

// Two side-by-side displays: a Retina laptop (points) and an external on the left, higher up.
const LAPTOP = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 };
const EXTERNAL = { id: 2, bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 };

describe("pure helpers", () => {
    it("parses only well-formed cursor lines", () => {
        expect(parseCursorLine('##BHAI_CURSOR##{"t":"move","x":1,"y":2}')).toEqual({ t: "move", x: 1, y: 2 });
        expect(parseCursorLine("##BHAI_CURSOR##{oops")).toBeNull();
        expect(parseCursorLine('##BHAI_BUDDY##{"type":"thinking"}')).toBeNull();
        expect(parseCursorLine('##BHAI_CURSOR##{"x":1}')).toBeNull();
    });

    it("maps global points to the right display, in that display's local DIP", () => {
        expect(pickDisplay({ x: 100, y: 100 }, [LAPTOP, EXTERNAL])).toBe(LAPTOP);
        const ext = pickDisplay({ x: -10, y: -150 }, [LAPTOP, EXTERNAL]);
        expect(ext).toBe(EXTERNAL);
        expect(toLocal({ x: -10, y: -150 }, ext)).toEqual({ x: 1910, y: 50 });
        // Off every screen (e.g. a clamped edge click): nearest display wins.
        expect(pickDisplay({ x: 1600, y: 10 }, [LAPTOP, EXTERNAL])).toBe(LAPTOP);
        expect(pickDisplay({ x: 0, y: 0 }, [])).toBeNull();
    });

    it("glides quickly and stays under the bot's 300ms wait", () => {
        expect(glideMs(null, { x: 5, y: 5 })).toBe(0);
        expect(glideMs({ x: 5, y: 5 }, { x: 6, y: 5 })).toBe(0);
        expect(glideMs({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe(135);
        expect(glideMs({ x: 0, y: 0 }, { x: 5000, y: 5000 })).toBe(280);
    });
});

function fakeElectron(displays = [LAPTOP, EXTERNAL]) {
    const wins = [];
    class BrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.calls = [];
            this.scripts = [];
            this.destroyed = false;
            this.listeners = {};
            this.webContents = {
                on: (ev, fn) => (this.listeners[ev] = fn),
                executeJavaScript: (js) => {
                    this.scripts.push(JSON.parse(js.slice("window.cursor(".length, -1)));
                    return Promise.resolve();
                },
            };
            wins.push(this);
        }
        loadFile() { this.listeners["did-finish-load"]?.(); }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
    }
    for (const m of ["setIgnoreMouseEvents", "setContentProtection", "setAlwaysOnTop", "setVisibleOnAllWorkspaces", "setOpacity", "showInactive", "hide", "setBounds"]) {
        BrowserWindow.prototype[m] = function (...a) { this.calls.push([m, ...a]); };
    }
    const on = {};
    const screen = { getAllDisplays: () => displays, getCursorScreenPoint: () => ({ x: 10, y: 10 }), on: (ev, fn) => (on[ev] = fn), emit: (ev) => on[ev]?.() };
    return { BrowserWindow, screen, wins };
}

describe("overlay controller", () => {
    let fx, cursor, acks;
    beforeEach(() => {
        vi.useFakeTimers();
        fx = fakeElectron();
        cursor = createAgentCursor({ BrowserWindow: fx.BrowserWindow, screen: fx.screen, htmlPath: "x.html", platform: "darwin" });
        cursor.init();
        acks = [];
    });
    const send = (evt) => cursor.handle(evt, (id) => acks.push(id));

    it("makes one click-through, focus-less, on-top window per display at init, never mid-action", () => {
        expect(fx.wins).toHaveLength(2);
        expect(fx.wins[0].calls.some(([m]) => m === "showInactive")).toBe(false); // hidden until a session
        send({ t: "session", on: true });
        expect(fx.wins).toHaveLength(2);
        const [w] = fx.wins;
        expect(w.opts).toMatchObject({ x: 0, y: 0, width: 1512, height: 982, transparent: true, frame: false, focusable: false, skipTaskbar: true, hasShadow: false });
        expect(w.calls).toContainEqual(["setIgnoreMouseEvents", true]);
        expect(w.calls).toContainEqual(["setAlwaysOnTop", true, "screen-saver"]);
        expect(w.calls).toContainEqual(["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }]);
        expect(w.calls).toContainEqual(["showInactive"]);
        expect(w.calls.some(([m]) => m === "show" || m === "focus")).toBe(false);
    });

    it("glides from the real pointer, ripples on click, acks after the glide", () => {
        send({ t: "click", x: 110, y: 10, button: "left", count: 1, id: 7 });
        const laptop = fx.wins[0];
        expect(laptop.scripts.at(-2)).toEqual({ t: "move", x: 10, y: 10, ms: 0 }); // start at the pointer
        expect(laptop.scripts.at(-1)).toEqual({ t: "click", button: "left", count: 1, x: 110, y: 10, ms: 135 });
        expect(acks).toEqual([]);
        vi.advanceTimersByTime(135);
        expect(acks).toEqual([7]);
    });

    it("hops displays without a cross-screen glide", () => {
        send({ t: "move", x: 500, y: 500, id: 1 });
        send({ t: "move", x: -100, y: 0, id: 2 });
        const [laptop, ext] = fx.wins;
        expect(laptop.scripts.at(-1)).toEqual({ t: "leave" });
        expect(ext.scripts.at(-1)).toEqual({ t: "move", x: 1820, y: 200, ms: 0 });
        expect(acks).toContain(2);
    });

    it("converts Windows physical pixels to DIP", () => {
        fx.screen.screenToDipPoint = (p) => ({ x: p.x / 1.5, y: p.y / 1.5 });
        cursor = createAgentCursor({ BrowserWindow: fx.BrowserWindow, screen: fx.screen, htmlPath: "x.html", platform: "win32" });
        cursor.init();
        send({ t: "move", x: 300, y: 150 });
        expect(fx.wins.at(-2).scripts.at(-1)).toMatchObject({ x: 200, y: 100 });
    });

    it("hides every window before acking a capture, shows after", () => {
        send({ t: "move", x: 50, y: 50 });
        send({ t: "hide", id: 9 });
        for (const w of fx.wins) expect(w.calls.at(-1)).toEqual(["setOpacity", 0]);
        expect(acks).not.toContain(9);
        vi.advanceTimersByTime(HIDE_SETTLE_MS);
        expect(acks).toContain(9);
        send({ t: "show" });
        for (const w of fx.wins) expect(w.calls.at(-1)).toEqual(["setOpacity", 1]);
    });

    it("acks a hide at once when nothing is on screen", () => {
        send({ t: "hide", id: 3 });
        expect(acks).toEqual([3]);
    });

    it("still hides during the fade-out, and a click mid-capture stays hidden", () => {
        send({ t: "move", x: 50, y: 50 });
        send({ t: "session", on: false });
        send({ t: "hide", id: 4 });
        expect(acks).not.toContain(4); // windows are still fading: wait for the hide
        send({ t: "click", x: 60, y: 60 }); // another flow restarts the session mid-capture
        for (const w of fx.wins) expect(w.calls.filter(([m]) => m === "setOpacity").at(-1)).toEqual(["setOpacity", 0]);
        send({ t: "show" });
        for (const w of fx.wins) expect(w.calls.at(-1)).toEqual(["setOpacity", 1]);
    });

    it("follows display changes, showing a new screen mid-session", () => {
        send({ t: "move", x: 50, y: 50 });
        const third = { id: 3, bounds: { x: 1512, y: 0, width: 1920, height: 1080 } };
        fx.screen.getAllDisplays = () => [LAPTOP, EXTERNAL, third];
        fx.screen.emit("display-added");
        expect(fx.wins).toHaveLength(3);
        expect(fx.wins[2].calls).toContainEqual(["showInactive"]);
        expect(fx.wins[2].scripts).toContainEqual({ t: "session", on: true });
        fx.screen.getAllDisplays = () => [LAPTOP];
        fx.screen.emit("display-removed");
        expect(fx.wins[1].destroyed && fx.wins[2].destroyed).toBe(true);
    });

    it("fades the glow at session end and on a silent bot", () => {
        send({ t: "move", x: 50, y: 50 });
        send({ t: "session", on: false });
        expect(fx.wins[0].scripts.at(-1)).toEqual({ t: "session", on: false });
        vi.advanceTimersByTime(600);
        expect(fx.wins[0].calls.at(-1)).toEqual(["hide"]);

        send({ t: "move", x: 60, y: 60 });
        vi.advanceTimersByTime(90_000);
        expect(fx.wins[0].scripts.at(-1)).toEqual({ t: "session", on: false });
    });
});

describe("renderer page", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "agent-cursor.html"), "utf8");

    it("glows, glides, ripples and pulses", () => {
        vi.useFakeTimers();
        const dom = new JSDOM(html, { runScripts: "dangerously" });
        const { window } = dom;
        const doc = window.document;
        window.cursor({ t: "session", on: true });
        expect(doc.getElementById("glow").classList.contains("on")).toBe(true);
        window.cursor({ t: "click", x: 100, y: 40, ms: 0, button: "left", count: 2 });
        expect(doc.getElementById("cursor").style.transform).toBe("translate(98px, 38px)");
        vi.advanceTimersByTime(200);
        expect(doc.querySelectorAll(".ripple")).toHaveLength(2);
        window.cursor({ t: "type", on: true });
        expect(doc.getElementById("cursor").classList.contains("typing")).toBe(true);
        window.cursor({ t: "session", on: false });
        expect(doc.getElementById("glow").classList.contains("on")).toBe(false);
        expect(doc.getElementById("cursor").classList.contains("on")).toBe(false);
    });
});
