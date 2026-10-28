// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Picture-CAPTCHA solver: the model only names tiles or grid cells (in JSON or
// plain prose, so any model works); Bhai reads the challenge DOM and clicks.

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../llm.js", () => ({ MODELS: { SONNET: "sonnet" } }));

const { parseAnswer, setCaptchaLLM, solveWithVision } = await import("./captcha-vision.js");

const box = (x: number, y: number, width: number, height: number) => ({
    boundingBox: async () => ({ x, y, width, height }),
});
const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: "#fff" } })
        .png()
        .toBuffer();
const reply = (content: string) => vi.fn(async () => ({ choices: [{ message: { content } }] }));

/** Runs a solve under fake timers; sharp works on real I/O between the sleeps. */
async function run(p: Promise<boolean>): Promise<boolean> {
    let result: boolean | undefined;
    p.then((r) => (result = r));
    while (result === undefined) await vi.advanceTimersByTimeAsync(500);
    return result;
}

describe("parseAnswer", () => {
    it("reads JSON, and falls back to the numbers or cells in prose", () => {
        expect(parseAnswer('{"answer": [2, "x", 5], "unsolvable": false}', "tiles")).toEqual({
            answer: [2, 5],
            unsolvable: false,
        });
        expect(parseAnswer("Tiles 3 and 7 show buses.", "tiles")).toEqual({ answer: [3, 7], unsolvable: false });
        expect(parseAnswer('```json\n{"answer": ["c4", "K2", "J10"]}\n```', "grid")).toEqual({
            answer: ["C4", "J10"],
            unsolvable: false,
        });
        expect(parseAnswer("The cat is in cell B3.", "grid")).toEqual({ answer: ["B3"], unsolvable: false });
        expect(parseAnswer("no idea", "tiles")).toBeNull();
    });
});

describe("solveWithVision", () => {
    it("ticks the box, clicks the tiles the model names, then verifies", async () => {
        vi.useFakeTimers();
        const challenge = { x: 100, y: 100, w: 300, h: 400 };
        // A 3x3 grid of 100px tiles from (100,150); verify button below it.
        const tiles = Array.from({ length: 9 }, (_, i) =>
            box(100 + (i % 3) * 100, 150 + Math.floor(i / 3) * 100, 100, 100),
        );
        const anchor = {
            url: () => "https://www.google.com/recaptcha/api2/anchor?k=x",
            $$: async (s: string) => (s === "#recaptcha-anchor" ? [box(20, 30, 28, 28)] : []),
        };
        const bframe = {
            url: () => "https://www.google.com/recaptcha/api2/bframe?k=x",
            $$: async (s: string) =>
                s === "td.rc-imageselect-tile"
                    ? tiles
                    : s === "#recaptcha-verify-button"
                      ? [box(300, 460, 90, 30)]
                      : [],
            evaluate: async () => "Select all images with buses",
        };
        const frames = [
            { challenge: null, checkbox: { x: 10, y: 20, w: 300, h: 78 } },
            { challenge, checkbox: null },
        ];
        const clicks: [number, number][] = [];
        let done = false;
        const page = {
            evaluate: vi.fn(async () => frames.shift() ?? { challenge: null, checkbox: null }),
            frames: () => [anchor, bframe],
            screenshot: vi.fn(async () => png(300, 400)),
            mouse: {
                move: vi.fn(async () => {}),
                click: vi.fn(async (x: number, y: number) => {
                    clicks.push([x, y]);
                    if (y > 460) done = true; // the verify button
                }),
            },
        };
        // A model that ignores the JSON request and answers in prose.
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat: reply("Tiles 2 and 9 contain buses.") } as any);

        expect(await run(solveWithVision(page, async () => done))).toBe(true);
        const inside = ([x, y]: [number, number], l: number, t: number, w: number, h: number) =>
            x > l && x < l + w && y > t && y < t + h;
        expect(clicks).toHaveLength(4);
        expect(inside(clicks[0], 20, 30, 28, 28)).toBe(true); // the tick box, from the anchor frame's DOM
        expect(inside(clicks[1], 200, 150, 100, 100)).toBe(true); // tile 2
        expect(inside(clicks[2], 300, 350, 100, 100)).toBe(true); // tile 9
        expect(inside(clicks[3], 300, 460, 90, 30)).toBe(true); // verify
        vi.useRealTimers();
    });

    it("falls back to the lettered grid when the challenge has no tiles", async () => {
        vi.useFakeTimers();
        const challenge = { x: 0, y: 0, w: 100, h: 100 };
        const hc = {
            url: () => "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge",
            $$: async (s: string) => (s === ".button-submit" ? [box(60, 90, 30, 9)] : []),
            evaluate: async () => "Please click on the cat",
        };
        const clicks: [number, number][] = [];
        let done = false;
        const page = {
            evaluate: vi.fn(async () => ({ challenge, checkbox: null })),
            frames: () => [hc],
            screenshot: vi.fn(async () => png(100, 100)),
            mouse: {
                move: vi.fn(async () => {}),
                click: vi.fn(async (x: number, y: number) => {
                    clicks.push([x, y]);
                    if (y >= 90) done = true;
                }),
            },
        };
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat: reply('{"answer": ["B3"]}') } as any);
        expect(await run(solveWithVision(page, async () => done))).toBe(true);
        expect(clicks[0]).toEqual([25, 15]); // centre of row B, column 3 on a 10x10 grid
        vi.useRealTimers();
    });

    it("gives up on a challenge the model calls unsolvable", async () => {
        const page = {
            evaluate: vi.fn(async () => ({ challenge: { x: 0, y: 0, w: 100, h: 100 }, checkbox: null })),
            frames: () => [],
            screenshot: vi.fn(async () => png(100, 100)),
            mouse: { move: vi.fn(), click: vi.fn() },
        };
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat: reply('{"answer": [], "unsolvable": true}') } as any);
        expect(await solveWithVision(page, async () => false)).toBe(false);
        expect(page.mouse.click).not.toHaveBeenCalled();
    });
});
