// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The reference skill drives the synthetic shop in headless Chromium:
// search → options → select → confirm (consent token) → done, and the OTP path.
// SITE_E2E_RUNS=100 for the acceptance run; plain `npm test` does 10.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageDriver } from "../page-driver.js";
import { mintConsent, runSiteTask } from "../runtime.js";
import { findSiteSkill } from "../registry.js";
import { SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

const RUNS = Number(process.env.SITE_E2E_RUNS ?? 10);
const builtin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
// biome-ignore lint/suspicious/noExplicitAny: Playwright BrowserContext
let shopRoute: (c: any) => Promise<any> = async (c) => c;
beforeAll(async () => {
    process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000"; // 100 orders × ₹249 would hit the real ₹10k/day cap
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        // Locally a missing Chromium skips; in CI it must fail, not pass silently.
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        browser = null;
    }
}, 60_000);
afterAll(async () => {
    delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    await browser?.close();
});

describe("reference skill on the synthetic shop", () => {
    it(`search → select → confirm → done, ${RUNS}/${RUNS}`, async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop();
        shopRoute = shop.route;
        const skillPath = findSiteSkill(shop.url, [builtin]);
        expect(skillPath).toBeTruthy();
        try {
            for (let i = 0; i < RUNS; i++) {
                const context = await shopRoute(await browser.newContext());
                const page = await context.newPage();
                await page.goto(shop.url);
                const driver = pageDriver(page);
                const s = await runSiteTask({ skillPath: skillPath!, phase: "search", input: { query: "paneer" }, driver });
                expect(s.status).toBe("options");
                expect(s.options?.length).toBeGreaterThan(0);
                const c = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
                expect(c.status).toBe("confirm");
                expect(c.confirm?.amount).toBe(249);
                const d = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
                expect([d.status, d.summary]).toEqual(["done", `Order placed #${i + 1}`]);
                expect(shop.orders()).toBe(i + 1); // exactly one order per run
                await context.close();
            }
        } finally {
            await shop.close();
        }
    }, 600_000);

    it("OTP: asks the user, re-asks after a wrong code, finishes with the right one", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ otp: true });
        shopRoute = shop.route;
        const skillPath = findSiteSkill(shop.url, [builtin])!;
        const context = await shopRoute(await browser.newContext());
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "dal" }, driver });
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
            const ask = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
            // The owner sees the manifest's fixed prompt, never page text.
            expect([ask.status, ask.needsUser?.kind, ask.needsUser?.prompt]).toEqual(["needs_user", "otp", "Enter the code the shop sent to your phone"]);
            const wrong = await runSiteTask({ task: ask.task, phase: "resume", answer: "000000", driver });
            expect([wrong.status, wrong.needsUser?.retry]).toEqual(["needs_user", "That didn't work. Please check it and send it again."]);
            const done = await runSiteTask({ task: wrong.task, phase: "resume", answer: "123456", driver });
            expect(done.status).toBe("done");
            expect(shop.orders()).toBe(1);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 120_000);

    it("site changes: a renamed button still works, a late fee is re-confirmed, an ambiguous click is refused", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop();
        shopRoute = shop.route;
        const skillPath = findSiteSkill(shop.url, [builtin])!;
        const flow = async () => {
            const context = await shopRoute(await browser.newContext());
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver });
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
            return { context, page, driver, c };
        };
        try {
            shop.set({ renameIds: true }); // #checkout is now #place-order-v2
            const a = await flow();
            const done = await runSiteTask({ task: a.c.task, phase: "confirm", consentToken: mintConsent(a.c.task), driver: a.driver });
            expect([done.status, done.writeStatus, shop.orders()]).toEqual(["done", "applied", 1]);
            await a.context.close();

            shop.set({ renameIds: false });
            const b = await flow();
            const token = mintConsent(b.c.task);
            // A delivery fee appears in the page after the owner's yes.
            await b.page.evaluate("document.querySelector('p').textContent = 'Paneer Tikka ₹289'");
            const r = await runSiteTask({ task: b.c.task, phase: "confirm", consentToken: token, driver: b.driver });
            expect([r.reason, r.confirm?.amount, shop.orders()]).toEqual(["total_changed", 289, 1]);
            await b.context.close();

            const page = await browser.newPage();
            await page.setContent(`<button onclick="window.n=(window.n||0)+1">Add</button><button onclick="window.n=(window.n||0)+1">Add</button>`);
            await expect(pageDriver(page).act({ op: "click", target: { text: "Add" } })).rejects.toThrow(/ambiguous_target/);
            expect(await page.evaluate("window.n || 0")).toBe(0);
            await page.close();
        } finally {
            await shop.close();
        }
    }, 120_000);

    it("a 'Place order?' confirm is accepted only inside the consented submit", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ confirmPopup: true });
        shopRoute = shop.route;
        const skillPath = findSiteSkill(shop.url, [builtin])!;
        const context = await shopRoute(await browser.newContext());
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "dal" }, driver });
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
            // A plain click (no consent window) gets the confirm dismissed: no order.
            await driver.act({ op: "click", target: { sel: "#checkout" } });
            expect(shop.orders()).toBe(0);
            const done = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
            expect([done.status, shop.orders()]).toEqual(["done", 1]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);
});


