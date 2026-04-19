// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "../../../wizard/steps/signin.js";

describe("signin step", () => {
    let atlas, calls, authHandlers;
    beforeEach(() => {
        document.body.innerHTML = "";
        calls = { openAuthWindow: 0, refreshState: 0, advances: 0 };
        authHandlers = [];
        atlas = {
            openAuthWindow: async () => { calls.openAuthWindow += 1; },
            onAccountStatusChange: (handler) => { authHandlers.push(handler); },
        };
        window.atlas = atlas;
    });
    afterEach(() => { delete window.atlas; });

    it("renders the sign-in button and status", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => calls.advances++, refreshState: async () => calls.refreshState++ });
        expect(host.querySelector("#signin-btn").textContent).toMatch(/Sign in/);
        expect(host.querySelector("#signin-status").textContent).toBe("");
    });

    it("clicking the button disables it and invokes openAuthWindow", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => calls.advances++, refreshState: async () => calls.refreshState++ });
        host.querySelector("#signin-btn").click();
        await Promise.resolve(); await Promise.resolve();
        expect(calls.openAuthWindow).toBe(1);
        expect(host.querySelector("#signin-btn").disabled).toBe(true);
    });

    it("openAuthWindow rejection surfaces the error and re-enables the button", async () => {
        window.atlas.openAuthWindow = async () => { throw new Error("popup blocked"); };
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => {}, refreshState: async () => {} });
        host.querySelector("#signin-btn").click();
        await Promise.resolve(); await Promise.resolve();
        expect(host.querySelector("#signin-status").textContent).toMatch(/Could not open auth window/);
        expect(host.querySelector("#signin-btn").disabled).toBe(false);
    });

    it("onAccountStatusChange(signedIn:true) auto-advances and refreshes state", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => calls.advances++, refreshState: async () => calls.refreshState++ });
        expect(authHandlers.length).toBe(1);
        await authHandlers[0]({ signedIn: true, email: "a@b.com" });
        expect(calls.refreshState).toBe(1);
        expect(calls.advances).toBe(1);
        expect(host.querySelector("#signin-status").textContent).toBe("Signed in ✓");
    });

    it("auto-advance is one-shot — second signed-in event is ignored", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => calls.advances++, refreshState: async () => calls.refreshState++ });
        await authHandlers[0]({ signedIn: true });
        await authHandlers[0]({ signedIn: true });
        expect(calls.advances).toBe(1);
    });

    it("signedIn:false event is a no-op", async () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: {}, onAdvance: () => calls.advances++, refreshState: async () => {} });
        await authHandlers[0]({ signedIn: false });
        expect(calls.advances).toBe(0);
    });
});
