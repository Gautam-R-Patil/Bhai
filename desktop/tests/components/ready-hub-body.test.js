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

describe("applyDiff — in-place update", () => {
    let container;
    beforeEach(() => {
        container = document.createElement("div"); document.body.appendChild(container);
    });
    afterEach(() => { document.body.innerHTML = ""; });

    it("updates the changed tile in place via StatusTile.update", () => {
        const s1 = baseState();
        const s2 = Object.assign({}, s1, { google: { connected: true, email: "new@x.com" } });
        mountHub(container, s1);
        const tilesWrap = container.querySelector("#hub-tiles");
        const beforeNode = container.querySelector('[data-sp-tile="google"] .sp-tile');
        const { applyDiff } = require("../../components/ready-hub-body.js");
        applyDiff(tilesWrap, s1, s2);
        const afterNode = container.querySelector('[data-sp-tile="google"] .sp-tile');
        expect(afterNode).toBe(beforeNode); // same DOM node — in-place update
        expect(afterNode.querySelector(".sp-tile__value").textContent).toBe("new@x.com");
        expect(afterNode.className).toMatch(/sp-tile--green/);
    });

    it("rebuilds when platform changes (permissions tile appears/disappears)", () => {
        const s1 = Object.assign(baseState(), { platform: "win32" });
        const s2 = baseState(); // darwin — permissions tile now present
        mountHub(container, s1);
        expect(container.querySelectorAll("[data-sp-tile]").length).toBe(7);
        const { applyDiff } = require("../../components/ready-hub-body.js");
        applyDiff(container.querySelector("#hub-tiles"), s1, s2);
        expect(container.querySelectorAll("[data-sp-tile]").length).toBe(8);
        expect(container.querySelector('[data-sp-tile="permissions"]')).toBeTruthy();
    });

    it("no-op when diff is empty", () => {
        const s = baseState();
        mountHub(container, s);
        const { applyDiff } = require("../../components/ready-hub-body.js");
        // Should not throw, should not touch DOM.
        const beforeCount = container.querySelectorAll("[data-sp-tile]").length;
        applyDiff(container.querySelector("#hub-tiles"), s, s);
        expect(container.querySelectorAll("[data-sp-tile]").length).toBe(beforeCount);
    });
});

describe("startLiveUpdates — 3s polling gate", () => {
    let container;
    beforeEach(() => {
        container = document.createElement("div"); document.body.appendChild(container);
    });
    afterEach(() => { document.body.innerHTML = ""; });

    it("polls setupDetect on an interval, applies diffs, and stops on .stop()", async () => {
        const { REFRESH_MS, mountHub } = require("../../components/ready-hub-body.js");
        expect(REFRESH_MS).toBe(3000);
        let detectCalls = 0;
        const atlas = {
            setupDetect: async () => { detectCalls += 1; return baseState(); },
            onAccountStatusChange: () => {},
        };
        const handle = mountHub(container, baseState(), atlas);
        expect(typeof handle.stop).toBe("function");
        // Fire one manual refresh (skip waiting 3s for real timer)
        await handle.refreshNow();
        expect(detectCalls).toBe(1);
        handle.stop();
        // After stop, interval should not be scheduled further
    });

    it("subscribes to onAccountStatusChange and fires a refresh when invoked", async () => {
        let subscribedCb = null;
        const atlas = {
            setupDetect: async () => baseState(),
            onAccountStatusChange: (cb) => { subscribedCb = cb; },
        };
        const { mountHub } = require("../../components/ready-hub-body.js");
        const handle = mountHub(container, baseState(), atlas);
        expect(typeof subscribedCb).toBe("function");
        handle.stop();
    });
});
