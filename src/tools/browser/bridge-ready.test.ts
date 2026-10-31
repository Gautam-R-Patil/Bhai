// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Chrome-bridge page-ready is event-driven (no fixed sleeps): the in-page
// promise waits for a fresh, loaded document whose DOM has gone quiet.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("./chrome-bridge.js", () => ({ sendBridgeCommand: send, getActiveExtensionTab: vi.fn(), getExtensionTabs: vi.fn() }));
const { readyJs, waitBridgeReady } = await import("./chrome-backend.js");

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

describe("bridge page-ready", () => {
    it("waits for DOM changes to stop, ignores attribute animations, flags an old document", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        await page.setContent(`<div id=a></div><div id=spin></div><script>
            let n = 0; const t = setInterval(() => { document.getElementById("a").append("x"); if (++n === 6) clearInterval(t); }, 100);
            setInterval(() => document.getElementById("spin").style.opacity = Math.random(), 30);
        </script>`);
        const t0 = Date.now();
        expect(await page.evaluate(readyJs(5000, 300, 0))).toBe("ready");
        const took = Date.now() - t0;
        expect(took).toBeGreaterThanOrEqual(600); // waited for the 600ms of node churn
        expect(took).toBeLessThan(2000); // the opacity animation didn't hold it to the cap
        expect(await page.evaluate(readyJs(400, 300, Date.now() + 60_000))).toBe("stale"); // document older than the navigation
        await page.close();
    }, 30_000);

    it("retries across a navigation (the old document's call errors) until the new one is ready", async () => {
        send.mockReset();
        send.mockRejectedValueOnce(new Error("Inspected target navigated or closed")).mockResolvedValueOnce("ready");
        await waitBridgeReady(3000, 300, Date.now());
        expect(send).toHaveBeenCalledTimes(2);
    });
});
