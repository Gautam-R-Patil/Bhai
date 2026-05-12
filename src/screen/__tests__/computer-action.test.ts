// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { parseComputerAction, resolveCoord } from "../computer-action.js";
import type { ScreenDimensions } from "../screen-dimensions.js";

const primary: ScreenDimensions = {
    width: 1440,
    height: 900,
    scale: 2,
    monitorId: "mac-0",
    originX: 0,
    originY: 0,
};

describe("parseComputerAction — basic validation", () => {
    it("rejects non-object input", () => {
        expect(parseComputerAction(42).ok).toBe(false);
        expect(parseComputerAction(null).ok).toBe(false);
        expect(parseComputerAction(undefined).ok).toBe(false);
    });

    it("rejects missing action", () => {
        const r = parseComputerAction({});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("action");
    });

    it("parses JSON string input", () => {
        const r = parseComputerAction('{"action":"screenshot"}');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.action.action).toBe("screenshot");
    });

    it("rejects unknown action", () => {
        const r = parseComputerAction({ action: "delete_everything" });
        expect(r.ok).toBe(false);
    });
});

describe("parseComputerAction — click variants", () => {
    it("parses left click with percent coords", () => {
        const r = parseComputerAction({ action: "click", coord: [0.5, 0.5], coordSystem: "percent" });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "click") {
            expect(r.action.coord).toEqual([0.5, 0.5]);
            expect(r.action.button).toBe("left");
            expect(r.action.coordSystem).toBe("percent");
        }
    });

    it("parses right click", () => {
        const r = parseComputerAction({ action: "click", coord: [100, 100], coordSystem: "screen", button: "right" });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "click") expect(r.action.button).toBe("right");
    });

    it("rejects click without coord", () => {
        expect(parseComputerAction({ action: "click" }).ok).toBe(false);
    });

    it("rejects invalid button", () => {
        expect(parseComputerAction({ action: "click", coord: [0.5, 0.5], button: "explode" }).ok).toBe(false);
    });

    it("rejects image coords without imageWidth", () => {
        const r = parseComputerAction({ action: "click", coord: [100, 100], coordSystem: "image" });
        expect(r.ok).toBe(false);
    });

    it("accepts modifiers array", () => {
        const r = parseComputerAction({ action: "click", coord: [0.5, 0.5], modifiers: ["shift", "command"] });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "click") expect(r.action.modifiers).toEqual(["shift", "command"]);
    });
});

describe("parseComputerAction — drag / scroll / type / key / wait", () => {
    it("parses drag with multi-point path", () => {
        const r = parseComputerAction({
            action: "drag",
            path: [
                [0, 0],
                [100, 100],
                [200, 200],
            ],
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "drag") expect(r.action.path.length).toBe(3);
    });

    it("rejects drag with single point", () => {
        expect(parseComputerAction({ action: "drag", path: [[0, 0]] }).ok).toBe(false);
    });

    it("parses scroll with dy", () => {
        const r = parseComputerAction({ action: "scroll", coord: [0.5, 0.5], scrollDy: -120 });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "scroll") expect(r.action.scrollDy).toBe(-120);
    });

    it("rejects zero-velocity scroll", () => {
        expect(parseComputerAction({ action: "scroll", coord: [0.5, 0.5], scrollDx: 0, scrollDy: 0 }).ok).toBe(false);
    });

    it("parses type with text", () => {
        const r = parseComputerAction({ action: "type", text: "hello world" });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "type") expect(r.action.text).toBe("hello world");
    });

    it("rejects type with empty text", () => {
        expect(parseComputerAction({ action: "type", text: "" }).ok).toBe(false);
    });

    it("parses key combo", () => {
        const r = parseComputerAction({ action: "key", text: "ctrl+c" });
        expect(r.ok).toBe(true);
        if (r.ok && r.action.action === "key") expect(r.action.text).toBe("ctrl+c");
    });

    it("parses hold_key with duration", () => {
        const r = parseComputerAction({ action: "hold_key", text: "shift", durationMs: 1500 });
        expect(r.ok).toBe(true);
    });

    it("rejects hold_key without duration", () => {
        expect(parseComputerAction({ action: "hold_key", text: "shift" }).ok).toBe(false);
    });

    it("parses wait with explicit duration", () => {
        const r = parseComputerAction({ action: "wait", durationMs: 500 });
        expect(r.ok).toBe(true);
    });

    it("rejects wait > 60s (foot-gun guard)", () => {
        expect(parseComputerAction({ action: "wait", durationMs: 120000 }).ok).toBe(false);
    });
});

describe("resolveCoord — coordinate system handling", () => {
    it("resolves percent → screen point (with monitor offset)", async () => {
        const r = await resolveCoord([0.5, 0.5], { coordSystem: "percent" }, primary);
        expect(r.x).toBe(720);
        expect(r.y).toBe(450);
        expect(r.monitorId).toBe("mac-0");
    });

    it("resolves image → screen point", async () => {
        const r = await resolveCoord([640, 450], { coordSystem: "image", imageWidth: 1280 }, primary);
        expect(r.x).toBe(720);
        expect(r.y).toBe(506);
        expect(r.scaleFactor).toBeCloseTo(1.125, 3);
    });

    it("resolves screen → passthrough", async () => {
        const r = await resolveCoord([100, 200], { coordSystem: "screen" }, primary);
        expect(r.x).toBe(100);
        expect(r.y).toBe(200);
    });

    it("respects secondary-monitor origin via percent", async () => {
        const secondary: ScreenDimensions = { ...primary, monitorId: "mac-1", originX: 1440, originY: 0 };
        const r = await resolveCoord([0.5, 0.5], { coordSystem: "percent" }, secondary);
        expect(r.x).toBe(1440 + 720);
    });
});
