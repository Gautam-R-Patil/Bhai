// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A page with a "Leave site?" prompt must not hang the agent's next navigation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachPopupGuard } from "./popup-guard.js";

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

describe("popup guard", () => {
    it("accepts beforeunload so navigation proceeds", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        attachPopupGuard(context);
        const page = await context.newPage();
        await page.setContent(`<button id=b>x</button><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>`);
        await page.click("#b"); // beforeunload prompts need a user gesture
        await page.goto("data:text/html,<p>next</p>", { timeout: 3000 });
        expect(await page.textContent("p")).toBe("next");
        await context.close();
    }, 30_000);

    it("never clicks a page's own Continue; on a banner, Reject beats Accept", async (ctx) => {
        if (!browser) return ctx.skip();
        const { dismissCookieBanner } = await import("./popup-guard.js");
        const page = await browser.newPage();
        await page.setContent(`<h1>Checkout</h1><button onclick="window.cont=1">Continue</button>`);
        expect(await dismissCookieBanner(page)).toBe(false);
        expect(await page.evaluate("window.cont || 0")).toBe(0);
        await page.setContent(`<div role=dialog><p>By clicking Continue you agree to our Privacy Policy and tracking terms.</p>
            <button onclick="window.cont=1">Continue</button><button onclick="window.cont=2">Decline</button></div>`);
        expect(await dismissCookieBanner(page)).toBe(false);
        expect(await page.evaluate("window.cont || 0")).toBe(0);

        await page.setContent(`<div id=banner><p>We use cookies for tracking.</p>
            <button onclick="window.choice='accept'">Accept all</button><button onclick="window.choice='reject'">Reject all</button></div>`);
        expect(await dismissCookieBanner(page)).toBe(true);
        expect(await page.evaluate("window.choice")).toBe("reject");
        await page.close();
    }, 30_000);
});

