// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai's in-page cursor on the synthetic shop (headless Chromium): one host,
// removable, invisible to Bhai's own page reading, click-through, latency-capped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHOP_RESOLVER_ARG, startShop } from "../../skills/site/__tests__/synthetic-shop.js";
import { pageDriver } from "../../skills/site/page-driver.js";
import { AGENT_CURSOR_CAP_MS, AGENT_UI_HOST_ID, AGENT_UI_JS, agentCursor } from "./agent-cursor.js";

let browser: any = null;
let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => {
    shop = await startShop();
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
    }
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await shop?.close();
});

async function freshPage() {
    const page = await (await browser.newContext()).newPage();
    await page.goto(shop.url);
    return page;
}
const hosts = (page: any) => page.evaluate(`document.querySelectorAll("#${AGENT_UI_HOST_ID}").length`);

describe("agent cursor", () => {
    it("injects once and is removable", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        await agentCursor(page, { x: 100, y: 100 }, "click");
        await agentCursor(page, page.locator("#accept"), "hover");
        await agentCursor(page, null, "type");
        expect(await hosts(page)).toBe(1);
        await page.evaluate(`(${AGENT_UI_JS})({ end: true })`);
        expect(await hosts(page)).toBe(0);
        await page.context().close();
    });

    it("never shows up in snapshots, scans or the accessibility tree", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        await agentCursor(page, page.locator("#accept"), "click");
        const { getInteractiveElements } = await import("./core.js");
        const scanned = (await getInteractiveElements(page)).map(({ handle: _h, ...e }) => e);
        expect(scanned.length).toBeGreaterThan(0);
        const seen = JSON.stringify([
            scanned,
            await pageDriver(page).snapshot(),
            await page.locator("body").ariaSnapshot(),
            await page.evaluate("document.documentElement.innerText"),
            await page.getByText("Bhai").count(),
        ]);
        expect(seen).not.toMatch(/__bhai|Bhai/);
        expect(await hosts(page)).toBe(1); // it is there, just unseen
        await page.context().close();
    });

    it("a click aimed at the cursor lands on the real element", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        const box = await page.locator("#accept").boundingBox();
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        await agentCursor(page, { x, y }, "click");
        expect(await page.evaluate(`document.elementFromPoint(${x}, ${y}).id`)).toBe("accept");
        await page.mouse.click(x, y);
        expect(await page.locator("#cookie-modal").count()).toBe(0);
        await page.context().close();
    });

    it("caps added latency, even on a slow page", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        let t = Date.now();
        await agentCursor(page, { x: 1, y: 1 }, "click"); // long glide from the centre
        expect(Date.now() - t).toBeLessThanOrEqual(AGENT_CURSOR_CAP_MS + 50);
        const slow = { evaluate: () => new Promise((r) => setTimeout(() => r(300), 2000)) };
        t = Date.now();
        await agentCursor(slow, { x: 5, y: 5 });
        expect(Date.now() - t).toBeLessThanOrEqual(AGENT_CURSOR_CAP_MS + 50);
        await page.context().close();
    });

    it("comes back after a navigation and honours the kill switch", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        await agentCursor(page, { x: 50, y: 50 }, "click");
        await page.goto(`${shop.url}results?q=dal`);
        await page.waitForFunction(`!!document.getElementById("${AGENT_UI_HOST_ID}")`, undefined, { timeout: 2000 });
        await page.evaluate(`(${AGENT_UI_JS})({ end: true })`);
        process.env.ATLAS_NO_AGENT_CURSOR = "true";
        try {
            await agentCursor(page, { x: 50, y: 50 }, "click");
            expect(await hosts(page)).toBe(0);
        } finally {
            delete process.env.ATLAS_NO_AGENT_CURSOR;
        }
        await page.context().close();
    });

    it("fades and removes itself when the task goes idle", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        await page.evaluate(`(${AGENT_UI_JS})({ x: 10, y: 10, kind: "hover", idleMs: 10 })`);
        expect(await hosts(page)).toBe(1);
        await page.waitForFunction(`!document.getElementById("${AGENT_UI_HOST_ID}")`, undefined, { timeout: 6000 });
        await page.context().close();
    }, 10_000);
});
