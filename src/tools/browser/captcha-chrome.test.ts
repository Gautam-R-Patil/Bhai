// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// The Chrome-extension CAPTCHA driver: widget-frame rects land on the page (a scaled
// iframe included), and a click or a whole drag is one trusted mouse_path gesture.

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { type: string; payload: Record<string, unknown> }[] = [];
let frames: unknown[] = [];
vi.mock("./chrome-bridge.js", () => ({
    sendBridgeCommand: vi.fn(async (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload });
        return type === "captcha_frames" ? frames : { success: true };
    }),
}));
vi.mock("../../llm.js", () => ({ MODELS: { SONNET: "sonnet" } }));

const { chromeDriver } = await import("./captcha-chrome.js");
const page = { evaluate: vi.fn() };
const gestures = () =>
    sent
        .filter((c) => c.type === "mouse_path")
        .map((c) => c.payload.events as { type: string; x: number; y: number; buttons: number }[]);

beforeEach(() => {
    sent.length = 0;
});

describe("chromeDriver", () => {
    it("maps the challenge frame's tiles onto the page, scaling a shrunk iframe", async () => {
        // The frame lays out at 400px wide but the iframe shows it at 200px, from (100, 50).
        frames = [
            {
                kind: "challenge",
                vw: 400,
                tiles: [{ x: 0, y: 100, w: 100, h: 100 }],
                submit: { x: 300, y: 500, w: 80, h: 40 },
                tick: null,
                canvas: null,
                header: null,
                instruction: "Select all buses",
                settled: true,
                blocked: false,
            },
        ];
        const view = await chromeDriver(page).challenge({ x: 100, y: 50, w: 200, h: 300 });
        expect(view?.tiles).toEqual([{ x: 100, y: 100, w: 50, h: 50 }]);
        expect(view?.submit).toEqual({ x: 250, y: 300, w: 40, h: 20 });
        expect(view?.instruction).toBe("Select all buses");
    });

    it("sends a click as one gesture: move, press, release", async () => {
        await chromeDriver(page).click(40, 60);
        expect(gestures()).toHaveLength(1);
        expect(gestures()[0].map((e) => e.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
        expect(gestures()[0].every((e) => e.x === 40 && e.y === 60)).toBe(true);
    });

    it("holds a drag's moves until release and sends the whole drag at once", async () => {
        const d = chromeDriver(page);
        await d.move(10, 10);
        sent.length = 0;
        await d.down();
        await d.move(40, 10, 3);
        expect(gestures()).toHaveLength(0); // nothing sent while the button is down
        await d.up();
        const [g] = gestures();
        expect(g.map((e) => e.type)).toEqual([
            "mousePressed",
            "mouseMoved",
            "mouseMoved",
            "mouseMoved",
            "mouseReleased",
        ]);
        expect(g.slice(1, 4).map((e) => [e.x, e.buttons])).toEqual([
            [20, 1],
            [30, 1],
            [40, 1],
        ]);
        expect(g[4]).toMatchObject({ x: 40, y: 10, buttons: 0 });
    });
});
