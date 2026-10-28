// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bhai's in-page cursor on the synthetic shop (headless Chromium): one host,
// removable, invisible to Bhai's own page reading, click-through, latency-capped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHOP_RESOLVER_ARG, startShop } from "../../skills/site/__tests__/synthetic-shop.js";
import { CAPTURE_JS, pageDriver } from "../../skills/site/page-driver.js";
import { AGENT_CURSOR_CAP_MS, AGENT_UI_HOST_ID, AGENT_UI_JS, agentCursor, withAgentUIHidden } from "./agent-cursor.js";

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
        // Keep it up for every read below, however slow the machine.
        await page.evaluate(`(${AGENT_UI_JS})({ kind: "presence", idleMs: 120000 })`);
        const { getInteractiveElements } = await import("./core.js");
        const scanned = (await getInteractiveElements(page)).map(({ handle: _h, ...e }) => e);
        expect(scanned.length).toBeGreaterThan(0);
        const seen = JSON.stringify([
            scanned,
            await pageDriver(page).snapshot(),
            await page.locator("body").ariaSnapshot(),
            await page.evaluate("document.documentElement.innerText"),
            await page.getByText("Bhai").count(),
            await page.evaluate(CAPTURE_JS), // the Site Skill minter's recorded HTML
        ]);
        expect(seen).not.toMatch(/__bhai|Bhai/);
        expect(await hosts(page)).toBe(1); // it is there, just unseen
        await page.context().close();
    }, 60_000);

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
        expect(Date.now() - t).toBeLessThanOrEqual(AGENT_CURSOR_CAP_MS + 400) // slack for a loaded CI box; the slow eval takes 2s;
        const slow = { on() {}, evaluate: () => new Promise((r) => setTimeout(() => r(300), 2000)) };
        t = Date.now();
        await agentCursor(slow, { x: 5, y: 5 });
        expect(Date.now() - t).toBeLessThanOrEqual(AGENT_CURSOR_CAP_MS + 400) // slack for a loaded CI box; the slow eval takes 2s;
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

    it("hides itself from Bhai's own screenshots, on a Trusted Types + strict style-src page", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await (await browser.newContext()).newPage();
        await page.route("https://tt.test/", (route: any) =>
            route.fulfill({
                contentType: "text/html",
                headers: { "content-security-policy": "require-trusted-types-for 'script'; style-src 'self'" },
                body: "<html><body style='margin:0;background:#fff'><button id=b>Go</button></body></html>",
            }),
        );
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        await page.goto("https://tt.test/");
        const before = await page.screenshot();
        await agentCursor(page, page.locator("#b"), "click");
        expect(errors).toEqual([]);
        expect(await hosts(page)).toBe(1);
        // Styled despite style-src (constructed sheet), so it is really on screen...
        expect(
            await page.evaluate(
                `getComputedStyle(document.getElementById("${AGENT_UI_HOST_ID}").__bhai.root.querySelector(".pill")).position`,
            ),
        ).toBe("fixed");
        expect((await page.screenshot()).equals(before)).toBe(false);
        // ...but not in the capture, and back afterwards.
        expect((await withAgentUIHidden(page, () => page.screenshot())).equals(before)).toBe(true);
        expect(await page.evaluate(`document.getElementById("${AGENT_UI_HOST_ID}").style.visibility`)).toBe("");
        await page.context().close();
    });

    it("Chrome bridge: never leaves a cursor eval in flight, skips the overlay once the cap is spent", async () => {
        const calls: string[] = [];
        // No page.on: the bridge proxy. Its eval outlives the cap; agentCursor waits for it.
        let done = false;
        const slowEval = {
            evaluate: () =>
                new Promise((r) =>
                    setTimeout(() => {
                        done = true;
                        r(300);
                    }, 600),
                ),
        };
        await agentCursor(slowEval, { x: 5, y: 5 });
        expect(done).toBe(true);
        // Finding the target used up the cap: the overlay eval is never sent.
        const slowBox = {
            evaluate: async () => {
                calls.push("eval");
                return 0;
            },
        };
        const target = {
            boundingBox: () =>
                new Promise<any>((r) =>
                    setTimeout(() => r({ x: 0, y: 0, width: 4, height: 4 }), AGENT_CURSOR_CAP_MS + 50),
                ),
        };
        await agentCursor(slowBox, target);
        expect(calls).toEqual([]);
    });

    it("Chrome bridge: a page that outruns the 1s cap stops getting a cursor", async () => {
        let evals = 0;
        const hung = { evaluate: () => (evals++, new Promise((r) => setTimeout(() => r(0), 3000))) };
        const t0 = Date.now();
        await agentCursor(hung, { x: 5, y: 5 });
        expect(Date.now() - t0).toBeLessThan(1300);
        const t1 = Date.now();
        await agentCursor(hung, { x: 6, y: 6 });
        expect(Date.now() - t1).toBeLessThan(50);
        expect(evals).toBe(1);
    });

    it("overlapping captures keep the overlay hidden until the last one ends", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await freshPage();
        await agentCursor(page, { x: 20, y: 20 });
        const hostVisible = () => page.evaluate(`getComputedStyle(document.getElementById("__bhaiAgentUI")).visibility !== "hidden"`);
        let release!: () => void;
        const slow = withAgentUIHidden(page, () => new Promise<number>((r) => (release = () => r(1))));
        await withAgentUIHidden(page, async () => 2);
        expect(await hostVisible()).toBe(false); // the slow capture is still running
        release();
        await slow;
        expect(await hostVisible()).toBe(true);
        await page.context().close();
    });
});
