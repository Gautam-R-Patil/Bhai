// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The extension's synthetic Enter follows the HTML implicit-submission rules.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../../chrome-extension/background.js", import.meta.url), "utf8");
const start = src.indexOf("func: (key, modifiers, keyAction) => {");
const end = src.indexOf("args: [payload.key, payload.modifiers", start);
const fn = src.slice(start + "func: ".length, end).trim().replace(/,$/, "");

// biome-ignore lint/suspicious/noExplicitAny: optional playwright
let browser: any = null;
beforeAll(async () => {
    try {
        browser = await (await import("playwright")).chromium.launch({ headless: true });
    } catch {
        browser = null;
    }
}, 60_000);
afterAll(async () => browser?.close());

// biome-ignore lint/suspicious/noExplicitAny: Playwright page
async function enter(page: any, html: string): Promise<string> {
    await page.setContent(`${html}<script>window.r = "none";
        document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); window.r = "submit:" + (e.submitter?.name || ""); });</script>`);
    await page.focus("#f");
    await page.evaluate(`(${fn})("Enter", [], "press")`);
    return await page.evaluate("window.r");
}

describe("extension keyboard Enter", () => {
    it("submits like a real Enter, and only then", async (ctx) => {
        if (!browser) return ctx.skip();
        expect(fn.startsWith("(key, modifiers, keyAction) =>")).toBe(true);
        const page = await browser.newPage();
        expect(await enter(page, `<form><input id=f></form>`)).toBe("submit:");
        // two text fields, no submit button: Enter does nothing
        expect(await enter(page, `<form><input id=f><input></form>`)).toBe("none");
        // the default button is clicked: its name is the submitter, its onclick can cancel
        expect(await enter(page, `<form><input id=f><input><button name=go>Go</button></form>`)).toBe("submit:go");
        expect(await enter(page, `<form><input id=f><button onclick="return false">Go</button></form>`)).toBe("none");
        // the page cancels Enter on keypress (tag inputs)
        expect(
            await enter(page, `<form><input id=f onkeypress="if (event.key==='Enter') event.preventDefault()"></form>`),
        ).toBe("none");
        await page.close();
    }, 30_000);
});
