// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseAccelerator, isModifierKey, HotkeyPicker } from "../../components/hotkey-picker.js";

function evt(o) {
    return Object.assign({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "KeyK", key: "k" }, o || {});
}

describe("parseAccelerator", () => {
    it("Cmd+Shift+K on darwin", () => { expect(parseAccelerator(evt({ metaKey: true, shiftKey: true }), "darwin")).toBe("CmdOrCtrl+Shift+K"); });
    it("Ctrl+Shift+K on win32", () => { expect(parseAccelerator(evt({ ctrlKey: true, shiftKey: true }), "win32")).toBe("CmdOrCtrl+Shift+K"); });
    it("Alt+Space", () => { expect(parseAccelerator(evt({ altKey: true, code: "Space", key: " " }), "darwin")).toBe("Alt+Space"); });
    it("F5", () => { expect(parseAccelerator(evt({ code: "F5", key: "F5" }), "darwin")).toBe("F5"); });
    it("Alt+ArrowLeft → Alt+Left", () => { expect(parseAccelerator(evt({ altKey: true, code: "ArrowLeft", key: "ArrowLeft" }), "darwin")).toBe("Alt+Left"); });
    it("rejects modifier-only", () => { expect(parseAccelerator(evt({ metaKey: true, code: "MetaLeft", key: "Meta" }), "darwin")).toBeNull(); });
    it("uppercases letters", () => { expect(parseAccelerator(evt({ metaKey: true, code: "KeyA", key: "a" }), "darwin")).toBe("CmdOrCtrl+A"); });
});

describe("isModifierKey", () => {
    it("modifiers", () => { ["Meta", "Shift", "Control", "Alt"].forEach((k) => expect(isModifierKey(k)).toBe(true)); });
    it("letter", () => { expect(isModifierKey("a")).toBe(false); });
});

describe("HotkeyPicker DOM", () => {
    let atlasCalls;
    let deferredTest;
    beforeEach(() => {
        atlasCalls = { tests: [], saves: [] };
        deferredTest = null;
        window.atlas = {
            setupTestHotkey: (combo) => {
                atlasCalls.tests.push(combo);
                if (deferredTest) return deferredTest;
                return Promise.resolve({ ok: true });
            },
            setupSaveHotkey: (combo) => {
                atlasCalls.saves.push(combo);
                return Promise.resolve({ ok: true });
            },
        };
    });
    afterEach(() => { delete window.atlas; });

    async function fireKey(el, init) {
        const ev = new KeyboardEvent("keydown", Object.assign({ bubbles: true }, init));
        window.dispatchEvent(ev);
        // Let microtasks flush (test/save IPCs resolve).
        await Promise.resolve();
        await Promise.resolve();
    }

    it("throws when mounted without a container", () => {
        const p = new HotkeyPicker({});
        expect(() => p.mount(null)).toThrow(/container is required/);
    });

    it("records a combo, tests it, and persists via setupSaveHotkey", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const changes = [];
        const p = new HotkeyPicker({ platform: "darwin", onChange: (v) => changes.push(v) });
        p.mount(c);
        c.querySelector("[data-sp-record]").click();
        await fireKey(c, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
        expect(atlasCalls.tests).toEqual(["CmdOrCtrl+Shift+K"]);
        expect(atlasCalls.saves).toEqual(["CmdOrCtrl+Shift+K"]);
        expect(changes).toEqual(["CmdOrCtrl+Shift+K"]);
        expect(c.querySelector("[data-sp-combo]").textContent).toBe("CmdOrCtrl+Shift+K");
        p.unmount();
    });

    it("Escape cancels recording without commit", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const changes = [];
        const p = new HotkeyPicker({ platform: "darwin", initial: "Alt+Space", onChange: (v) => changes.push(v) });
        p.mount(c);
        c.querySelector("[data-sp-record]").click();
        await fireKey(c, { key: "Escape", code: "Escape" });
        expect(atlasCalls.tests).toEqual([]);
        expect(atlasCalls.saves).toEqual([]);
        expect(changes).toEqual([]);
        expect(p.getValue()).toBe("Alt+Space");
        p.unmount();
    });

    it("test-failure surfaces the conflict and does not call save", async () => {
        window.atlas.setupTestHotkey = (combo) => {
            atlasCalls.tests.push(combo);
            return Promise.resolve({ ok: false, conflict: "Spotlight uses that" });
        };
        const c = document.createElement("div"); document.body.appendChild(c);
        const p = new HotkeyPicker({ platform: "darwin" });
        p.mount(c);
        c.querySelector("[data-sp-record]").click();
        await fireKey(c, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
        expect(atlasCalls.saves).toEqual([]);
        const status = c.querySelector("[data-sp-status]");
        expect(status.textContent).toBe("Spotlight uses that");
        expect(status.className).toMatch(/sp-hotkey__conflict/);
        p.unmount();
    });

    it("save-failure surfaces an error instead of silently succeeding", async () => {
        window.atlas.setupSaveHotkey = () => Promise.resolve({ ok: false, error: "register returned false" });
        const c = document.createElement("div"); document.body.appendChild(c);
        const changes = [];
        const p = new HotkeyPicker({ platform: "darwin", onChange: (v) => changes.push(v) });
        p.mount(c);
        c.querySelector("[data-sp-record]").click();
        await fireKey(c, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
        const status = c.querySelector("[data-sp-status]");
        expect(status.textContent).toMatch(/Save failed: register returned false/);
        expect(status.className).toMatch(/sp-hotkey__conflict/);
        expect(changes).toEqual([]); // onChange NOT called on save failure
        p.unmount();
    });

    it("re-recording mid-test-inflight discards the stale test result", async () => {
        // Make setupTestHotkey pend on a promise we control
        let resolveFirst;
        deferredTest = new Promise((r) => { resolveFirst = r; });
        const c = document.createElement("div"); document.body.appendChild(c);
        const changes = [];
        const p = new HotkeyPicker({ platform: "darwin", initial: "Alt+Space", onChange: (v) => changes.push(v) });
        p.mount(c);

        // First recording: K with Cmd+Shift
        c.querySelector("[data-sp-record]").click();
        await fireKey(c, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
        // test is in flight, not resolved yet — combo text still shows initial
        expect(atlasCalls.tests).toEqual(["CmdOrCtrl+Shift+K"]);
        expect(atlasCalls.saves).toEqual([]);

        // Before the first test resolves, start a new recording — the second test resolves synchronously (deferredTest only consumed once)
        deferredTest = null;
        c.querySelector("[data-sp-record]").click();
        await fireKey(c, { key: "j", code: "KeyJ", metaKey: true, shiftKey: true });
        expect(atlasCalls.tests).toEqual(["CmdOrCtrl+Shift+K", "CmdOrCtrl+Shift+J"]);
        expect(atlasCalls.saves).toEqual(["CmdOrCtrl+Shift+J"]);
        expect(changes).toEqual(["CmdOrCtrl+Shift+J"]);

        // Now resolve the first test — it should be IGNORED because token is stale.
        resolveFirst({ ok: true });
        await Promise.resolve();
        await Promise.resolve();
        // Save still only the J one; combo text still J; no regression to K.
        expect(atlasCalls.saves).toEqual(["CmdOrCtrl+Shift+J"]);
        expect(c.querySelector("[data-sp-combo]").textContent).toBe("CmdOrCtrl+Shift+J");
        p.unmount();
    });
});