describe("typeCode (OTP split into boxes)", () => {
    it("fills six boxes, leaves a promo field alone, refuses a wrong length, doesn't split address fields", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        const boxes = Array.from({ length: 6 }, (_, i) => `<input id=c${i + 1} maxlength=1>`).join("");
        await page.setContent(`<form>${boxes}<input id=promo placeholder="promo code"></form>`);
        const d = pageDriver(page);
        await d.act({ op: "typeCode", target: { sel: "#c1" }, value: "482913" });
        expect(await page.evaluate("[...document.querySelectorAll('[maxlength]')].map((b) => b.value).join('')")).toBe("482913");
        expect(await page.evaluate("document.getElementById('promo').value")).toBe("");

        await page.setContent(`<form>${boxes}</form>`);
        await expect(d.act({ op: "typeCode", target: { sel: "#c1" }, value: "4829131" })).rejects.toThrow(/count_mismatch/);
        expect(await page.evaluate("[...document.querySelectorAll('input')].map((b) => b.value).join('')")).toBe("");

        await page.setContent(`<form>${Array.from({ length: 6 }, (_, i) => `<input id=a${i}>`).join("")}</form>`);
        await d.act({ op: "typeCode", target: { sel: "#a0" }, value: "482913" });
        expect(await page.evaluate("[...document.querySelectorAll('input')].map((b) => b.value)")).toEqual(["482913", "", "", "", "", ""]);
        await page.close();
    }, 30_000);
});

describe("recovery", () => {
    it("a 5-second network drop is waited out; a closed tab is reopened and the task carries on", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop();
        shopRoute = shop.route;
        const skillPath = findSiteSkill(shop.url, [builtin])!;
        const context = await shopRoute(await browser.newContext());
        try {
            let page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page, 5000, async () => (page = await context.newPage()));
            await context.setOffline(true);
            setTimeout(() => context.setOffline(false), 5000);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver });
            expect(s.status).toBe("options");

            await page.close(); // the user closed the tab
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
            expect(c.status).toBe("confirm");
            const done = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
            expect([done.status, shop.orders()]).toEqual(["done", 1]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("a page reload between the yes and the payment is recovered (the box is ticked again), one order", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop();
        const skillPath = findSiteSkill(shop.url, [builtin])!;
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver });
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
            const token = mintConsent(c.task);
            await page.reload(); // captcha box unticked
            const done = await runSiteTask({ task: c.task, phase: "confirm", consentToken: token, driver });
            expect([done.status, shop.orders()]).toEqual(["done", 1]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);
});

