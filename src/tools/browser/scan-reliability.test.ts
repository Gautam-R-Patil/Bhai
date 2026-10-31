// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Element scan / locator regressions, against headless Chromium when available.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromeLocatorProxy } from "./chrome-backend.js";
import { buildElementsText, formatAriaTree, getInteractiveElements, parseAriaSnapshot } from "./core.js";

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

describe("parseAriaSnapshot / formatAriaTree", () => {
    const yaml = [
        '- banner [ref=e2]:',
        '  - link "Home \\"page\\"" [ref=e3] [cursor=pointer]:',
        '    - /url: "#"',
        "  - textbox [ref=e4]",
        '  - button "Old style"',
        "  - generic [ref=e5]:",
        '  - heading "Title" [level=1] [ref=e6]',
    ].join("\n");
    it("keeps interactive nodes, unnamed ones only with a ref", () => {
        expect(parseAriaSnapshot(yaml).map((p) => [p.role, p.name, p.ref])).toEqual([
            ["link", 'Home "page"', "e3"],
            ["textbox", "", "e4"],
            ["button", "Old style", ""],
        ]);
    });
    it("strips refs, cursor and url noise from the tree", () => {
        const t = formatAriaTree(yaml);
        expect(t).not.toMatch(/ref=|cursor=|\/url|generic/);
        expect(t).toContain('heading "Title" [level=1]');
    });
});

describe("live scan", () => {
    it("finds body + iframe elements past a hidden nav, with page coordinates", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const nav = Array.from({ length: 120 }, (_, i) => `<a href="#n${i}" style="display:none">Nav ${i}</a>`).join("");
        await page.setContent(`<header>${nav}</header><button>Go now</button>
            <iframe srcdoc="<button onclick='parent.inner=1'>Inner</button>" style="position:absolute;top:300px;left:200px;width:300px;height:200px;border:0"></iframe>
            <iframe src="data:text/html,<button>XOrigin</button>" style="position:absolute;top:550px;left:200px;width:300px;height:100px;border:0"></iframe>`);
        await page.waitForTimeout(300);
        const els = await getInteractiveElements(page, true);
        const by = (t: string) => els.find((e) => e.text === t);
        expect(by("Go now")).toBeTruthy();
        expect(by("XOrigin")?.y).toBeGreaterThan(550);
        const inner = by("Inner");
        expect(inner?.x).toBeGreaterThan(200);
        expect(inner?.y).toBeGreaterThan(300);
        await inner?.handle.click({ timeout: 2000 });
        expect(await page.evaluate("window.inner")).toBe(1);
        expect(buildElementsText()).toContain("Go now");
        await page.close();
    }, 30_000);

    it("DOM-scan fallback offsets iframe hits by the iframe position", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        // No ARIA-interactive nodes → the SCAN_FRAME_JS fallback runs.
        await page.setContent(`<iframe srcdoc="<div style='cursor:pointer;width:80px;height:30px' onclick='1'>Pay</div>"
            style="position:absolute;top:400px;left:300px;width:300px;height:200px;border:0"></iframe>`);
        await page.waitForTimeout(300);
        const pay = (await getInteractiveElements(page, true)).find((e) => e.text === "Pay");
        expect(pay?.x).toBeGreaterThan(300);
        expect(pay?.y).toBeGreaterThan(400);
        await page.close();
    }, 30_000);

    it("DOM-scan fallback keeps code editors and shadow-DOM controls", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        // No ARIA-interactive nodes → the SCAN_FRAME_JS fallback runs.
        await page.setContent(`<div class="monaco-editor" style="width:400px;height:200px"></div><div id=host></div>
            <script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
                "<div role=tab style='width:80px;height:30px'>Inside</div>";</script>`);
        await page.waitForTimeout(300);
        const els = await getInteractiveElements(page, true);
        expect(els.find((e) => e.editorType === "monaco")?.handle).toBeTruthy();
        expect(els.find((e) => e.text === "Inside")?.handle).toBeTruthy();
        await page.close();
    }, 30_000);

    it("ChromeLocatorProxy resolves xpath and nth matches (not :first-of-type)", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        await page.setContent(`<div><span>x</span><p id=a class=c>one</p></div><p id=b class=c>two</p><p id=c class=c>three</p>`);
        const run = (l: ChromeLocatorProxy) => page.evaluate(l.withEl("return el ? el.id : null;"));
        expect(await run(new ChromeLocatorProxy(".c").first())).toBe("a");
        expect(await run(new ChromeLocatorProxy(".c").nth(1))).toBe("b");
        expect(await run(new ChromeLocatorProxy(".c").last())).toBe("c");
        expect(await run(new ChromeLocatorProxy("xpath=//*[contains(text(),'two')]").first())).toBe("b");
        await page.close();
    }, 30_000);
});
