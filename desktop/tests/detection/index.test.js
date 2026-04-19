// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import * as det from "../../detection/index.js";

const { runDetection, withTimeout } = det;

describe("withTimeout", () => {
    it("resolves with the probe result when fast", async () => {
        const r = await withTimeout(Promise.resolve("ok"), 100, "fallback");
        expect(r).toBe("ok");
    });
    it("returns fallback when the probe times out", async () => {
        const slow = new Promise((res) => setTimeout(() => res("too-late"), 200));
        const r = await withTimeout(slow, 50, "fallback");
        expect(r).toBe("fallback");
    });
    it("returns fallback when the probe rejects", async () => {
        const bad = Promise.reject(new Error("boom"));
        const r = await withTimeout(bad, 100, "fallback");
        expect(r).toBe("fallback");
    });
});

describe("runDetection", () => {
    const fakeDeps = () => ({
        proc: { platform: "darwin" },
        fs: {
            existsSync: () => false,
            readFileSync: () => "",
            promises: { readdir: async () => [], readFile: async () => "[]" },
        },
        os: { userInfo: () => ({ username: "alice" }) },
        systemPreferences: {
            isTrustedAccessibilityClient: () => false,
            getMediaAccessStatus: () => "not-determined",
        },
        nativeTheme: { shouldUseDarkColors: false },
        globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false },
        prefs: {},
        envObj: {},
        execFn: async () => { throw new Error("no node"); },
        paths: {
            setupFlag: "/tmp/SETUP",
            envFile: "/tmp/.env",
            googleTokens: "/tmp/google-tokens",
            botDir: "/tmp/bot",
            homeDir: "/tmp/home",
            workspace: "/tmp/ws",
            storedVersion: "/tmp/version.json",
            slackInstalls: "/tmp/slack",
            whatsappOwners: "/tmp/wa/owners.json",
        },
        currentVersion: "0.2.0",
        hotkey: "Alt+Space",
    });

    it("returns the full SystemState shape", async () => {
        const state = await runDetection(fakeDeps());
        expect(state).toMatchObject({
            platform: "darwin",
            isReconfigure: false,
            version: { current: "0.2.0" },
            account: { signedIn: false },
            permissions: expect.objectContaining({
                accessibility: expect.any(String),
                screen: expect.any(String),
                microphone: expect.any(String),
                location: expect.any(String),
            }),
            installed: expect.objectContaining({
                node: expect.any(Boolean),
                playwright: expect.any(Boolean),
                embeddingModel: expect.any(Boolean),
            }),
            google: { connected: false },
            channels: expect.any(Object),
            hotkey: { current: "Alt+Space", conflicts: [] },
            theme: "light",
            workspace: { path: "/tmp/ws", exists: false },
        });
    });

    it("survives a throwing probe by substituting the fail-safe", async () => {
        const deps = fakeDeps();
        deps.systemPreferences = {
            isTrustedAccessibilityClient: () => { throw new Error("nope"); },
            getMediaAccessStatus: () => { throw new Error("nope"); },
        };
        const state = await runDetection(deps);
        expect(state.permissions).toEqual({
            accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown",
        });
    });

    it("treats a slow probe as a fallback result", async () => {
        const deps = fakeDeps();
        deps.execFn = () => new Promise((res) => setTimeout(() => res({ stdout: "v20.0.0" }), 2000));
        deps.signalTimeoutMs = 50;
        const state = await runDetection(deps);
        expect(state.installed.node).toBe(false); // fallback when timeout fires
    });

    it("reports reconfigure mode when SETUP flag exists", async () => {
        const deps = fakeDeps();
        deps.fs.existsSync = (p) => p === "/tmp/SETUP";
        const state = await runDetection(deps);
        expect(state.isReconfigure).toBe(true);
    });

    // ── Phase E additions ─────────────────────────────
    it("populates osUserName at the top level", async () => {
        const state = await runDetection(fakeDeps());
        expect(state.osUserName).toBe("alice");
    });

    it("populates personalize at the top level with defaults", async () => {
        const state = await runDetection(fakeDeps());
        expect(state.personalize).toEqual({
            hotkey: "Alt+Space",
            theme: "system",
            voice: { backend: "gemini-live", name: "Aoede" },
            wakeWord: { enabled: false, phrase: "Hey Atlas" },
        });
    });

    it("exposes voice and wakeWord as top-level convenience copies of personalize", async () => {
        const state = await runDetection(fakeDeps());
        expect(state.voice).toEqual(state.personalize.voice);
        expect(state.wakeWord).toEqual(state.personalize.wakeWord);
    });

    it("respects stored personalize values over defaults", async () => {
        const deps = fakeDeps();
        deps.prefs = {
            personalize: {
                hotkey: "Cmd+Shift+A",
                theme: "dark",
                voice: { backend: "openai-realtime", name: "alloy" },
                wakeWord: { enabled: true, phrase: "Yo Atlas" },
            },
        };
        const state = await runDetection(deps);
        expect(state.personalize.hotkey).toBe("Cmd+Shift+A");
        expect(state.voice.name).toBe("alloy");
        expect(state.wakeWord.enabled).toBe(true);
    });
});
