// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { resolveTheme, ThemeSwitch } from "../../components/theme-switch.js";

describe("resolveTheme", () => {
    it("explicit light/dark pass through", () => {
        expect(resolveTheme("light", "dark")).toBe("light");
        expect(resolveTheme("dark", "light")).toBe("dark");
    });
    it("system follows os preference", () => {
        expect(resolveTheme("system", "dark")).toBe("dark");
        expect(resolveTheme("system", "light")).toBe("light");
    });
    it("unknown pick defaults to OS preference", () => {
        expect(resolveTheme("weird", "dark")).toBe("dark");
    });
    it("unknown os preference defaults to light", () => {
        expect(resolveTheme("system", undefined)).toBe("light");
    });
});

describe("ThemeSwitch DOM", () => {
    it("throws when mounted without a container", () => {
        const s = new ThemeSwitch({});
        expect(() => s.mount(null)).toThrow(/container is required/);
    });

    it("renders three pills, marks the initial pick as active", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        new ThemeSwitch({ initial: "dark", osPreference: "light" }).mount(c);
        const pills = c.querySelectorAll("[data-sp-pick]");
        expect(pills.length).toBe(3);
        expect(pills[0].getAttribute("data-sp-pick")).toBe("light");
        expect(pills[1].getAttribute("data-sp-pick")).toBe("dark");
        expect(pills[2].getAttribute("data-sp-pick")).toBe("system");
        expect(pills[1].className).toMatch(/sp-theme__pill--active/);
        expect(pills[0].className).not.toMatch(/sp-theme__pill--active/);
    });

    it("click flips active pill and dispatches theme-change event", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const s = new ThemeSwitch({ initial: "light", osPreference: "dark" });
        s.mount(c);
        const events = [];
        const listener = (e) => events.push(e.detail);
        document.addEventListener("theme-change", listener);
        const darkPill = c.querySelector('[data-sp-pick="dark"]');
        darkPill.click();
        document.removeEventListener("theme-change", listener);
        expect(events).toEqual([{ pick: "dark", resolved: "dark" }]);
        expect(darkPill.className).toMatch(/sp-theme__pill--active/);
        expect(c.querySelector('[data-sp-pick="light"]').className).not.toMatch(/sp-theme__pill--active/);
        s.unmount();
    });

    it("system pick resolves via osPreference in the event detail", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const s = new ThemeSwitch({ initial: "light", osPreference: "dark" });
        s.mount(c);
        const events = [];
        document.addEventListener("theme-change", (e) => events.push(e.detail));
        c.querySelector('[data-sp-pick="system"]').click();
        expect(events).toEqual([{ pick: "system", resolved: "dark" }]);
        s.unmount();
    });

    it("onChange callback fires with {pick,resolved}", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const changes = [];
        const s = new ThemeSwitch({ initial: "light", osPreference: "light", onChange: (v) => changes.push(v) });
        s.mount(c);
        c.querySelector('[data-sp-pick="dark"]').click();
        expect(changes).toEqual([{ pick: "dark", resolved: "dark" }]);
        s.unmount();
    });

    it("getValue returns current pick", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const s = new ThemeSwitch({ initial: "system" });
        s.mount(c);
        expect(s.getValue()).toBe("system");
        c.querySelector('[data-sp-pick="light"]').click();
        expect(s.getValue()).toBe("light");
        s.unmount();
    });

    it("unmount detaches root element", () => {
        const c = document.createElement("div"); document.body.appendChild(c);
        const s = new ThemeSwitch({});
        s.mount(c);
        s.unmount();
        expect(c.firstElementChild).toBe(null);
    });
});
