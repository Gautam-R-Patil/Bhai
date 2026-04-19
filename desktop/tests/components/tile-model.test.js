// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { tileModel, TILE_ORDER } from "../../components/tile-model.js";

const base = () => ({
    platform: "darwin",
    account: { signedIn: true, email: "a@b.co", plan: "pro", credits: 1200 },
    profile: { name: "Dheeraj", tone: "friendly" },
    permissions: { accessibility: "granted", screen: "granted", microphone: "denied", location: "unknown" },
    google: { connected: true, email: "a@b.co" },
    channels: { telegram: { connected: true }, email: { connected: false } },
    hotkey: { current: "Alt+Space", conflicts: [] },
    theme: "dark",
    voice: { name: "Aoede", backend: "gemini-live" },
    wakeWord: { enabled: false, phrase: "Hey Atlas" },
});

describe("TILE_ORDER constant", () => {
    it("is the canonical 8-tile ordering", () => {
        expect(TILE_ORDER).toEqual(["account", "overlay", "permissions", "google", "channels", "voice", "theme", "wakeWord"]);
    });
});

describe("tileModel — account", () => {
    it("green when signed in, with email + plan + credits in secondary", () => {
        const t = tileModel(base(), "account");
        expect(t.status).toBe("green");
        expect(t.value).toBe("a@b.co");
        expect(t.secondary).toMatch(/pro/);
        expect(t.secondary).toMatch(/1200/);
        expect(t.onClickRoute).toBe("settings:account");
    });
    it("amber when not signed in", () => {
        const s = Object.assign(base(), { account: { signedIn: false } });
        const t = tileModel(s, "account");
        expect(t.status).toBe("amber");
        expect(t.value).toBe("Not signed in");
    });
    it("falls back to 'signed in' label when email is missing", () => {
        const s = Object.assign(base(), { account: { signedIn: true } });
        expect(tileModel(s, "account").value).toBe("signed in");
    });
    it("defaults plan to 'free' and credits to 0", () => {
        const s = Object.assign(base(), { account: { signedIn: true, email: "x@y.z" } });
        const t = tileModel(s, "account");
        expect(t.secondary).toMatch(/free/);
        expect(t.secondary).toMatch(/0 credits/);
    });
});

describe("tileModel — overlay", () => {
    it("green, shows current hotkey", () => {
        const t = tileModel(base(), "overlay");
        expect(t.status).toBe("green");
        expect(t.value).toBe("Alt+Space");
    });
    it("defaults to Alt+Space when hotkey.current is unset", () => {
        const s = Object.assign(base(), { hotkey: {} });
        expect(tileModel(s, "overlay").value).toBe("Alt+Space");
    });
});

describe("tileModel — permissions", () => {
    it("amber when partially granted", () => {
        const t = tileModel(base(), "permissions");
        expect(t.status).toBe("amber");
        expect(t.value).toBe("2 of 4 granted");
    });
    it("green when all 4 granted on darwin", () => {
        const s = Object.assign(base(), { permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" } });
        expect(tileModel(s, "permissions").status).toBe("green");
    });
    it("returns null on non-darwin (tile hidden)", () => {
        const s = Object.assign(base(), { platform: "win32" });
        expect(tileModel(s, "permissions")).toBe(null);
    });
});

describe("tileModel — google", () => {
    it("green when connected, shows email + secondary 'Calendar + Gmail'", () => {
        const t = tileModel(base(), "google");
        expect(t.status).toBe("green");
        expect(t.value).toBe("a@b.co");
        expect(t.secondary).toBe("Calendar + Gmail");
    });
    it("neutral when not connected", () => {
        const s = Object.assign(base(), { google: { connected: false } });
        const t = tileModel(s, "google");
        expect(t.status).toBe("neutral");
        expect(t.value).toBe("Not connected");
    });
});

describe("tileModel — channels", () => {
    it("green with 'N connected' when \u22651", () => {
        const t = tileModel(base(), "channels");
        expect(t.status).toBe("green");
        expect(t.value).toBe("1 connected");
    });
    it("neutral with '+ Add channel' when 0 connected", () => {
        const s = Object.assign(base(), { channels: { email: { connected: false } } });
        const t = tileModel(s, "channels");
        expect(t.status).toBe("neutral");
        expect(t.value).toBe("+ Add channel");
    });
    it("counts only channels with connected:true", () => {
        const s = Object.assign(base(), { channels: { a: { connected: true }, b: { connected: true }, c: null, d: { connected: false } } });
        expect(tileModel(s, "channels").value).toBe("2 connected");
    });
});

describe("tileModel — voice / theme / wakeWord", () => {
    it("voice green with name + backend secondary", () => {
        const t = tileModel(base(), "voice");
        expect(t.status).toBe("green");
        expect(t.value).toBe("Aoede");
        expect(t.secondary).toBe("gemini-live");
    });
    it("voice neutral with 'Decide later' when unset", () => {
        const s = Object.assign(base(), { voice: {} });
        expect(tileModel(s, "voice").value).toBe("Decide later");
    });
    it("theme green, shows current theme", () => {
        expect(tileModel(base(), "theme").value).toBe("dark");
    });
    it("wakeWord neutral when off", () => {
        expect(tileModel(base(), "wakeWord").status).toBe("neutral");
        expect(tileModel(base(), "wakeWord").value).toBe("Off");
    });
    it("wakeWord green when on, shows phrase", () => {
        const s = Object.assign(base(), { wakeWord: { enabled: true, phrase: "Hey Atlas" } });
        const t = tileModel(s, "wakeWord");
        expect(t.status).toBe("green");
        expect(t.value).toBe("Hey Atlas");
    });
});

describe("tileModel — unknown name + nullish state", () => {
    it("unknown name returns null", () => {
        expect(tileModel(base(), "mystery")).toBe(null);
    });
    it("nullish state does not throw (overlay tile handles)", () => {
        const t = tileModel(null, "overlay");
        expect(t.value).toBe("Alt+Space");
    });
});
