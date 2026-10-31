// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// browser_select by label in the owner's Chrome: the proxy and the extension's select_option, end to end.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const src = readFileSync(new URL("../../../chrome-extension/background.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("async function selectOption(payload)"));
const start = body.indexOf("func: (selector, values) => {");
const fn = body.slice(start + "func: ".length, body.indexOf("args: [payload.selector", start)).trim().replace(/,$/, "");

// biome-ignore lint/suspicious/noExplicitAny: optional playwright
let browser: any = null;
// biome-ignore lint/suspicious/noExplicitAny: Playwright page
let page: any = null;
beforeAll(async () => {
    try {
        browser = await (await import("playwright-core")).chromium.launch({ headless: true });
        page = await browser.newPage();
    } catch {
        browser = null;
    }
}, 60_000);
afterAll(async () => browser?.close());

// The bridge runs the extension's injected function in the page, then its result check.
vi.mock("./chrome-bridge.js", () => ({
    sendBridgeCommand: async (_type: string, p: { selector: string; values: string[] }) => {
        const out = await page.evaluate(`(${fn})(${JSON.stringify(p.selector)}, ${JSON.stringify(p.values)})`);
        if (!out || out.error) throw new Error(out?.error || "select_option failed");
        return { success: true };
    },
}));
const { ChromePageProxy } = await import("./chrome-backend.js");

it("selects by label, and a missing label fails without resetting the choice", async (ctx) => {
    if (!browser) return ctx.skip();
    await page.setContent(`<select id=country><option value="">Select…</option><option value="af">Afghanistan</option>
        <option value="in">India</option></select>`);
    const proxy = new ChromePageProxy();
    await proxy.selectOption("#country", { label: "India" });
    expect(await page.$eval("#country", (e: HTMLSelectElement) => e.value)).toBe("in");
    await expect(proxy.selectOption("#country", { label: "Indonesia" })).rejects.toThrow(/No option/);
    expect(await page.$eval("#country", (e: HTMLSelectElement) => e.value)).toBe("in");
}, 30_000);
