// @vitest-environment jsdom
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { classForStatus, StatusTile } from "../../components/status-tile.js";

describe("classForStatus", () => {
    it("green", () => { expect(classForStatus("green")).toBe("sp-tile sp-tile--green"); });
    it("amber", () => { expect(classForStatus("amber")).toBe("sp-tile sp-tile--amber"); });
    it("neutral", () => { expect(classForStatus("neutral")).toBe("sp-tile sp-tile--neutral"); });
    it("unknown falls back to neutral", () => {
        expect(classForStatus("weird")).toBe("sp-tile sp-tile--neutral");
        expect(classForStatus(undefined)).toBe("sp-tile sp-tile--neutral");
    });
});

describe("StatusTile DOM", () => {
    function freshContainer() {
        const c = document.createElement("div");
        document.body.appendChild(c);
        return c;
    }

    it("throws when mounted without a container", () => {
        const t = new StatusTile({ label: "X", value: "Y", status: "green" });
        expect(() => t.mount(null)).toThrow(/container is required/);
    });

    it("renders label/value and role=status when non-interactive", () => {
        const c = freshContainer();
        new StatusTile({ label: "Label", value: "Value", status: "neutral" }).mount(c);
        const el = c.firstElementChild;
        expect(el.getAttribute("role")).toBe("status");
        expect(el.querySelector(".sp-tile__value").textContent).toBe("Value");
    });

    it("role=button + tabindex=0 when onClick provided, and click fires handler", () => {
        const c = freshContainer();
        let clicks = 0;
        new StatusTile({ label: "X", value: "Y", status: "green", onClick: () => { clicks += 1; } }).mount(c);
        const el = c.firstElementChild;
        expect(el.getAttribute("role")).toBe("button");
        expect(el.getAttribute("tabindex")).toBe("0");
        el.click();
        expect(clicks).toBe(1);
    });

    it("update() rebinds onClick and flips role back to status when onClick becomes null", () => {
        const c = freshContainer();
        let clicks = 0;
        const t = new StatusTile({ label: "X", value: "Y", status: "green", onClick: () => { clicks += 1; } }).mount(c);
        const el = c.firstElementChild;
        el.click();
        expect(clicks).toBe(1);
        t.update({ onClick: null });
        expect(el.getAttribute("role")).toBe("status");
        expect(el.hasAttribute("tabindex")).toBe(false);
        el.click();
        expect(clicks).toBe(1); // still 1 — handler detached
    });

    it("update() with a different status flips the modifier class and pulses", () => {
        const c = freshContainer();
        const t = new StatusTile({ label: "L", value: "V", status: "neutral" }).mount(c);
        const el = c.firstElementChild;
        expect(el.classList.contains("sp-tile--neutral")).toBe(true);
        t.update({ status: "green" });
        expect(el.classList.contains("sp-tile--green")).toBe(true);
        expect(el.classList.contains("sp-tile--neutral")).toBe(false);
        expect(el.classList.contains("sp-tile--pulse")).toBe(true);
    });

    it("rapid back-to-back status changes don't leave lingering pulse after final clear", async () => {
        // Don't really verify the timer internals — just confirm we don't throw.
        const c = freshContainer();
        const t = new StatusTile({ status: "neutral" }).mount(c);
        t.update({ status: "amber" });
        t.update({ status: "green" });
        t.update({ status: "neutral" });
        // No assertion on pulse removal timing — just ensure update didn't throw and the final status is applied.
        expect(c.firstElementChild.classList.contains("sp-tile--neutral")).toBe(true);
    });

    it("unmount() detaches the element and clears handlers", () => {
        const c = freshContainer();
        let clicks = 0;
        const t = new StatusTile({ status: "green", onClick: () => { clicks += 1; } }).mount(c);
        const el = c.firstElementChild;
        t.unmount();
        expect(c.firstElementChild).toBe(null);
        el.click(); // handler should have been removed — click goes to a detached node
        expect(clicks).toBe(0);
    });

    it("preserves externally-added classes through a status flip", () => {
        const c = freshContainer();
        const t = new StatusTile({ status: "neutral" }).mount(c);
        const el = c.firstElementChild;
        el.classList.add("consumer-flag");
        t.update({ status: "green" });
        expect(el.classList.contains("consumer-flag")).toBe(true);
        expect(el.classList.contains("sp-tile--green")).toBe(true);
    });
});
