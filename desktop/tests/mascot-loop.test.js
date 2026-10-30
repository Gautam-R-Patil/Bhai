// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const SRC = fs.readFileSync(path.join(__dirname, "../components/mascot.js"), "utf8");

// A mascot page with hand-driven frames: rAF and timers are recorded, never run on their own.
function page() {
    const dom = new JSDOM("<!doctype html><body><div id=a></div><div id=b></div></body>", {
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const raf = [];
    const timers = new Map();
    let id = 0;
    let clock = 0;
    let widths = 100;
    let roCallback = null;
    w.requestAnimationFrame = (cb) => {
        raf.push(cb);
        return raf.length;
    };
    w.setTimeout = (cb, ms) => {
        timers.set(++id, { cb, ms });
        return id;
    };
    w.clearTimeout = (t) => timers.delete(t);
    w.performance.now = () => clock;
    w.ResizeObserver = class {
        constructor(cb) {
            roCallback = cb;
        }
        observe() {}
        unobserve() {}
    };
    Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get: () => widths });
    Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => widths });
    w.Math.random = () => 0.5;
    w.eval(SRC);
    const host = w.document.getElementById("a");
    const calmTimers = () => [...timers.entries()].filter(([, t]) => t.ms === 50);
    return {
        w,
        host,
        raf,
        timers,
        calmTimers,
        setWidth: (v) => {
            widths = v;
        },
        resized: () => roCallback?.([]),
        // Run one scheduled frame (rAF first, else the 50 ms tick), advancing the clock.
        tick(ms) {
            clock += ms;
            if (raf.length) return raf.shift()(clock);
            const [tid, t] = calmTimers()[0] || [];
            if (t) {
                timers.delete(tid);
                t.cb();
            }
        },
    };
}

describe("mascot frame loop", () => {
    let p;
    beforeEach(() => {
        p = page();
        p.w.BhaiMascot.mount(p.host, "idle");
    });

    it("drops to a 50 ms tick while only breathing, without a rAF in flight", () => {
        p.tick(16);
        expect(p.raf.length).toBe(0);
        expect(p.calmTimers().length).toBe(1);
    });

    it("goes back to rAF the moment Bhai is poked, and stays there through the act", () => {
        p.tick(16);
        p.w.BhaiMascot.react(p.host, "boop");
        expect(p.calmTimers().length).toBe(0);
        expect(p.raf.length).toBe(1);
        for (let i = 0; i < 30; i++) p.tick(16);
        expect(p.raf.length).toBe(1);
        expect(p.calmTimers().length).toBe(0);
    });

    it("settles back to the slow tick once the springs ease back after an act", () => {
        p.w.BhaiMascot.react(p.host, "perk"); // 0.5 s
        for (let i = 0; i < 120 && p.raf.length; i++) p.tick(16);
        expect(p.raf.length).toBe(0);
        expect(p.calmTimers().length).toBe(1);
    });

    it("keeps rAF while working (fast breathing)", () => {
        p.w.BhaiMascot.mount(p.host, "working");
        for (let i = 0; i < 5; i++) p.tick(16);
        expect(p.raf.length).toBe(1);
        expect(p.calmTimers().length).toBe(0);
    });

    it("steps a calm Bhai every ~50 ms even while another one is lively", () => {
        const b = p.w.document.getElementById("b");
        p.w.BhaiMascot.mount(b, "idle");
        p.tick(16);
        p.w.BhaiMascot.react(b, "boop");
        const rig = p.host.querySelector(".bm-rig");
        let writes = 0;
        let prev = rig.style.transform;
        for (let i = 0; i < 30; i++) {
            p.tick(16);
            if (rig.style.transform !== prev) {
                writes++;
                prev = rig.style.transform;
            }
        }
        expect(p.raf.length).toBe(1);
        expect(writes).toBeGreaterThanOrEqual(8);
        expect(writes).toBeLessThanOrEqual(11);
    });

    it("stops scheduling when every host is hidden, and restarts when one shows", () => {
        p.setWidth(0);
        p.tick(16);
        expect(p.raf.length).toBe(0);
        expect(p.calmTimers().length).toBe(0);
        p.setWidth(100);
        p.resized();
        expect(p.raf.length).toBe(1);
    });
});
