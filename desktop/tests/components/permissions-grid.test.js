// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    prefPaneUrlFor,
    PermissionsGrid,
    isPermissionEffectivelyOk,
} from "../../components/permissions-grid.js";

describe("prefPaneUrlFor", () => {
    it("accessibility", () => { expect(prefPaneUrlFor("accessibility")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"); });
    it("screen",        () => { expect(prefPaneUrlFor("screen")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"); });
    it("microphone",    () => { expect(prefPaneUrlFor("microphone")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"); });
    it("location",      () => { expect(prefPaneUrlFor("location")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"); });
    it("unknown → null", () => {
        expect(prefPaneUrlFor("bluetooth")).toBeNull();
        expect(prefPaneUrlFor(undefined)).toBeNull();
    });
});

describe("isPermissionEffectivelyOk", () => {
    it("granted + not skipped → green", () => { expect(isPermissionEffectivelyOk("granted", false)).toBe("green"); });
    it("skipped → amber regardless of status", () => {
        expect(isPermissionEffectivelyOk("denied", true)).toBe("amber");
        expect(isPermissionEffectivelyOk("granted", true)).toBe("amber");
    });
    it("denied or unknown + not skipped → neutral", () => {
        expect(isPermissionEffectivelyOk("denied", false)).toBe("neutral");
        expect(isPermissionEffectivelyOk("unknown", false)).toBe("neutral");
    });
});

describe("PermissionsGrid — Windows path", () => {
    it("renders a single info card on non-darwin", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "win32" });
        await g.mount(c);
        expect(c.textContent).toMatch(/Windows handles permissions at runtime/);
        // No polling on non-darwin
        expect(g._timer).toBeNull();
        g.unmount();
    });
});

describe("PermissionsGrid — macOS path", () => {
    let atlasCalls;
    beforeEach(() => {
        atlasCalls = { requests: [], skips: [], pollCount: 0, pollResult: { accessibility: "granted", screen: "denied", microphone: "unknown", location: "unknown" } };
        window.atlas = {
            setupPollPermissions: async () => { atlasCalls.pollCount += 1; return atlasCalls.pollResult; },
            setupRequestPermission: async (name) => { atlasCalls.requests.push(name); return { ok: true }; },
            setupMarkPermissionSkipped: async (name, skipped) => { atlasCalls.skips.push({ name, skipped }); return { ok: true }; },
        };
    });
    afterEach(() => { delete window.atlas; });

    it("renders four permission cards + a pill per card", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin" });
        await g.mount(c);
        expect(c.querySelectorAll(".sp-perm").length).toBe(4);
        expect(c.querySelectorAll("[data-sp-pill]").length).toBe(4);
        g.unmount();
    });

    it("populates pills from setupPollPermissions on mount", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin" });
        await g.mount(c);
        const accPill = c.querySelector(".sp-perm:nth-child(1) [data-sp-pill]");
        const screenPill = c.querySelector(".sp-perm:nth-child(2) [data-sp-pill]");
        expect(accPill.textContent).toBe("Granted");
        expect(screenPill.textContent).toBe("Denied");
        g.unmount();
    });

    it("Grant button calls setupRequestPermission with the right key", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin" });
        await g.mount(c);
        c.querySelector(".sp-perm:nth-child(3) [data-sp-grant]").click();
        expect(atlasCalls.requests).toEqual(["microphone"]);
        g.unmount();
    });

    it("Skip button collapses card + calls setupMarkPermissionSkipped(name, true)", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin" });
        await g.mount(c);
        c.querySelector(".sp-perm:nth-child(4) [data-sp-skip]").click();
        expect(atlasCalls.skips).toEqual([{ name: "location", skipped: true }]);
        expect(c.querySelector(".sp-perm:nth-child(4) [data-sp-perm-skipped]")).toBeTruthy();
        expect(c.querySelector(".sp-perm:nth-child(4) [data-sp-grant]")).toBeNull();
        g.unmount();
    });

    it("Un-skip restores the normal card and notifies", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin", skipped: { location: true } });
        await g.mount(c);
        // Card starts in skipped layout
        expect(c.querySelector(".sp-perm:nth-child(4) [data-sp-perm-skipped]")).toBeTruthy();
        c.querySelector(".sp-perm:nth-child(4) .sp-perm__skipped button").click();
        expect(atlasCalls.skips).toEqual([{ name: "location", skipped: false }]);
        expect(c.querySelector(".sp-perm:nth-child(4) [data-sp-grant]")).toBeTruthy();
        g.unmount();
    });

    it("unmount() stops the polling interval", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin" });
        await g.mount(c);
        const before = atlasCalls.pollCount;
        g.unmount();
        expect(g._timer).toBeNull();
        // After unmount, no more polls even after a tick
        await new Promise((r) => setTimeout(r, 1100));
        expect(atlasCalls.pollCount).toBe(before);
    });

    it("getSkipped returns the current skipped map", async () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const g = new PermissionsGrid({ platform: "darwin", skipped: { microphone: true } });
        await g.mount(c);
        expect(g.getSkipped()).toEqual({ microphone: true });
        g.unmount();
    });
});
