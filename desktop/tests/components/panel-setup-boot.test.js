// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../../components/tile-model.js";
import "../../components/status-tile.js";
import "../../components/diff-tiles.js";
import "../../components/try-this.js";
import "../../components/ready-hub-body.js";
import { mountSetupTab } from "../../components/panel-setup-boot.js";

function baseState() {
    return {
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
    };
}

describe("mountSetupTab (panel integration)", () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = "";
        root = document.createElement("div");
        root.id = "panel-hub-root";
        document.body.appendChild(root);
        window.atlas = {
            setupDetect: async () => baseState(),
            onAccountStatusChange: () => {},
        };
    });
    afterEach(() => {
        delete window.atlas;
        document.body.innerHTML = "";
    });

    it("does nothing when #panel-hub-root is absent", async () => {
        root.remove();
        await mountSetupTab();
        // No error; no DOM change.
        expect(document.body.innerHTML).toBe("");
    });

    it("mounts the hub body into #panel-hub-root on first call", async () => {
        await mountSetupTab();
        expect(root.querySelector(".hub-title")).toBeTruthy();
        expect(root.querySelectorAll("[data-sp-tile]").length).toBeGreaterThan(0);
    });

    it("is idempotent — second call does NOT re-mount", async () => {
        await mountSetupTab();
        const first = root.querySelector(".hub-title");
        await mountSetupTab();
        expect(root.querySelector(".hub-title")).toBe(first);
    });

    it("survives setupDetect rejection by rendering an error-state hub", async () => {
        window.atlas.setupDetect = async () => { throw new Error("broken"); };
        await mountSetupTab();
        // Still renders SOMETHING — even if tile models are mostly nulls.
        expect(root.children.length).toBeGreaterThan(0);
    });

    it("shows a fallback message when ReadyHubBody is unavailable", async () => {
        const saved = window.ReadyHubBody;
        delete window.ReadyHubBody;
        await mountSetupTab();
        expect(root.textContent).toMatch(/Ready Hub unavailable/);
        window.ReadyHubBody = saved;
    });
});
