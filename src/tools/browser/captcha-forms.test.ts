// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Form CAPTCHAs: the answer is typed into the field for real, and a rotate puzzle is
// turned by as many presses as the picture the model picks as upright.

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

const askValue = vi.fn();
vi.mock("./captcha-vision.js", () => ({
    askValue,
    askModel: vi.fn(),
    snapshot: vi.fn(),
    GRID: 10,
    gridPrompt: () => "",
    centre: (r: { x: number; y: number; w: number; h: number }) => [r.x + r.w / 2, r.y + r.h / 2],
    click: async (d: { click(x: number, y: number): Promise<void> }, [x, y]: [number, number]) => d.click(x, y),
}));

const { solveFormCaptcha } = await import("./captcha-forms.js");

const rect = (x: number) => ({ x, y: 0, w: 40, h: 20 });
function driver() {
    return {
        clicks: [] as number[],
        typed: [] as string[],
        async click(x: number) {
            this.clicks.push(x);
        },
        async type(t: string) {
            this.typed.push(t);
        },
        shot: () =>
            sharp({ create: { width: 60, height: 60, channels: 3, background: "#808080" } })
                .png()
                .toBuffer(),
    };
}

describe("solveFormCaptcha", () => {
    it("reads the image and types the characters into the field, spaces dropped", async () => {
        const page = {
            evaluate: vi.fn(async (code: string) =>
                code.includes("LOCATE") || code.includes("scrollIntoView")
                    ? {
                          img: rect(0),
                          field: rect(100),
                          right: null,
                          left: null,
                          question: "",
                          fieldKey: "#c",
                          angle: null,
                      }
                    : undefined,
            ),
        };
        askValue.mockResolvedValueOnce("W9 h2K");
        const d = driver();
        expect(await solveFormCaptcha(page, "image-text", d as never)).toBe(true);
        expect(d.clicks).toEqual([120]); // the field, focused with a real click
        expect(d.typed).toEqual(["W9h2K"]);
    });

    it("turns a rotate puzzle by presses of the measured step", async () => {
        let angle = 0;
        const page = {
            evaluate: vi.fn(async (_code: string) => ({
                img: rect(0),
                src: "https://x.test/rotate.jpg",
                field: null,
                right: rect(200),
                left: rect(300),
                question: "",
                fieldKey: "",
                angle,
            })),
        };
        const d = driver();
        d.click = async function (x: number) {
            this.clicks.push(x);
            if (x === 220) angle += 40; // each right press turns 40°
        };
        askValue.mockResolvedValueOnce("4"); // the 4th picture on the sheet: 3 presses on
        expect(await solveFormCaptcha(page, "rotate", d as never)).toBe(true);
        expect(askValue.mock.calls.at(-1)?.[1]).toMatch(/^data:image\/jpeg;base64,/); // the numbered sheet
        expect(d.clicks).toEqual([220, 220, 220, 220]); // 1 to measure, then 3
        // Marked as answered, so the form's submit step doesn't turn it again.
        expect(page.evaluate.mock.calls.at(-1)?.[0]).toContain("data-bhai-answered");
    });
});
