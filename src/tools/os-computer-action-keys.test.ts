// © 2024-2026 XAGI Labs Private Limited
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
    cropToRect,
    macKeyScript,
    splitCombo,
    xdotoolCombo,
    xdotoolHoldKeySpec,
    xdotoolKeySpec,
    ydotoolKeyArgs,
} from "./os-computer-action.js";

describe("xdotool key names", () => {
    it("accepts real keysyms and punctuation", () => {
        expect(xdotoolCombo("ctrl+minus")).toBe("ctrl+minus");
        expect(xdotoolCombo("ctrl+-")).toBe("ctrl+minus");
        expect(xdotoolCombo("ctrl+/")).toBe("ctrl+slash");
        expect(xdotoolCombo("ctrl+plus")).toBe("ctrl+plus");
        expect(xdotoolCombo("ctrl++")).toBe("ctrl+plus");
        expect(xdotoolCombo("Print")).toBe("Print");
        expect(xdotoolCombo("XF86AudioMute")).toBe("XF86AudioMute");
        expect(xdotoolCombo("Page_Down")).toBe("Page_Down");
        expect(xdotoolCombo("f13")).toBe("F13");
        expect(xdotoolCombo("ctrl+enter")).toBe("ctrl+Return");
        expect(xdotoolKeySpec(" ")).toBe("space");
    });
    it("keeps keysym case under modifiers", () => {
        expect(xdotoolCombo("ctrl+Page_Down")).toBe("ctrl+Page_Down");
        expect(xdotoolCombo("shift+XF86AudioRaiseVolume")).toBe("shift+XF86AudioRaiseVolume");
        expect(xdotoolCombo("ctrl+KP_Add")).toBe("ctrl+KP_Add");
        expect(xdotoolCombo("Ctrl+Enter")).toBe("ctrl+Return");
        expect(ydotoolKeyArgs("ctrl+Enter")).toEqual(["29:1", "28:1", "28:0", "29:0"]);
        expect(macKeyScript("cmd+Enter")).toContain("key code 36");
    });
    it("still rejects lowercase junk", () => {
        expect(() => xdotoolCombo("pgdn")).toThrow(/Unknown key/);
    });
    it("rejects capitalized names that are not real keysyms (xdotool would silently no-op)", () => {
        for (const bad of ["Del", "PgDn", "Pgup", "Esc_Key", "XF86AudioMutee", "Foo", "F36"])
            expect(() => xdotoolKeySpec(bad), bad).toThrow(/Unknown key/);
        expect(() => xdotoolCombo("ctrl+PgDn")).toThrow(/Unknown key/);
    });
    it("accepts known keysyms in any case and F1-F35", () => {
        expect(xdotoolKeySpec("page_down")).toBe("Page_Down");
        expect(xdotoolKeySpec("KP_Enter")).toBe("KP_Enter");
        expect(xdotoolKeySpec("xf86audioraisevolume")).toBe("XF86AudioRaiseVolume");
        expect(xdotoolKeySpec("ISO_Left_Tab")).toBe("ISO_Left_Tab");
        expect(xdotoolKeySpec("F35")).toBe("F35");
        expect(xdotoolKeySpec("f25")).toBe("F25");
    });
});

describe("case and spacing", () => {
    it("keeps a lone key's case", () => {
        expect(xdotoolCombo("Y")).toBe("Y");
        expect(macKeyScript("Y")).toContain('keystroke "Y"');
        expect(ydotoolKeyArgs("Y")).toEqual(["42:1", "21:1", "21:0", "42:0"]);
        expect(xdotoolCombo("ctrl+A")).toBe("ctrl+a");
        expect(macKeyScript("Enter")).toContain("key code 36");
    });
    it("space key", () => {
        expect(splitCombo(" ")).toEqual({ mods: [], key: "space" });
        expect(xdotoolCombo(" ")).toBe("space");
    });
    it("spaced plus combo presses plus, trailing + throws", () => {
        expect(splitCombo("ctrl + +")).toEqual({ mods: ["ctrl"], key: "+" });
        expect(xdotoolCombo("ctrl + +")).toBe("ctrl+plus");
        expect(splitCombo("++")).toEqual({ mods: [], key: "+" });
        expect(splitCombo("+ +")).toEqual({ mods: [], key: "+" });
        expect(() => xdotoolCombo("cmd+shift+")).toThrow(/Malformed/);
        expect(() => ydotoolKeyArgs("ctrl++a")).toThrow(/Malformed/);
    });
});

describe("cropToRect", () => {
    it("crops a two-monitor shot to the right monitor", async () => {
        const full = await sharp({ create: { width: 400, height: 100, channels: 3, background: "#000" } })
            .png()
            .toBuffer();
        const out = await cropToRect(full, { x: 200, y: 0, w: 200, h: 100 });
        const m = await sharp(out as Buffer).metadata();
        expect([m.width, m.height]).toEqual([200, 100]);
        expect(await cropToRect(full, { x: 300, y: 0, w: 200, h: 100 })).toBeNull();
    });
    it("scaled (Wayland) frame: whole frame when it is the monitor's shape, never a sub-crop", async () => {
        const hidpi = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#000" } })
            .png()
            .toBuffer();
        // 2x-scaled single monitor: logical 200x100 at 0,0 fits, but cropping would take the top-left quarter.
        expect(await cropToRect(hidpi, { x: 0, y: 0, w: 200, h: 100 }, true)).toBe(hidpi);
        expect(await cropToRect(hidpi, { x: 0, y: 0, w: 100, h: 100 }, true)).toBeNull();
    });
});

describe("hold_key on X11", () => {
    it("holds exactly the named key, never adding shift", () => {
        expect(xdotoolHoldKeySpec("W")).toBe("w");
        expect(xdotoolHoldKeySpec("w")).toBe("w");
        expect(xdotoolHoldKeySpec("shift")).toBe("shift");
        expect(xdotoolHoldKeySpec("Page_Down")).toBe("Page_Down");
        expect(() => xdotoolHoldKeySpec("Del")).toThrow(/Unknown key/);
    });
});
