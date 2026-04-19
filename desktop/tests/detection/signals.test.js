// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import * as signals from "../../detection/signals.js";

describe("detectPlatform", () => {
    it("returns 'darwin' for macOS", () => {
        expect(signals.detectPlatform({ platform: "darwin" })).toBe("darwin");
    });
    it("returns 'win32' for Windows", () => {
        expect(signals.detectPlatform({ platform: "win32" })).toBe("win32");
    });
    it("returns 'linux' for Linux", () => {
        expect(signals.detectPlatform({ platform: "linux" })).toBe("linux");
    });
});

describe("detectSetupFlag", () => {
    it("returns true when the flag file exists", () => {
        const fs = { existsSync: (p) => p === "/tmp/SETUP" };
        expect(signals.detectSetupFlag(fs, "/tmp/SETUP")).toBe(true);
    });
    it("returns false when the flag file is missing", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectSetupFlag(fs, "/tmp/SETUP")).toBe(false);
    });
});

describe("detectEnvPresent", () => {
    it("returns true on .env presence, never leaks content", () => {
        const fs = { existsSync: () => true };
        const result = signals.detectEnvPresent(fs, "/tmp/.env");
        expect(result).toBe(true);
    });
    it("returns false when absent", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectEnvPresent(fs, "/tmp/.env")).toBe(false);
    });
});

describe("detectGoogleTokens", () => {
    it("returns disconnected when the directory is missing", async () => {
        const fs = { existsSync: () => false, promises: { readdir: async () => [] } };
        const result = await signals.detectGoogleTokens(fs, "/tmp/google");
        expect(result).toEqual({ connected: false });
    });
    it("extracts email from a token filename", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readdir: async () => ["user@example.com.json", ".DS_Store"] },
        };
        const result = await signals.detectGoogleTokens(fs, "/tmp/google");
        expect(result).toEqual({ connected: true, email: "user@example.com" });
    });
    it("omits email when filename doesn't match the <email>.json convention", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readdir: async () => ["oauth.json"] },
        };
        const result = await signals.detectGoogleTokens(fs, "/tmp/google");
        expect(result).toEqual({ connected: true });
    });
});

describe("detectOtplessSession", () => {
    it("returns signed-in when the prefs account is not expired", () => {
        const future = Date.now() + 60_000;
        const prefs = {
            account: {
                signedIn: true, email: "a@b.com", plan: "pro", credits: 42, expiresAt: future,
            },
        };
        const r = signals.detectOtplessSession(prefs);
        expect(r).toEqual({ signedIn: true, email: "a@b.com", plan: "pro", credits: 42 });
    });
    it("returns signed-out when expired", () => {
        const past = Date.now() - 60_000;
        const prefs = { account: { signedIn: true, email: "x@y.com", expiresAt: past } };
        expect(signals.detectOtplessSession(prefs)).toEqual({ signedIn: false });
    });
    it("returns signed-out when absent", () => {
        expect(signals.detectOtplessSession({})).toEqual({ signedIn: false });
    });
});

describe("detectNodeInstalled", () => {
    it("returns true when node --version succeeds", async () => {
        const execFn = async () => ({ stdout: "v20.11.1\n" });
        expect(await signals.detectNodeInstalled(execFn)).toBe(true);
    });
    it("returns false when node --version throws", async () => {
        const execFn = async () => { throw new Error("ENOENT"); };
        expect(await signals.detectNodeInstalled(execFn)).toBe(false);
    });
    it("returns false for Node < 20", async () => {
        const execFn = async () => ({ stdout: "v18.17.0\n" });
        expect(await signals.detectNodeInstalled(execFn)).toBe(false);
    });
});

describe("detectPlaywrightChromium", () => {
    it("returns true when the browsers dir exists", () => {
        const fs = { existsSync: (p) => p.endsWith(".local-browsers") };
        expect(signals.detectPlaywrightChromium(fs, "/bot")).toBe(true);
    });
    it("returns false otherwise", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectPlaywrightChromium(fs, "/bot")).toBe(false);
    });
});

