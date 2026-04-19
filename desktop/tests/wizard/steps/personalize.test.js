// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "../../../wizard/steps/personalize.js";

function makeStubComponent(getValueResult) {
    let captured = null;
    class Stub {
        constructor(props) { this.props = props || {}; captured = this; }
        mount(el) {
            this._el = document.createElement("div");
            el.appendChild(this._el);
            return this;
        }
        getValue() { return getValueResult; }
    }
    return { Stub, captured: () => captured };
}

describe("personalize step", () => {
    let calls;
    beforeEach(() => {
        calls = { saves: [], advances: 0, backs: 0, refreshes: 0 };
        window.atlas = {
            setupSavePersonalize: async (p) => { calls.saves.push(p); return { success: true, prefs: {} }; },
        };
        window.SetupComponents = window.SetupComponents || {};
        document.body.innerHTML = "";
    });
    afterEach(() => {
        delete window.atlas;
        delete window.SetupComponents.HotkeyPicker;
        delete window.SetupComponents.ThemeSwitch;
        delete window.SetupComponents.VoicePicker;
    });

    it("renders the four cards + Back/Continue buttons", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector("#card-hotkey")).toBeTruthy();
        expect(host.querySelector("#card-theme")).toBeTruthy();
        expect(host.querySelector("#card-voice")).toBeTruthy();
        expect(host.querySelector("#card-wake")).toBeTruthy();
        expect(host.querySelector("#pz-back")).toBeTruthy();
        expect(host.querySelector("#pz-next")).toBeTruthy();
    });

    it("E3a: conflict banner renders and Continue is disabled when state.hotkey.conflicts is non-empty", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, {
            state: { platform: "darwin", hotkey: { current: "Alt+Space", conflicts: ["Spotlight"] } },
            onAdvance: () => {}, onBack: () => {}, refreshState: async () => {},
        });
        const banner = host.querySelector("#pz-conflict");
        expect(banner).toBeTruthy();
        expect(banner.textContent).toMatch(/Spotlight/);
        expect(host.querySelector("#pz-next").disabled).toBe(true);
    });

    it("E3a: after HotkeyPicker onChange fires with a new combo, banner clears and Continue re-enables", () => {
        const hk = makeStubComponent("Control+Shift+A");
        window.SetupComponents.HotkeyPicker = hk.Stub;
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, {
            state: { platform: "darwin", hotkey: { current: "Alt+Space", conflicts: ["Spotlight"] } },
            onAdvance: () => {}, onBack: () => {}, refreshState: async () => {},
        });
        expect(host.querySelector("#pz-next").disabled).toBe(true);
        // Simulate HotkeyPicker firing its onChange
        hk.captured().props.onChange("Control+Shift+A");
        expect(host.querySelector("#pz-next").disabled).toBe(false);
        expect(host.querySelector("#pz-conflict")).toBe(null);
    });

    it("Continue button gathers values from all components and invokes setupSavePersonalize", async () => {
        const hk = makeStubComponent("Control+Shift+A");
        const th = makeStubComponent("dark");
        const vp = makeStubComponent({ backend: "openai-realtime", name: "alloy" });
        window.SetupComponents.HotkeyPicker = hk.Stub;
        window.SetupComponents.ThemeSwitch = th.Stub;
        window.SetupComponents.VoicePicker = vp.Stub;

        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, {
            state: { platform: "darwin", hotkey: { current: "Alt+Space", conflicts: [] } },
            onAdvance: () => calls.advances++,
            onBack: () => {},
            refreshState: async () => calls.refreshes++,
        });
        host.querySelector("#wake-enabled").checked = true;
        host.querySelector("#wake-phrase").value = "Yo Atlas";
        host.querySelector("#pz-next").click();
        await Promise.resolve(); await Promise.resolve();
        expect(calls.saves).toEqual([{
            hotkey: "Control+Shift+A",
            theme: "dark",
            voice: { backend: "openai-realtime", name: "alloy" },
            wakeWord: { enabled: true, phrase: "Yo Atlas" },
        }]);
        expect(calls.refreshes).toBe(1);
        expect(calls.advances).toBe(1);
    });

    it("save IPC failure surfaces error and does NOT advance", async () => {
        window.atlas.setupSavePersonalize = async () => ({ success: false, error: "persist broken" });
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => {} });
        host.querySelector("#pz-next").click();
        await Promise.resolve(); await Promise.resolve();
        expect(host.querySelector("#pz-err").textContent).toBe("persist broken");
        expect(calls.advances).toBe(0);
    });

    it("Back button invokes ctx.onBack", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => {}, onBack: () => calls.backs++, refreshState: async () => {} });
        host.querySelector("#pz-back").click();
        expect(calls.backs).toBe(1);
    });

    it("Continue is a no-op when disabled (E3a gate)", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, {
            state: { platform: "darwin", hotkey: { conflicts: ["something"] } },
            onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => {},
        });
        host.querySelector("#pz-next").click();
        await Promise.resolve();
        expect(calls.saves).toEqual([]);
        expect(calls.advances).toBe(0);
    });
});
