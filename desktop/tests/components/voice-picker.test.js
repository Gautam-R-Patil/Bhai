// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { groupVoicesByBackend, VoicePicker } from "../../components/voice-picker.js";

describe("groupVoicesByBackend", () => {
    it("indexes voices by backend label", () => {
        const r = groupVoicesByBackend([
            { backend: "gemini-live", voices: ["Aoede", "Charon"] },
            { backend: "openai-realtime", voices: ["alloy"] },
        ]);
        expect(r.labels).toEqual(["gemini-live", "openai-realtime"]);
        expect(r.byBackend["gemini-live"]).toEqual(["Aoede", "Charon"]);
        expect(r.byBackend["openai-realtime"]).toEqual(["alloy"]);
    });
    it("returns empty on malformed input", () => {
        expect(groupVoicesByBackend(null)).toEqual({ labels: [], byBackend: {} });
        expect(groupVoicesByBackend([{ backend: "x" }])).toEqual({ labels: ["x"], byBackend: { x: [] } });
    });
});

describe("VoicePicker DOM", () => {
    let atlasCalls;
    beforeEach(() => {
        atlasCalls = { listed: 0, previews: [] };
        // Stub HTMLAudioElement.prototype.play so jsdom doesn't throw NotSupported.
        window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
        window.HTMLMediaElement.prototype.pause = function () {};
        window.atlas = {
            setupListVoices: async () => {
                atlasCalls.listed += 1;
                return [
                    { backend: "gemini-live", voices: ["Aoede", "Charon", "Kore"] },
                    { backend: "openai-realtime", voices: ["alloy", "shimmer"] },
                ];
            },
            setupPreviewVoice: async (backend, name) => {
                atlasCalls.previews.push({ backend, name });
                return { ok: true, url: "file:///tmp/sample.wav", backend, name };
            },
        };
    });
    afterEach(() => { delete window.atlas; });

    it("throws when mounted without a container", async () => {
        const v = new VoicePicker({});
        await expect(v.mount(null)).rejects.toThrow(/container is required/);
    });

    it("renders optgroups for each backend with the right option count", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const v = new VoicePicker({});
        await v.mount(c);
        const groups = c.querySelectorAll("optgroup");
        expect(groups.length).toBe(2);
        expect(groups[0].getAttribute("label")).toBe("gemini-live");
        expect(groups[0].querySelectorAll("option").length).toBe(3);
        expect(groups[1].querySelectorAll("option").length).toBe(2);
        v.unmount();
    });

    it("Preview button invokes setupPreviewVoice(backend, name)", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const v = new VoicePicker({});
        await v.mount(c);
        const sel = c.querySelector("[data-sp-select]");
        sel.value = "openai-realtime::shimmer";
        c.querySelector("[data-sp-preview]").click();
        // Let microtasks flush
        await Promise.resolve(); await Promise.resolve();
        expect(atlasCalls.previews).toEqual([{ backend: "openai-realtime", name: "shimmer" }]);
        v.unmount();
    });

    it("select change fires onChange with {backend,name}", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const changes = [];
        const v = new VoicePicker({ onChange: (x) => changes.push(x) });
        await v.mount(c);
        const sel = c.querySelector("[data-sp-select]");
        sel.value = "gemini-live::Kore";
        sel.dispatchEvent(new Event("change"));
        expect(changes).toEqual([{ backend: "gemini-live", name: "Kore" }]);
        v.unmount();
    });

    it("getValue returns the current selection", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const v = new VoicePicker({});
        await v.mount(c);
        const sel = c.querySelector("[data-sp-select]");
        sel.value = "gemini-live::Aoede";
        expect(v.getValue()).toEqual({ backend: "gemini-live", name: "Aoede" });
        v.unmount();
    });

    it("unmount stops playing audio and removes element", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const v = new VoicePicker({});
        await v.mount(c);
        const sel = c.querySelector("[data-sp-select]");
        sel.value = "gemini-live::Aoede";
        c.querySelector("[data-sp-preview]").click();
        await Promise.resolve(); await Promise.resolve();
        v.unmount();
        expect(c.firstElementChild).toBe(null);
    });
});
