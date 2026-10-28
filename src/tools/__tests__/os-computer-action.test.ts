// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import {
    buildMacMouseJxa,
    macKeyScript,
    osComputerAction,
    xdotoolCombo,
    ydotoolKeyArgs,
} from "../os-computer-action.js";

describe("key names map to real keys on every platform", () => {
    it("macOS: named keys are key codes, unknown names are errors (never typed as words)", () => {
        expect(macKeyScript("home")).toBe('tell application "System Events" to key code 115');
        expect(macKeyScript("f5")).toContain("key code 96");
        expect(macKeyScript("cmd+shift+s")).toBe('tell application "System Events" to keystroke "s" using {command down, shift down}');
        expect(macKeyScript("cmd+enter")).toContain("key code 36 using {command down}");
        expect(macKeyScript("cmd++")).toContain('keystroke "+" using {command down}');
        expect(() => macKeyScript("homepage")).toThrow(/Unknown key/);
        expect(() => macKeyScript("fn+a")).toThrow(/Unknown modifier/);
    });

    it("Linux: xdotool keysyms and ydotool key codes", () => {
        expect(xdotoolCombo("enter")).toBe("Return");
        expect(xdotoolCombo("ctrl+pageup")).toBe("ctrl+Prior");
        expect(xdotoolCombo("cmd+F4")).toBe("super+F4");
        expect(() => xdotoolCombo("enterr")).toThrow(/Unknown key/);
        expect(ydotoolKeyArgs("ctrl+c")).toEqual(["29:1", "46:1", "46:0", "29:0"]);
        expect(ydotoolKeyArgs("enter")).toEqual(["28:1", "28:0"]);
    });
});

describe("mouse buttons and modifiers are sent, not dropped", () => {
    it("shift-click carries the shift flag on down/up", () => {
        const js = buildMacMouseJxa("click", 10, 20, "left", ["shift"]);
        expect(js).toContain("$.CGEventSetFlags(e,131072)");
        expect(js).toContain("post(1,0,1,1)");
    });

    it("middle click uses the other-mouse events; triple click sends three", () => {
        expect(buildMacMouseJxa("click", 1, 1, "middle")).toContain("post(25,2,1,1)");
        expect(buildMacMouseJxa("triple_click", 1, 1).match(/post\(1,0,\d,1\)/g)).toHaveLength(3);
    });
});

describe("os_computer_action — input validation (no OS dispatch)", () => {
    it("rejects empty input", async () => {
        const result = JSON.parse(await osComputerAction.handler({} as any));
        expect(result.success).toBe(false);
        expect(result.error).toContain("action");
    });

    it("rejects unknown action", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "delete_everything" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects click without coord", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "click" } as any));
        expect(result.success).toBe(false);
        expect(result.error).toContain("coord");
    });

    it("rejects click with invalid coord shape", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "click", coord: "0.5,0.5" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects click with invalid button", async () => {
        const result = JSON.parse(
            await osComputerAction.handler({ action: "click", coord: [0.5, 0.5], button: "explode" } as any),
        );
        expect(result.success).toBe(false);
    });

    it("rejects drag with single point", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "drag", path: [[0.1, 0.1]] } as any));
        expect(result.success).toBe(false);
    });

    it("rejects scroll with zero velocity", async () => {
        const result = JSON.parse(
            await osComputerAction.handler({ action: "scroll", coord: [0.5, 0.5], scrollDx: 0, scrollDy: 0 } as any),
        );
        expect(result.success).toBe(false);
    });

    it("rejects type with empty text", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "type", text: "" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects hold_key without duration", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "hold_key", text: "shift" } as any));
        expect(result.success).toBe(false);
    });

    it("rejects wait beyond 60s (foot-gun guard)", async () => {
        const result = JSON.parse(await osComputerAction.handler({ action: "wait", durationMs: 120_000 } as any));
        expect(result.success).toBe(false);
    });
});
