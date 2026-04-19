// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Load tile-model first so renderTiles can find window.TileModel.
import "../../components/tile-model.js";
import "../../components/status-tile.js";
import { renderHubBody, mountHub } from "../../components/ready-hub-body.js";

const baseState = () => ({
    platform: "darwin",
    osUserName: "Dheeraj",
    account: { signedIn: true, email: "a@b.co", plan: "pro", credits: 1000 },
    permissions: { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" },
    google: { connected: false },
    channels: {},
    hotkey: { current: "Alt+Space", conflicts: [] },
    theme: "dark",
    voice: { name: "Aoede", backend: "gemini-live" },
    wakeWord: { enabled: false, phrase: "Hey Atlas" },
});

describe("renderHubBody", () => {
    beforeEach(() => { document.body.innerHTML = ""; });
    it("returns a DOM node with title, subtitle, tiles container, try-this container", () => {
        const body = renderHubBody(baseState());
        expect(body.querySelector(".hub-title").textContent).toBe("Ready to go");
        expect(body.querySelector(".hub-sub").textContent).toMatch(/Dheeraj/);
        expect(body.querySelector("#hub-tiles")).toBeTruthy();
        expect(body.querySelector("#hub-try-this")).toBeTruthy();
    });
    it("omits the name when osUserName is missing", () => {
        const s = baseState(); delete s.osUserName;
        const body = renderHubBody(s);
        expect(body.querySelector(".hub-sub").textContent).not.toMatch(/, /);
    });
});

describe("mountHub — tile rendering via tile-model + StatusTile", () => {
    let container;
    beforeEach(() => {
        container = document.createElement("div"); document.body.appendChild(container);
    });
    afterEach(() => { document.body.innerHTML = ""; });

    it("renders one StatusTile per model slot on macOS (8 tiles)", () => {
        mountHub(container, baseState());
        const tiles = container.querySelectorAll("[data-sp-tile]");
        expect(tiles.length).toBe(8);
        // Sample the account tile
        const acct = container.querySelector('[data-sp-tile="account"] .sp-tile');
        expect(acct).toBeTruthy();
        expect(acct.querySelector(".sp-tile__value").textContent).toBe("a@b.co");
        expect(acct.className).toMatch(/sp-tile--green/);
    });

    it("omits the permissions tile on non-darwin", () => {
        const s = baseState(); s.platform = "win32";
        mountHub(container, s);
        const tiles = container.querySelectorAll("[data-sp-tile]");
        expect(tiles.length).toBe(7); // 8 minus permissions
        expect(container.querySelector('[data-sp-tile="permissions"]')).toBe(null);
    });

    it("channels tile shows neutral '+ Add channel' when no channel connected", () => {
        mountHub(container, baseState());
        const ch = container.querySelector('[data-sp-tile="channels"] .sp-tile');
        expect(ch.className).toMatch(/sp-tile--neutral/);
        expect(ch.querySelector(".sp-tile__value").textContent).toBe("+ Add channel");
    });

    it("re-mount replaces previous content (no stale tiles)", () => {
        mountHub(container, baseState());
        expect(container.querySelectorAll("[data-sp-tile]").length).toBe(8);
        const s = baseState(); s.platform = "win32";
        mountHub(container, s);
        expect(container.querySelectorAll("[data-sp-tile]").length).toBe(7);
    });

    it("does nothing when container is null (does not throw)", () => {
        expect(() => mountHub(null, baseState())).not.toThrow();
    });
});