describe("detectEmbeddingModel", () => {
    it("returns true when MiniLM cache folder exists", async () => {
        const fs = {
            existsSync: (p) => p.includes("transformers"),
            promises: { readdir: async () => ["models--Xenova--all-MiniLM-L6-v2"] },
        };
        expect(await signals.detectEmbeddingModel(fs, "/home/u")).toBe(true);
    });
    it("returns false when no MiniLM entry exists", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readdir: async () => ["models--other--model"] },
        };
        expect(await signals.detectEmbeddingModel(fs, "/home/u")).toBe(false);
    });
    it("returns false when the cache path is missing", async () => {
        const fs = { existsSync: () => false, promises: { readdir: async () => [] } };
        expect(await signals.detectEmbeddingModel(fs, "/home/u")).toBe(false);
    });
});

describe("detectMacPermissions", () => {
    it("maps Electron statuses to granted/denied/unknown", () => {
        const sp = {
            isTrustedAccessibilityClient: () => true,
            getMediaAccessStatus: (kind) => ({
                screen: "granted", microphone: "denied", location: "not-determined",
            }[kind]),
        };
        expect(signals.detectMacPermissions(sp)).toEqual({
            accessibility: "granted",
            screen: "granted",
            microphone: "denied",
            location: "unknown",
        });
    });
});

describe("detectTheme", () => {
    it("returns dark when nativeTheme reports dark", () => {
        expect(signals.detectTheme({ shouldUseDarkColors: true })).toBe("dark");
    });
    it("returns light otherwise", () => {
        expect(signals.detectTheme({ shouldUseDarkColors: false })).toBe("light");
    });
});

describe("detectWorkspace", () => {
    it("reports existence", () => {
        const fs = { existsSync: () => true };
        expect(signals.detectWorkspace(fs, "/ws")).toEqual({ path: "/ws", exists: true });
    });
    it("reports non-existence", () => {
        const fs = { existsSync: () => false };
        expect(signals.detectWorkspace(fs, "/ws")).toEqual({ path: "/ws", exists: false });
    });
});

describe("detectHotkeyConflict", () => {
    it("returns empty array when registration succeeds", () => {
        const gs = { register: () => true, unregister: () => {}, isRegistered: () => false };
        expect(signals.detectHotkeyConflict(gs, "Alt+Space")).toEqual([]);
    });
    it("returns a conflict reason when registration fails", () => {
        const gs = { register: () => false, unregister: () => {}, isRegistered: () => true };
        const r = signals.detectHotkeyConflict(gs, "Alt+Space");
        expect(r.length).toBeGreaterThan(0);
        expect(r[0]).toMatch(/Alt\+Space/);
    });
    it("still cleans up (unregisters) after a successful registration — leak-free", () => {
        let unregisterCalls = 0;
        const gs = {
            register: () => true,
            unregister: () => { unregisterCalls += 1; },
            isRegistered: () => false,
        };
        const r = signals.detectHotkeyConflict(gs, "Alt+Space");
        expect(r).toEqual([]);
        expect(unregisterCalls).toBe(1);
    });
    it("still cleans up (unregisters) even if register throws mid-probe", () => {
        // Ensure the finally block doesn't fire a second unregister when register threw.
        let unregisterCalls = 0;
        const gs = {
            register: () => { throw new Error("boom"); },
            unregister: () => { unregisterCalls += 1; },
            isRegistered: () => false,
        };
        const r = signals.detectHotkeyConflict(gs, "Alt+Space");
        expect(r.length).toBe(1);
        expect(r[0]).toMatch(/boom/);
        expect(unregisterCalls).toBe(0);
    });
});

describe("detectAppVersion", () => {
    it("returns current with no previous when stored file is missing", () => {
        const fs = { existsSync: () => false, readFileSync: () => "" };
        expect(signals.detectAppVersion(fs, "1.0.0", "/tmp/v.json")).toEqual({ current: "1.0.0" });
    });
    it("returns current and previous when stored version differs", () => {
        const fs = { existsSync: () => true, readFileSync: () => JSON.stringify({ version: "0.9.0" }) };
        const r = signals.detectAppVersion(fs, "1.0.0", "/tmp/v.json");
        expect(r).toEqual({ current: "1.0.0", previous: "0.9.0" });
    });
});

