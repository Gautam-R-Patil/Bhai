// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Picture-CAPTCHA solver: the model only names tiles or grid cells (in JSON or
// plain prose, so any model works); Bhai reads the challenge DOM, clicks and drags.

import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../llm.js", () => ({ MODELS: { SONNET: "sonnet" } }));

const { parseAnswer, setCaptchaLLM, solveWithVision } = await import("./captcha-vision.js");

const box = (x: number, y: number, width: number, height: number) => ({
    boundingBox: async () => ({ x, y, width, height }),
});
// A painted puzzle: noise, not the flat colour of a canvas that hasn't drawn yet.
const png = (w: number, h: number) =>
    sharp({
        create: {
            width: w,
            height: h,
            channels: 3,
            background: "#808080",
            noise: { type: "gaussian", mean: 128, sigma: 40 },
        },
    })
        .png()
        .toBuffer();
const reply = (...contents: string[]) => {
    const fn = vi.fn(async (_req: { modelOverride?: string }) => ({
        choices: [{ message: { content: contents[Math.min(fn.mock.calls.length - 1, contents.length - 1)] } }],
    }));
    return fn;
};
/** A challenge frame's evaluate: tiles are settled, the widget isn't blocked, else the instruction. */
const frameEval = (instruction: string) => async (code: unknown) =>
    String(code).includes("dynamic-selected") ? true : String(code).includes("doscaptcha") ? false : instruction;

/** Runs a solve under fake timers; sharp works on real I/O between the sleeps. */
async function run(p: Promise<boolean>): Promise<boolean> {
    let result: boolean | undefined;
    p.then((r) => (result = r));
    while (result === undefined) await vi.advanceTimersByTimeAsync(250);
    return result;
}

function mouse(onClick: (x: number, y: number) => void = () => {}) {
    const clicks: [number, number][] = [];
    const moves: [number, number][] = [];
    return {
        clicks,
        moves,
        mouse: {
            move: vi.fn(async (x: number, y: number) => void moves.push([x, y])),
            down: vi.fn(async () => {}),
            up: vi.fn(async () => {}),
            click: vi.fn(async (x: number, y: number) => {
                clicks.push([x, y]);
                onClick(x, y);
            }),
        },
    };
}

beforeEach(() => {
    process.env.BHAI_CAPTCHA_MODELS = "azure/gpt-6-luna,xai/grok-4.7";
});

describe("parseAnswer", () => {
    it("reads JSON, and falls back to the numbers or cells in prose", () => {
        expect(parseAnswer('{"answer": [2, "x", 5], "unsolvable": false}', "tiles")).toEqual({
            answer: [2, 5],
            drag: [],
            unsolvable: false,
        });
        expect(parseAnswer("Tiles 3 and 7 show buses.", "tiles")).toEqual({
            answer: [3, 7],
            drag: [],
            unsolvable: false,
        });
        expect(parseAnswer('```json\n{"answer": ["c4", "K2", "J10"]}\n```', "grid")).toEqual({
            answer: ["C4", "J10"],
            drag: [],
            unsolvable: false,
        });
        expect(parseAnswer('{"drag": [["b2", "F7"], ["Z1", "A1"]]}', "grid")).toEqual({
            answer: [],
            drag: [["B2", "F7"]],
            unsolvable: false,
        });
        expect(parseAnswer("The cat is in cell B3.", "grid")).toEqual({ answer: ["B3"], drag: [], unsolvable: false });
        expect(parseAnswer("no idea", "tiles")).toBeNull();
    });

    it("never reads a refusal or an error object as 'no tile matches'", () => {
        expect(parseAnswer('{"error": "I can’t help solve CAPTCHAs."}', "tiles")).toBeNull();
        expect(parseAnswer("I can’t help solve CAPTCHAs.", "tiles")).toBeNull();
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
            evaluate: frameEval("Select all images with buses"),
        };
        let ticked = false;
        let done = false;
        const m = mouse((x, y) => {
            if (y < 60) ticked = true;
            if (y > 460) done = true; // the verify button
        });
        const page = {
            evaluate: vi.fn(async () =>
                ticked ? { challenge, checkbox: null } : { challenge: null, checkbox: { x: 10, y: 20, w: 300, h: 78 } },
            ),
            frames: () => [anchor, bframe],
            screenshot: vi.fn(async () => png(300, 400)),
            mouse: m.mouse,
        };
        // A model that ignores the JSON request and answers in prose.
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat: reply("Tiles 2 and 9 contain buses.") } as any);

        expect(await run(solveWithVision(page, async () => done))).toBe(true);
        const inside = ([x, y]: [number, number], l: number, t: number, w: number, h: number) =>
            x > l && x < l + w && y > t && y < t + h;
        expect(m.clicks).toHaveLength(4);
        expect(inside(m.clicks[0], 20, 30, 28, 28)).toBe(true); // the tick box, from the anchor frame's DOM
        expect(inside(m.clicks[1], 200, 150, 100, 100)).toBe(true); // tile 2
        expect(inside(m.clicks[2], 300, 350, 100, 100)).toBe(true); // tile 9
        expect(inside(m.clicks[3], 300, 460, 90, 30)).toBe(true); // verify
        vi.useRealTimers();
    });

    it("moves past a model that refuses, and skips it once it has refused twice", async () => {
        vi.useFakeTimers();
        const challenge = { x: 0, y: 0, w: 100, h: 100 };
        const hc = {
            url: () => "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge",
            $$: async (s: string) => (s === ".button-submit" ? [box(60, 90, 30, 9)] : []),
            evaluate: frameEval("Please click on the cat"),
        };
        let submits = 0;
        const m = mouse((_x, y) => {
            if (y >= 90) submits++;
        });
        const page = {
            evaluate: vi.fn(async () => ({ challenge, checkbox: null })),
            frames: () => [hc],
            screenshot: vi.fn(async () => png(100, 100)),
            mouse: m.mouse,
        };
        const chat = vi.fn(async (req: { modelOverride?: string }) => ({
            choices: [
                {
                    message: {
                        content:
                            req.modelOverride === "azure/gpt-6-luna"
                                ? "I can’t help solve CAPTCHAs."
                                : '{"answer": ["B3"]}',
                    },
                },
            ],
        }));
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat } as any);
        expect(await run(solveWithVision(page, async () => submits >= 3))).toBe(true);
        expect(m.clicks[0]).toEqual([25, 15]); // centre of row B, column 3 on a 10x10 grid
        expect(chat.mock.calls.map((c) => c[0].modelOverride)).toEqual([
            "azure/gpt-6-luna",
            "xai/grok-4.7",
            "azure/gpt-6-luna",
            "xai/grok-4.7",
            "xai/grok-4.7",
        ]);
        vi.useRealTimers();
    });

    it("drags from one grid cell to another for a slider puzzle", async () => {
        vi.useFakeTimers();
        const challenge = { x: 0, y: 0, w: 100, h: 100 };
        const hc = {
            url: () => "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge",
            $$: async (s: string) => (s === "canvas" ? [box(0, 0, 100, 100)] : []),
            evaluate: frameEval("Drag the piece to complete the image"),
        };
        const m = mouse();
        let dropped = false;
        m.mouse.up.mockImplementation(async () => {
            dropped = true;
        });
        const page = {
            evaluate: vi.fn(async () => ({ challenge, checkbox: null })),
            frames: () => [hc],
            screenshot: vi.fn(async () => png(100, 100)),
            mouse: m.mouse,
        };
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat: reply('{"drag": [["E1", "E9"]]}') } as any);
        expect(await run(solveWithVision(page, async () => dropped))).toBe(true);
        expect(m.mouse.down).toHaveBeenCalledTimes(1);
        expect(m.moves.at(-1)).toEqual([85, 45]); // released on E9's centre
        expect(m.clicks).toHaveLength(0);
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

