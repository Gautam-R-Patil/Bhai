// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import * as boot from "../../wizard/boot.js";

describe("decideInitialRoute", () => {
    it("empty step list → ready-hub", () => {
        expect(boot.decideInitialRoute([])).toEqual({ route: "ready-hub" });
    });
    it("non-empty → step 0", () => {
        expect(boot.decideInitialRoute(["welcome", "signin"])).toEqual({ route: "step", stepIndex: 0 });
    });
    it("nullish → ready-hub", () => {
        expect(boot.decideInitialRoute(null)).toEqual({ route: "ready-hub" });
        expect(boot.decideInitialRoute(undefined)).toEqual({ route: "ready-hub" });
    });
});

describe("renderDots", () => {
    it("applies 'active' to current and 'skipped' to non-included steps", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        const ALL = ["welcome", "signin", "profile", "install"];
        const active = ["profile", "install"];
        boot.renderDots(host, ALL, active, "profile", () => {});
        const dots = host.querySelectorAll(".step-dot");
        expect(dots.length).toBe(4);
        expect(dots[0].className).toMatch(/skipped/); // welcome not active
        expect(dots[1].className).toMatch(/skipped/); // signin not active
        expect(dots[2].className).toMatch(/active/);  // profile is current
        expect(dots[2].className).not.toMatch(/skipped/);
        expect(dots[3].className).not.toMatch(/skipped/);
        expect(dots[3].className).not.toMatch(/active/);
    });
    it("clicking an active dot invokes onDotClick with its index in activeSteps", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        const ALL = ["a", "b", "c"];
        const active = ["a", "c"];
        const clicks = [];
        boot.renderDots(host, ALL, active, "a", function (i) { clicks.push(i); });
        host.querySelectorAll(".step-dot")[2].click(); // "c"
        expect(clicks).toEqual([1]);
    });
    it("clicking a skipped dot is a no-op", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        const ALL = ["a", "b"];
        const active = ["a"];
        const clicks = [];
        boot.renderDots(host, ALL, active, "a", function (i) { clicks.push(i); });
        host.querySelectorAll(".step-dot")[1].click(); // "b" — skipped
        expect(clicks).toEqual([]);
    });
});

describe("renderChips", () => {
    it("renders one chip per entry with label + ✓", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        const chips = [
            { id: "google", label: "Google", stepTarget: "google" },
            { id: "telegram", label: "Telegram", stepTarget: "channels" },
        ];
        boot.renderChips(host, chips, () => {});
        const btns = host.querySelectorAll(".chip");
        expect(btns.length).toBe(2);
        expect(btns[0].textContent).toBe("Google \u2713");
        expect(btns[1].textContent).toBe("Telegram \u2713");
    });
    it("click invokes onChipClick with the chip object", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        const chips = [{ id: "x", label: "X", stepTarget: "s" }];
        const clicks = [];
        boot.renderChips(host, chips, function (c) { clicks.push(c); });
        host.querySelector(".chip").click();
        expect(clicks).toEqual(chips);
    });
    it("empty chip list renders zero buttons", () => {
        const host = document.createElement("div"); document.body.appendChild(host);
        boot.renderChips(host, [], () => {});
        expect(host.querySelectorAll(".chip").length).toBe(0);
    });
});

describe("clearChildren", () => {
    it("removes all children of the given element", () => {
        const host = document.createElement("div");
        host.appendChild(document.createElement("span"));
        host.appendChild(document.createElement("p"));
        boot.clearChildren(host);
        expect(host.firstChild).toBe(null);
    });
    it("handles nullish safely", () => {
        expect(() => boot.clearChildren(null)).not.toThrow();
    });
});
