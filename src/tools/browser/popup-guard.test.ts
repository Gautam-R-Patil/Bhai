// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A page with a "Leave site?" prompt must not hang the agent's next navigation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachPopupGuard, MONEY_WORDS } from "./popup-guard.js";

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

describe("popup guard", () => {
    it("money words: the labels that place an order or pay, never everyday ones", () => {
        const money =
            "Place order|Place your order|Pay ₹249|Pay now|Proceed to pay|Proceed to payment|Book now|Make payment|Buy Now|Confirm order|Confirm your purchase|Confirm booking|Complete purchase|Complete your order|Submit order|Checkout & pay later".split(
                "|",
            );
        const plain = "Continue|Add to cart|Search|Apply coupon|View order|Order history|Repay tips|Review & confirm order".split("|");
        expect(money.filter((l) => !MONEY_WORDS.test(l))).toEqual([]);
        expect(plain.filter((l) => MONEY_WORDS.test(l))).toEqual([]);
    });

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

    it("hides a real full-screen backdrop, never a Tailwind backdrop-blur header", async (ctx) => {
        if (!browser) return ctx.skip();
        const { dismissOverlayModals } = await import("./popup-guard.js");
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.setContent(`<header id=h class="backdrop-blur-md" style="position:fixed;top:0;left:0;width:100%;height:64px;z-index:50">Nav</header>
            <div id=o class="modal-backdrop" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)"></div>`);
        await dismissOverlayModals(page);
        expect(await page.isVisible("#h")).toBe(true);
        expect(await page.isVisible("#o")).toBe(false);
        await page.close();
    }, 30_000);

    // Escape and clicks are counted page-wide; the guard may act only inside an open overlay that is no keeper.
    const COUNT = `<script>window.esc = 0; addEventListener("keydown", (e) => { if (e.key === "Escape") window.esc++; }, true);</script>`;

    it("never clicks a page's own × (a cart's Remove item) or presses Escape with no overlay open", async (ctx) => {
        if (!browser) return ctx.skip();
        const { dismissOverlayModals } = await import("./popup-guard.js");
        const page = await browser.newPage();
        await page.setContent(`${COUNT}<p id=line>Paneer Tikka ₹249</p>
            <button class="close" aria-label="Close" data-dismiss="modal" onclick="document.getElementById('line').remove()">×</button>`);
        await dismissOverlayModals(page);
        expect(await page.isVisible("#line")).toBe(true);
        expect(await page.evaluate("window.esc")).toBe(0);
        await page.close();
    }, 30_000);

    it("leaves a payment sheet alone: no close click, no Escape, not hidden", async (ctx) => {
        if (!browser) return ctx.skip();
        const { dismissOverlayModals } = await import("./popup-guard.js");
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const sheet = (
            inner: string,
        ) => `${COUNT}<div id=sheet class="modal" role=dialog aria-modal=true style="position:fixed;inset:0;z-index:1000;background:#fff">
            ${inner}<button data-dismiss="modal" aria-label="Close" onclick="window.closed=1">×</button></div>`;
        // Each alone makes it a keeper: a frame, a card field, a code field, a price, a money word.
        for (const inner of [
            `<iframe srcdoc="<p>card</p>"></iframe>`,
            `<input autocomplete="cc-number">`,
            `<input name="otp">`,
            `<p>Total ₹249</p>`,
            `<button>Pay now</button>`,
        ]) {
            await page.setContent(sheet(inner));
            await dismissOverlayModals(page);
            expect([
                inner,
                await page.isVisible("#sheet"),
                await page.evaluate("window.closed || 0"),
                await page.evaluate("window.esc"),
            ]).toEqual([inner, true, 0, 0]);
        }
        await page.close();
    }, 30_000);

    it("closes an open newsletter modal by its own × and nothing outside it", async (ctx) => {
        if (!browser) return ctx.skip();
        const { dismissOverlayModals } = await import("./popup-guard.js");
        const page = await browser.newPage();
        await page.setContent(`<button class="close" aria-label="Close" onclick="window.page=1">×</button>
            <div id=nl class="newsletter-modal" style="position:fixed;top:20%;left:20%;width:300px;z-index:100;background:#fff">
            <p>Join our newsletter</p><button aria-label="Close" onclick="document.getElementById('nl').remove()">×</button></div>`);
        await dismissOverlayModals(page);
        expect(await page.isVisible("#nl")).toBe(false);
        expect(await page.evaluate("window.page || 0")).toBe(0);
        await page.close();
    }, 30_000);

    it("reports dialogs: alert accepted, confirm dismissed unless armed", async (ctx) => {
        if (!browser) return ctx.skip();
        const { armDialogAccept, takePageEvents } = await import("./popup-guard.js");
        const context = await browser.newContext();
        attachPopupGuard(context);
        const page = await context.newPage();
        await page.setContent(`<p>x</p>`);
        await page.evaluate(`alert("hi")`);
        expect(await page.evaluate(`confirm("Delete?")`)).toBe(false);
        armDialogAccept(true);
        expect(await page.evaluate(`confirm("Delete?")`)).toBe(true);
        const ev = takePageEvents() as { dialogs: Array<Record<string, string>> };
        expect(ev.dialogs.map((d) => `${d.type}:${d.action}`)).toEqual([
            "alert:accepted",
            "confirm:dismissed",
            "confirm:accepted",
        ]);
        expect(ev.dialogs[1].message).toBe("Delete?");
        expect(takePageEvents()).toEqual({});
        await context.close();
    }, 30_000);
});

