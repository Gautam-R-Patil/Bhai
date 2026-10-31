// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: null, out: string) => void) => {
        calls.push([cmd, ...args]);
        cb(null, "");
    }),
}));

const dims = { width: 1920, height: 1080, scale: 1, monitorId: "m1", originX: 0, originY: 0 };
vi.mock("../../screen/screen-dimensions.js", async (orig) => ({
    ...(await orig<typeof import("../../screen/screen-dimensions.js")>()),
    getScreenDimensions: vi.fn(async () => dims),
}));

const { linuxOsClick } = await import("../linux.js");
const { executeStructuredAction } = await import("../os-computer-action.js");

const realPlatform = process.platform;
const realWayland = process.env.WAYLAND_DISPLAY;
beforeAll(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.WAYLAND_DISPLAY = "wayland-0";
});
afterAll(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    if (realWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = realWayland;
});
beforeEach(() => {
    calls.length = 0;
});

const ydoClicks = () => calls.filter((c) => c[0] === "ydotool" && c[1] === "click").map((c) => c.slice(2));

describe("Wayland os_click sends full down+up ydotool button codes", () => {
    it.each([
        ["click", [["0xC0"]]],
        ["double_click", [["0xC0", "0xC0"]]],
        ["right_click", [["0xC1"]]],
    ])("%s", async (action, expected) => {
        const out = JSON.parse(await linuxOsClick.handler({ x: 10, y: 20, raw: true, action }));
        expect(out.success).toBe(true);
        expect(ydoClicks()).toEqual(expected);
    });
});

describe("Wayland scroll turns the wheel instead of sending inert click codes", () => {
    it("scrolls down 3 ticks", async () => {
        await executeStructuredAction(
            { action: "scroll", coord: [100, 200], coordSystem: "screen", scrollDy: 120 },
            dims,
        );
        expect(ydoClicks()).toEqual([]);
        expect(calls).toContainEqual(["ydotool", "mousemove", "--wheel", "-x", "0", "-y", "-3"]);
    });
});
