// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// browser_mark draws boxes the user can see, never runs page-supplied text, and clears.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMarkScript } from "./mark.js";

// biome-ignore lint/suspicious/noExplicitAny: optional playwright
let browser: any = null;
beforeAll(async () => {
    try {
        browser = await (await import("playwright-core")).chromium.launch({ headless: true });
    } catch {
        browser = null;
    }
}, 60_000);
afterAll(async () => browser?.close());

describe("browser_mark", () => {
    it("boxes elements by selector, text and coordinates; reports what it couldn't find", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        await page.setContent(`<div style="height:1500px"><button id=pay>Pay now</button><p>Total: <b>₹499</b></p></div>`);
        const result = await page.evaluate(
            buildMarkScript(
                [
                    { selector: "#pay", label: "Click here" },
                    { text: "₹499", label: "Price" },
                    { x: 10, y: 10, width: 50, height: 20 },
                    { selector: "#nope", label: "Missing one" },
                ],
                false,
            ),
        );
        expect(result).toEqual({ marked: 3, missing: ["Missing one"] });
        const labels = await page.$$eval("#__bhai_marks div > div", (els: Element[]) => els.map((e) => e.textContent));
        expect(labels).toEqual(["Click here", "Price"]);
        // The text match is the innermost element, not <body>.
        const priceBox = await page.$eval("#__bhai_marks > div:nth-child(2)", (e: HTMLElement) => e.getBoundingClientRect().height);
        expect(priceBox).toBeLessThan(60);
        await page.close();
    }, 30_000);

    it("shows a label as text, never as HTML; clear removes the marks", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        await page.setContent(`<h1>Hi</h1>`);
        await page.evaluate(buildMarkScript([{ selector: "h1", label: '<img src=x onerror="window.__pwned=1">' }], false));
        await page.waitForTimeout(50);
        expect(await page.evaluate("window.__pwned || 0")).toBe(0);
        expect(await page.$$eval("#__bhai_marks img", (els: Element[]) => els.length)).toBe(0);
        expect(await page.evaluate(buildMarkScript([], true))).toEqual({ cleared: true });
        expect(await page.$("#__bhai_marks")).toBeNull();
        await page.close();
    }, 30_000);

    it("a selector can't break out of the script", () => {
        const script = buildMarkScript([{ selector: '"]); window.__x = 1; ("', label: "</script>" }], false);
        expect(() => new Function(script)).not.toThrow();
        expect(script).not.toContain('window.__x = 1; ("",');
    });
});
