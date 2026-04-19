// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "../../../wizard/steps/permissions.js";

describe("permissions step", () => {
    let calls;
    let mountedGrids;

    beforeEach(() => {
        calls = { advances: 0, backs: 0, refreshes: 0 };
        mountedGrids = [];
        // Stub PermissionsGrid so we can observe mount + unmount
        class StubPermissionsGrid {
            constructor(props) { this.props = props || {}; mountedGrids.push(this); this.mounted = false; this.unmounted = false; }
            async mount(el) { this.mounted = true; this.el = el; return this; }
            unmount() { this.unmounted = true; }
        }
        window.SetupComponents = window.SetupComponents || {};
        window.SetupComponents.PermissionsGrid = StubPermissionsGrid;
        window.atlas = {
            setupPollPermissions: async () => ({ accessibility: "granted", screen: "unknown", microphone: "unknown", location: "unknown" }),
        };
        document.body.innerHTML = "";
    });

    afterEach(() => {
        delete window.atlas;
        delete window.SetupComponents.PermissionsGrid;
    });

    it("renders title, copy, and Back/Continue on macOS", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "darwin" }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector(".step-title").textContent).toBe("System permissions");
        expect(host.querySelector(".step-sub").textContent).toMatch(/Grant whatever you want/);
        expect(host.querySelector("#pm-back")).toBeTruthy();
        expect(host.querySelector("#pm-next")).toBeTruthy();
    });

    it("renders Windows-specific copy on win32", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "win32" }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector(".step-sub").textContent).toMatch(/Windows will prompt/);
    });

    it("mounts PermissionsGrid with the correct platform prop", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "darwin", permissions: { skipped: { location: true } } }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        await Promise.resolve(); await Promise.resolve();
        expect(mountedGrids.length).toBe(1);
        expect(mountedGrids[0].props.platform).toBe("darwin");
        expect(mountedGrids[0].props.skipped).toEqual({ location: true });
        expect(mountedGrids[0].mounted).toBe(true);
    });

    it("falls back when PermissionsGrid component is missing", () => {
        delete window.SetupComponents.PermissionsGrid;
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "darwin" }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector(".info-card")).toBeTruthy();
        expect(host.querySelector(".info-card").textContent).toMatch(/component unavailable/i);
    });

    it("Back unmounts the grid and invokes ctx.onBack", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "darwin" }, onAdvance: () => {}, onBack: () => calls.backs++, refreshState: async () => {} });
        await Promise.resolve();
        host.querySelector("#pm-back").click();
        expect(mountedGrids[0].unmounted).toBe(true);
        expect(calls.backs).toBe(1);
    });

    it("Continue unmounts grid, refreshes state, and advances", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "darwin" }, onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => calls.refreshes++ });
        await Promise.resolve();
        host.querySelector("#pm-next").click();
        await Promise.resolve(); await Promise.resolve();
        expect(mountedGrids[0].unmounted).toBe(true);
        expect(calls.refreshes).toBe(1);
        expect(calls.advances).toBe(1);
    });

    it("Continue is always enabled (skipping is allowed)", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { platform: "darwin", permissions: { accessibility: "denied" } }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector("#pm-next").disabled).toBe(false);
    });
});
