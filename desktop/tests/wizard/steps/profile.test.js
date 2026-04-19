// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "../../../wizard/steps/profile.js";

describe("profile step", () => {
    let calls;
    beforeEach(() => {
        calls = { saves: [], advances: 0, backs: 0, refreshes: 0 };
        window.atlas = {
            saveProfile: async (p) => { calls.saves.push(p); return { success: true }; },
        };
        document.body.innerHTML = ""; // jsdom reset
    });
    afterEach(() => { delete window.atlas; });

    it("renders name + tone fields with defaults", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { osUserName: "alice", profile: {} }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector("#prof-name").value).toBe("alice");
        expect(host.querySelector("#prof-tone").value).toBe("friendly");
    });

    it("pre-fills from existing profile over OS user name", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { osUserName: "alice", profile: { name: "Dheeraj", tone: "playful" } }, onAdvance: () => {}, onBack: () => {}, refreshState: async () => {} });
        expect(host.querySelector("#prof-name").value).toBe("Dheeraj");
        expect(host.querySelector("#prof-tone").value).toBe("playful");
    });

    it("Back invokes ctx.onBack", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { profile: {} }, onAdvance: () => {}, onBack: () => calls.backs++, refreshState: async () => {} });
        host.querySelector("#prof-back").click();
        expect(calls.backs).toBe(1);
    });

    it("Continue with empty name shows an error and does NOT save", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { profile: {} }, onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => calls.refreshes++ });
        host.querySelector("#prof-name").value = "   ";
        host.querySelector("#prof-next").click();
        await Promise.resolve();
        expect(host.querySelector("#prof-err").textContent).toBe("Please enter a name.");
        expect(calls.saves).toEqual([]);
        expect(calls.advances).toBe(0);
    });

    it("Continue with valid name invokes saveProfile → refreshState → onAdvance", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { profile: {} }, onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => calls.refreshes++ });
        host.querySelector("#prof-name").value = "Dheeraj";
        host.querySelector("#prof-tone").value = "professional";
        host.querySelector("#prof-next").click();
        await Promise.resolve(); await Promise.resolve();
        expect(calls.saves).toEqual([{ name: "Dheeraj", tone: "professional" }]);
        expect(calls.refreshes).toBe(1);
        expect(calls.advances).toBe(1);
    });

    it("saveProfile returning error surfaces it to the step-error element", async () => {
        window.atlas.saveProfile = async () => ({ success: false, error: "Disk full" });
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { profile: {} }, onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => {} });
        host.querySelector("#prof-name").value = "Dheeraj";
        host.querySelector("#prof-next").click();
        await Promise.resolve(); await Promise.resolve();
        expect(host.querySelector("#prof-err").textContent).toBe("Disk full");
        expect(calls.advances).toBe(0);
    });

    it("saveProfile throwing surfaces the error", async () => {
        window.atlas.saveProfile = async () => { throw new Error("IPC died"); };
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { profile: {} }, onAdvance: () => calls.advances++, onBack: () => {}, refreshState: async () => {} });
        host.querySelector("#prof-name").value = "Dheeraj";
        host.querySelector("#prof-next").click();
        await Promise.resolve(); await Promise.resolve();
        expect(host.querySelector("#prof-err").textContent).toMatch(/IPC died/);
        expect(calls.advances).toBe(0);
    });
});
