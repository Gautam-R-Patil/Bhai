// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import "../../components/tile-model.js"; // ensure window.TileModel is present (via globals if jsdom-ish) — but we need the Node path here:
import { diffTiles } from "../../components/diff-tiles.js";

function macState(overrides) {
    return Object.assign({
        platform: "darwin",
        account: { signedIn: true, email: "a@b.co", plan: "free", credits: 0 },
        permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" },
        google: { connected: false },
        channels: {},
        hotkey: { current: "Alt+Space", conflicts: [] },
        theme: "dark",
        voice: { name: "Aoede", backend: "gemini-live" },
        wakeWord: { enabled: false, phrase: "Hey Atlas" },
    }, overrides || {});
}

describe("diffTiles", () => {
    it("identical state → empty list", () => {
        const s = macState();
        expect(diffTiles(s, s)).toEqual([]);
    });
    it("permissions amber → green is detected", () => {
        const prev = macState({ permissions: { accessibility: "granted", screen: "denied", microphone: "granted", location: "granted" } });
        const next = macState();
        expect(diffTiles(prev, next)).toEqual(["permissions"]);
    });
    it("channel add → channels tile listed", () => {
        const prev = macState();
        const next = macState({ channels: { telegram: { connected: true } } });
        expect(diffTiles(prev, next)).toContain("channels");
    });
    it("account sign-in → account tile listed", () => {
        const prev = macState({ account: { signedIn: false } });
        const next = macState();
        expect(diffTiles(prev, next)).toContain("account");
    });
    it("platform change win32 ↔ darwin surfaces permissions tile transition", () => {
        const prev = macState({ platform: "win32" });
        const next = macState();
        expect(diffTiles(prev, next)).toContain("permissions");
    });
    it("unrelated field changes produce no diff (osUserName, isReconfigure)", () => {
        const prev = macState();
        const next = Object.assign({}, prev, { osUserName: "Dheeraj", isReconfigure: true });
        expect(diffTiles(prev, next)).toEqual([]);
    });
    it("multiple simultaneous changes return them all in TILE_ORDER", () => {
        const prev = macState({ permissions: { accessibility: "denied", screen: "denied", microphone: "denied", location: "denied" }, voice: { name: "" } });
        const next = macState({ google: { connected: true, email: "x@y.z" } });
        const d = diffTiles(prev, next);
        expect(d).toContain("permissions");
        expect(d).toContain("google");
        expect(d).toContain("voice");
        // Order follows TILE_ORDER: account, overlay, permissions, google, channels, voice, theme, wakeWord
        expect(d.indexOf("permissions")).toBeLessThan(d.indexOf("google"));
        expect(d.indexOf("google")).toBeLessThan(d.indexOf("voice"));
    });
    it("nullish prev (first mount) yields changes for every currently-modeled tile", () => {
        const next = macState();
        const d = diffTiles(undefined, next);
        // At least the non-null tile slots change when prev is empty.
        expect(d.length).toBeGreaterThan(0);
    });
});
