// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { mergePersonalize, envKVsFromPersonalize, VALID_VOICE_BACKENDS, VALID_THEMES } from "../../wizard/personalize-reducer.js";

describe("mergePersonalize", () => {
    it("merges shallowly, keeps unrelated keys", () => {
        const out = mergePersonalize(
            { personalize: { hotkey: "Alt+Space" }, account: { signedIn: true }, misc: 1 },
            { hotkey: "Control+Space", theme: "light" }
        );
        expect(out.personalize.hotkey).toBe("Control+Space");
        expect(out.personalize.theme).toBe("light");
        expect(out.account.signedIn).toBe(true);
        expect(out.misc).toBe(1);
    });
    it("rejects empty hotkey", () => {
        expect(() => mergePersonalize({}, { hotkey: "" })).toThrow(/hotkey/i);
        expect(() => mergePersonalize({}, { hotkey: "   " })).toThrow(/hotkey/i);
    });
    it("rejects invalid theme", () => {
        expect(() => mergePersonalize({}, { theme: "neon" })).toThrow(/theme/i);
    });
    it("accepts every valid theme", () => {
        for (const t of VALID_THEMES) {
            expect(mergePersonalize({}, { theme: t }).personalize.theme).toBe(t);
        }
    });
    it("rejects invalid voice backend", () => {
        expect(() => mergePersonalize({}, { voice: { backend: "google-cloud", name: "x" } })).toThrow(/backend/i);
    });
    it("accepts each valid voice backend", () => {
        for (const b of VALID_VOICE_BACKENDS) {
            const out = mergePersonalize({}, { voice: { backend: b, name: "Aoede" } });
            expect(out.personalize.voice.backend).toBe(b);
            expect(out.personalize.voice.name).toBe("Aoede");
        }
    });
    it("defaults wake-word phrase to 'Hey Atlas'", () => {
        const out = mergePersonalize({}, { wakeWord: { enabled: true } });
        expect(out.personalize.wakeWord).toEqual({ enabled: true, phrase: "Hey Atlas" });
    });
    it("wakeWord enabled is coerced to boolean", () => {
        const out = mergePersonalize({}, { wakeWord: { enabled: "truthy" } });
        expect(out.personalize.wakeWord.enabled).toBe(true);
    });
    it("does not mutate the prefs input", () => {
        const prefs = { personalize: { hotkey: "Alt+Space" } };
        mergePersonalize(prefs, { hotkey: "Control+Space" });
        expect(prefs.personalize.hotkey).toBe("Alt+Space");
    });
});

describe("envKVsFromPersonalize", () => {
    it("maps every field into ATLAS_* env keys", () => {
        const p = {
            hotkey: "Alt+Space",
            theme: "dark",
            voice: { backend: "gemini-live", name: "Aoede" },
            wakeWord: { enabled: true, phrase: "Hey Atlas" },
        };
        expect(envKVsFromPersonalize(p)).toEqual({
            ATLAS_OVERLAY_HOTKEY: "Alt+Space",
            ATLAS_LIVE_VOICE_BACKEND: "gemini-live",
            ATLAS_LIVE_VOICE_NAME: "Aoede",
            ATLAS_WAKE_WORD_ENABLED: "true",
            ATLAS_WAKE_WORD_PHRASE: "Hey Atlas",
        });
    });
    it("wake-word disabled maps to 'false' string", () => {
        const p = { wakeWord: { enabled: false, phrase: "x" } };
        expect(envKVsFromPersonalize(p).ATLAS_WAKE_WORD_ENABLED).toBe("false");
    });
    it("omits keys for missing fields", () => {
        expect(envKVsFromPersonalize({})).toEqual({});
        expect(envKVsFromPersonalize(null)).toEqual({});
    });
});