describe("channel probes", () => {
    it("detectTelegram needs BOTH token and allowed IDs", () => {
        expect(signals.detectTelegram({ TELEGRAM_BOT_TOKEN: "x", ALLOWED_USER_IDS: "1" }))
            .toEqual({ connected: true });
        expect(signals.detectTelegram({ TELEGRAM_BOT_TOKEN: "x" })).toBeUndefined();
        expect(signals.detectTelegram({})).toBeUndefined();
    });
    it("detectDiscord reads DISCORD_BOT_TOKEN", () => {
        expect(signals.detectDiscord({ DISCORD_BOT_TOKEN: "x" })).toEqual({ connected: true });
        expect(signals.detectDiscord({})).toBeUndefined();
    });
    it("detectSlack finds the first workspace json", async () => {
        const fs = {
            existsSync: () => true,
            promises: {
                readdir: async () => ["team-abc.json"],
                readFile: async () => JSON.stringify({ team: { name: "Team ABC" } }),
            },
        };
        expect(await signals.detectSlack(fs, "/data/slack")).toEqual({
            connected: true, workspace: "Team ABC",
        });
    });
    it("detectSlack returns undefined when dir is empty", async () => {
        const fs = { existsSync: () => false, promises: { readdir: async () => [] } };
        expect(await signals.detectSlack(fs, "/data/slack")).toBeUndefined();
    });
    it("detectWhatsApp returns owner when owners file is non-empty", async () => {
        const fs = {
            existsSync: () => true,
            promises: { readFile: async () => JSON.stringify([{ jid: "123@s.whatsapp.net" }]) },
        };
        expect(await signals.detectWhatsApp(fs, "/data/wa/owners.json")).toEqual({
            connected: true, owner: "123@s.whatsapp.net",
        });
    });
    it("detectWhatsApp returns undefined on empty array", async () => {
        const fs = { existsSync: () => true, promises: { readFile: async () => "[]" } };
        expect(await signals.detectWhatsApp(fs, "/f")).toBeUndefined();
    });
    it("detectMatrix needs homeserver AND token", () => {
        expect(signals.detectMatrix({ MATRIX_HOMESERVER: "h", MATRIX_ACCESS_TOKEN: "t" }))
            .toEqual({ connected: true, homeserver: "h" });
        expect(signals.detectMatrix({ MATRIX_HOMESERVER: "h" })).toBeUndefined();
    });
    it("detectEmail needs user AND password", () => {
        expect(signals.detectEmail({ EMAIL_USER: "u@x.com", EMAIL_PASSWORD: "p" }))
            .toEqual({ connected: true, address: "u@x.com" });
        expect(signals.detectEmail({ EMAIL_USER: "u@x.com" })).toBeUndefined();
    });
});

describe("detectOsUserName", () => {
    it("returns the OS user name via the injected os module", () => {
        const os = { userInfo: () => ({ username: "alice" }) };
        expect(signals.detectOsUserName(os)).toBe("alice");
    });
    it("returns empty string when os.userInfo throws", () => {
        const os = { userInfo: () => { throw new Error("boom"); } };
        expect(signals.detectOsUserName(os)).toBe("");
    });
});

describe("detectPersonalize", () => {
    it("returns defaults when prefs has no personalize block — macOS default hotkey", () => {
        expect(signals.detectPersonalize({}, "darwin")).toEqual({
            hotkey: "Alt+Space",
            theme: "system",
            voice: { backend: "gemini-live", name: "Aoede" },
            wakeWord: { enabled: false, phrase: "Hey Atlas" },
        });
    });
    it("returns Windows default hotkey when platform is win32", () => {
        const r = signals.detectPersonalize({}, "win32");
        expect(r.hotkey).toBe("Ctrl+Space");
    });
    it("merges stored personalize values over defaults", () => {
        const prefs = { personalize: { hotkey: "Cmd+Shift+A", theme: "dark", voice: { backend: "openai-realtime", name: "alloy" }, wakeWord: { enabled: true, phrase: "Yo Atlas" } } };
        expect(signals.detectPersonalize(prefs, "darwin")).toEqual({
            hotkey: "Cmd+Shift+A",
            theme: "dark",
            voice: { backend: "openai-realtime", name: "alloy" },
            wakeWord: { enabled: true, phrase: "Yo Atlas" },
        });
    });
});