describe("model voting on tiles", () => {
    function tilePage(onVerify: () => void) {
        const tiles = Array.from({ length: 9 }, (_, i) => box((i % 3) * 100, 50 + Math.floor(i / 3) * 100, 100, 100));
        const bframe = {
            url: () => "https://www.google.com/recaptcha/api2/bframe?k=x",
            $$: async (s: string) =>
                s === "td.rc-imageselect-tile"
                    ? tiles
                    : s === "#recaptcha-verify-button"
                      ? [box(200, 360, 90, 30)]
                      : [],
            evaluate: frameEval("Select all images with a bus"),
        };
        const m = mouse((_x, y) => y > 360 && onVerify());
        return {
            m,
            page: {
                evaluate: vi.fn(async () => ({ challenge: { x: 0, y: 0, w: 300, h: 400 }, checkbox: null })),
                frames: () => [bframe],
                screenshot: vi.fn(async () => png(300, 400)),
                mouse: m.mouse,
            },
        };
    }
    const tileOf = ([x, y]: [number, number]) => Math.floor(x / 100) + 3 * Math.floor((y - 50) / 100) + 1;

    it("takes the first two models' answer when they agree, without asking the third", async () => {
        vi.useFakeTimers();
        process.env.BHAI_CAPTCHA_MODELS = "a,b,c";
        let done = false;
        const { m, page } = tilePage(() => (done = true));
        const chat = vi.fn(async (req: { modelOverride?: string }) => ({
            choices: [{ message: { content: req.modelOverride === "c" ? '{"answer": [9]}' : '{"answer": [5, 2]}' } }],
        }));
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({ chat } as any);
        expect(await run(solveWithVision(page, async () => done))).toBe(true);
        expect(chat.mock.calls.map((c) => c[0].modelOverride).sort()).toEqual(["a", "b"]);
        expect(m.clicks.slice(0, -1).map(tileOf)).toEqual([5, 2]);
        vi.useRealTimers();
    });

    it("lets the third model break a tie, tile by tile", async () => {
        vi.useFakeTimers();
        process.env.BHAI_CAPTCHA_MODELS = "a,b,c";
        let done = false;
        const { m, page } = tilePage(() => (done = true));
        const say: Record<string, string> = {
            a: '{"answer": [1, 2]}',
            b: '{"answer": [2, 3]}',
            c: '{"answer": [2, 3, 7]}',
        };
        // biome-ignore lint/suspicious/noExplicitAny: minimal LLMClient
        setCaptchaLLM({
            chat: vi.fn(async (req: { modelOverride?: string }) => ({
                choices: [{ message: { content: say[req.modelOverride ?? ""] } }],
            })),
        } as any);
        expect(await run(solveWithVision(page, async () => done))).toBe(true);
        expect(m.clicks.slice(0, -1).map(tileOf).sort()).toEqual([2, 3]); // 2 (3 votes), 3 (2 votes); 1 and 7 had one
        vi.useRealTimers();
    });
});
