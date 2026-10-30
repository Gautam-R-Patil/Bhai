// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// browser_click_at / browser_type regressions, against headless Chromium when available.
import { afterAll, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: Playwright objects
let browser: any = null;
// getBrowser()'s persistent (headed) profile → a throwaway headless context.
vi.mock("playwright-core", async () => {
    const real = await vi.importActual<typeof import("playwright-core")>("playwright-core");
    return {
        ...real,
        chromium: {
            launchPersistentContext: async () => {
                browser = await real.chromium.launch({ headless: true });
                return await browser.newContext({ viewport: { width: 1280, height: 800 } });
            },
        },
    };
});
vi.mock("./browser-backend.js", async (orig) => ({
    ...(await orig<typeof import("./browser-backend.js")>()),
    getCurrentMode: () => "playwright",
    getActiveBackend: async () => ({ mode: "playwright" }),
}));

const core = await import("./core.js");
const { browserClickAt, browserType, FOCUS_KIND_JS } = await import("./interaction.js");

// biome-ignore lint/suspicious/noExplicitAny: Playwright page
let page: any = null;
try {
    page = await core.getActivePage();
} catch {
    page = null; // no Chromium here
}
afterAll(async () => browser?.close());

async function scan(html: string) {
    await page.setContent(html);
    await page.waitForTimeout(200);
    core.setLastElementMap(await core.getInteractiveElements(page, true));
    return (text: string) => core.getLastElementMap().find((e) => e.text.includes(text))?.label;
}

describe("browser_click_at", () => {
    it("fails fast on a label whose element is gone (no 30s Locator wait)", async (ctx) => {
        if (!page) return ctx.skip();
        await page.setContent(`<button id=old onclick="window.hit=1">Old</button>`);
        const el = { label: 1, x: 30, y: 20, tag: "button", text: "Old", atlasId: "aria-1" };
        // an aria-ref Locator handle (what the snapshot scan stores), then a stale ElementHandle
        for (const handle of [page.locator("#old"), await page.$("#old")]) {
            await page.setContent(`<button id=old onclick="window.hit=1">Old</button>`);
            core.setLastElementMap([{ ...el, handle: handle ?? (await page.$("#old")) }]);
            await page.setContent(`<p>new page</p><button onclick="window.hit=2" style="position:fixed;left:0;top:0;width:200px;height:60px">Other</button>`);
            const t0 = Date.now();
            const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
            expect(Date.now() - t0).toBeLessThan(8000);
            expect(r.error).toMatch(/vanished/);
            expect(await page.evaluate("window.hit || 0")).toBe(0); // no blind click at the stale spot
        }
    }, 60_000);

    it("an early return does not leave accept_dialog armed", async (ctx) => {
        if (!page) return ctx.skip();
        await page.setContent(`<p>x</p>`);
        const r = JSON.parse(await browserClickAt.handler({ label: 999, accept_dialog: true }));
        expect(r.error).toMatch(/not found/);
        expect(await page.evaluate(`confirm("Delete all?")`)).toBe(false);
    }, 40_000);
});

describe("browser_type", () => {
    it("press_enter without text still presses Enter", async (ctx) => {
        if (!page) return ctx.skip();
        const label = (
            await scan(`<form onsubmit="window.sub=1;return false"><input aria-label="Query" value="cats"></form>`)
        )("Query");
        expect(label).toBeDefined();
        const r = JSON.parse(await browserType.handler({ label, press_enter: true }));
        expect(r.success).toBe(true);
        expect(await page.evaluate("window.sub || 0")).toBe(1);
    }, 40_000);

    it("sees a focused field inside a shadow root; a cross-origin iframe is unknown", async (ctx) => {
        if (!page) return ctx.skip();
        await page.setContent(`<x-in></x-in><script>
            const r = document.querySelector("x-in").attachShadow({ mode: "open" });
            r.innerHTML = '<input value="old@x.com">';
            r.querySelector("input").focus();
        </script>`);
        expect(await page.evaluate(FOCUS_KIND_JS)).toBe("field");
        await page.setContent(`<iframe src="data:text/html,<input id=i>"></iframe>`);
        const frame = page.frames()[1];
        await frame.waitForSelector("#i");
        await frame.focus("#i");
        expect(await page.evaluate(FOCUS_KIND_JS)).toBe("unknown");
    }, 40_000);
});
