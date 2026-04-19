// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "../../../wizard/steps/welcome.js";

describe("welcome step", () => {
    beforeEach(() => { document.body.innerHTML = ""; });
    it("shows 'Welcome to A.T.L.A.S' for fresh install", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { isReconfigure: false }, onAdvance: () => {} });
        expect(host.querySelector(".step-title").textContent).toBe("Welcome to A.T.L.A.S");
    });
    it("shows 'Reconfigure A.T.L.A.S' when reconfiguring", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        render(host, { state: { isReconfigure: true }, onAdvance: () => {} });
        expect(host.querySelector(".step-title").textContent).toBe("Reconfigure A.T.L.A.S");
        expect(host.querySelector(".step-sub").textContent).toMatch(/preserved/);
    });
    it("Get Started button calls ctx.onAdvance", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        const advances = [];
        render(host, { state: {}, onAdvance: () => advances.push(1) });
        host.querySelector("#welcome-cta").click();
        expect(advances).toEqual([1]);
    });
});
