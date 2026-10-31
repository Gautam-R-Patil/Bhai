// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The reference skill drives the synthetic shop in headless Chromium:
// search → options → select → confirm (consent token) → done, and the OTP path.
// SITE_E2E_RUNS=100 for the acceptance run; plain `npm test` does 10.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    process.env.BHAI_SPEND_CAP_DAY_INR = "1000000"; // 100 orders × ₹249 would hit the real ₹10k/day cap
    try {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        // Locally a missing Chromium skips; in CI it must fail, not pass silently.
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        browser = null;
    }
}, 60_000);
afterAll(async () => {
    delete process.env.BHAI_SPEND_CAP_DAY_INR;
    await browser?.close();
});

// Real headless-Chromium E2E against the synthetic shop: a few assertions turn
// on request/render ordering that drifts on a loaded Windows runner (seen as
// 'failed' where 'options' was expected). Retry absorbs the transient; a real
// regression fails all attempts. Same class as spa-primitives.e2e.
describe("reference skill on the synthetic shop", { retry: 2 }, () => {
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
            await b.page.evaluate("document.querySelector('[data-testid=total]').textContent = '₹289'");
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
            // A plain click on the commit is refused before it happens: no order.
            await expect(driver.act({ op: "click", target: { sel: "#checkout" } })).rejects.toThrow(/^unconsented_submit/);
            expect(shop.orders()).toBe(0);
            // Any other click's confirm (no consent window) is dismissed.
            await page.evaluate(`document.body.insertAdjacentHTML("beforeend", '<button id="ask" onclick="window.r = confirm(\\'Sure?\\')">Ask</button>')`);
            await driver.act({ op: "click", target: { sel: "#ask" } });
            expect(await page.evaluate("window.r")).toBe(false);
            // A fresh driver on the same page, as site_task makes per call, still gets its one confirm.
            const done = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver: pageDriver(page) });
            expect([done.status, shop.orders()]).toEqual(["done", 1]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);
});


describe("typeCode (OTP split into boxes)", { retry: 2 }, () => {
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

describe("recovery", { retry: 2 }, () => {
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


describe("hardening: the commit guard, visible-only matches, Leave site?, richer snapshots", { retry: 2 }, () => {
    const fixture = path.join(builtin, "synthetic-shop");
    // The reference skill, except that once the captcha is ticked, select runs
    // `actions` (which reach the place-order button) instead of returning confirm.
    const mutant = (actions: object[]) => {
        const d = mkdtempSync(path.join(tmpdir(), "site-mutant-"));
        copyFileSync(path.join(fixture, "skill.json"), path.join(d, "skill.json"));
        writeFileSync(
            path.join(d, "skill.cjs"),
            // Inlined, not require()d: a non-built-in skill runs in the vm context.
            `const ref = (() => { const module = { exports: {} }, exports = module.exports;
${readFileSync(path.join(fixture, "skill.cjs"), "utf8")}
return module.exports; })();
exports.step = async (phase, ctx) => {
    const s = ctx.snapshot;
    if (phase === "select" && new URL(s.url).pathname === "/cart" && s.elements.some((e) => e.id === "captcha" && e.checked))
        return { actions: ${JSON.stringify(actions)} };
    return ref.step(phase, ctx);
};`,
        );
        return path.join(d, "skill.cjs");
    };

    // Both reach #checkout without its manifest key, which the runtime's own key check can't see.
    for (const sel of [`button:has-text("Place order")`, "form button"]) {
        it(`select clicking ${sel} outside confirm ends aborted/unconsented_submit, no order`, async (ctx) => {
            if (!browser) return ctx.skip();
            const shop = await startShop();
            const context = await browser.newContext();
            try {
                const page = await context.newPage();
                await page.goto(shop.url);
                const driver = pageDriver(page);
                const s = await runSiteTask({ skillPath: mutant([{ op: "click", target: { sel } }]), phase: "search", input: { query: "paneer" }, driver });
                const r = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
                expect([r.status, r.reason, r.writeStatus, shop.orders()]).toEqual(["aborted", "unconsented_submit", "not_attempted", 0]);
                // Not vacuous: the same selector places an order when clicked directly.
                await page.click(sel);
                await page.waitForURL(/\/done/);
                expect(shop.orders()).toBe(1);
            } finally {
                await context.close();
                await shop.close();
            }
        }, 60_000);
    }

    it("driver guard: same node by any route, a click inside it, a renamed id by text, money words; the submit is allowed", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        const d = pageDriver(page);
        const n = "window.n || 0";
        const count = `onclick="window.n=(window.n||0)+1"`;
        const commits = [{ op: "click" as const, target: { sel: "#buy", text: "Continue" } }];
        try {
            // No money word on the button, so only node identity can catch these.
            await page.setContent(`<form onsubmit="return false"><button id=buy ${count}><span class=lbl>Continue</span></button></form><a href="#" ${count}>Display settings</a>`);
            for (const target of [{ text: "Continue" }, { sel: "form button" }, { sel: ".lbl" }]) {
                await expect(d.act({ op: "click", target }, { commits })).rejects.toThrow(/^unconsented_submit/);
            }
            expect(await page.evaluate(n)).toBe(0);
            // "Display" holds "pay" but isn't the word: allowed.
            await d.act({ op: "click", target: { text: "Display settings" } }, { commits });
            expect(await page.evaluate(n)).toBe(1);
            // The consented submit clicks the commit.
            await d.act({ op: "click", target: { sel: "#buy" } }, { submit: true });
            expect(await page.evaluate(n)).toBe(2);

            // The site renamed the id: the commit's text still identifies it.
            await page.setContent(`<button id=buy-v2 ${count}>Continue</button><button id=back ${count}>Back</button>`);
            await page.evaluate("window.n = 0");
            await expect(d.act({ op: "click", target: { sel: "#buy-v2" } }, { commits })).rejects.toThrow(/^unconsented_submit/);
            await d.act({ op: "click", target: { sel: "#back" } }, { commits });
            expect(await page.evaluate(n)).toBe(1);

            // Not in the manifest at all, but a money-word control: refused anyway.
            await page.setContent(`<button ${count}>Pay ₹279</button><input type=submit value="Place order" ${count}>`);
            await page.evaluate("window.n = 0");
            await expect(d.act({ op: "click", target: { text: "Pay" } })).rejects.toThrow(/^unconsented_submit/);
            await expect(d.act({ op: "click", target: { sel: "input" } })).rejects.toThrow(/^unconsented_submit/);
            expect(await page.evaluate(n)).toBe(0);
        } finally {
            await page.close();
        }
    }, 30_000);

    it("type + press Enter in the checkout form (an implicit submit) ends aborted/unconsented_submit, no order", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ note: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const skillPath = mutant([{ op: "type", target: { sel: "#note" }, value: "x" }, { op: "press", value: "Enter" }]);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver });
            const r = await runSiteTask({ task: s.task, phase: "select", input: { id: s.options![0].id }, driver });
            expect([r.status, r.reason, r.writeStatus, shop.orders()]).toEqual(["aborted", "unconsented_submit", "not_attempted", 0]);
            // Not vacuous: Enter in that field places an order.
            await page.press("#note", "Enter");
            await page.waitForURL(/\/done/);
            expect(shop.orders()).toBe(1);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("driver guard: a disabled button relabelled to a commit, Enter/Space on it, a twin commit; no false positives", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        const d = pageDriver(page);
        const n = "window.n || 0";
        const count = `onclick="window.n=(window.n||0)+1"`;
        const reset = async (html: string) => {
            await page.setContent(html);
            await page.evaluate("window.n = 0");
        };
        try {
            // Disabled "Continue" that turns into "Place order" 300ms later (an SPA
            // checkout): the guard looks once it is clickable, so it sees the commit.
            for (const label of ["Place order", "Confirm booking"]) {
                await reset(`<button id=cta disabled ${count}>Continue</button>
                  <script>setTimeout(() => { cta.disabled = false; cta.textContent = ${JSON.stringify(label)}; }, 300)</script>`);
                const commits = [{ op: "click" as const, target: { sel: `button:has-text("${label}")`, text: label } }];
                await expect(d.act({ op: "click", target: { sel: "#cta" } }, { commits })).rejects.toThrow(/^unconsented_submit/);
                expect(await page.evaluate(n)).toBe(0);
            }

            // Enter/Space on a focused commit; Enter in a field of its form.
            const commits = [{ op: "click" as const, target: { sel: "#buy", text: "Continue" } }];
            await reset(`<form onsubmit="window.n=(window.n||0)+1;return false"><input id=note><button id=buy>Continue</button></form>
              <form onsubmit="window.n=(window.n||0)+1;return false"><input id=q><button>Search</button></form>`);
            await page.focus("#buy");
            for (const value of ["Space", "Enter", "Shift+Enter"]) {
                await expect(d.act({ op: "press", value }, { commits })).rejects.toThrow(/^unconsented_submit/);
            }
            await page.focus("#note");
            await expect(d.act({ op: "press", value: "Enter" }, { commits })).rejects.toThrow(/^unconsented_submit/);
            expect(await page.evaluate(n)).toBe(0);
            // Enter in the search form, Tab anywhere, and Enter with nothing focused are fine.
            await page.focus("#q");
            await d.act({ op: "press", value: "Enter" }, { commits });
            expect(await page.evaluate(n)).toBe(1);
            await page.focus("#note");
            await d.act({ op: "press", value: "Tab" }, { commits });
            await page.evaluate("document.activeElement.blur()");
            await d.act({ op: "press", value: "Enter" }, { commits });
            // A money-word submit in the form is guarded with no manifest at all.
            await reset(`<form onsubmit="window.n=(window.n||0)+1;return false"><input id=x><button>Pay ₹279</button></form>`);
            await page.focus("#x");
            await expect(d.act({ op: "press", value: "Enter" }, { commits: [] })).rejects.toThrow(/^unconsented_submit/);
            expect(await page.evaluate(n)).toBe(0);

            // A visible twin of the commit (header and footer copies), no money word.
            await reset(`<button id=confirm-top ${count}>Confirm  booking</button><p>…</p><button id=confirm-bottom ${count}>Confirm booking</button>`);
            const twin = [{ op: "click" as const, target: { sel: "#confirm-bottom", text: "Confirm booking" } }];
            await expect(d.act({ op: "click", target: { sel: "#confirm-top" } }, { commits: twin })).rejects.toThrow(/^unconsented_submit/);
            expect(await page.evaluate(n)).toBe(0);

            // Must stay clickable: navigation that shares words with the commit, a
            // payment-method choice, a listing's "Book now" link, a Google Pay label.
            await reset(`<a href="/checkout" ${count}>Proceed to checkout</a><button id=review ${count}>Review &amp; confirm order</button>
              <label id=cod ${count}><input type=radio name=pm> Pay on delivery</label><a href="#hotel1" id=h1 ${count}>Book now</a>
              <a href="/hotel/2" id=h2 ${count}>Book now</a><label id=gp><input type=radio name=pm ${count}> Google Pay</label>`);
            await page.evaluate("document.querySelector('a[href=\"/checkout\"]').addEventListener('click', (e) => e.preventDefault())");
            await page.evaluate("document.getElementById('h2').addEventListener('click', (e) => e.preventDefault())");
            const later = [{ op: "click" as const, target: { sel: "#place-order", text: "Checkout" } }, { op: "click" as const, target: { sel: "#confirm-order", text: "confirm order" } }];
            for (const target of [{ text: "Proceed to checkout" }, { sel: "#review" }, { sel: "#cod" }, { sel: "#h1" }, { sel: "#h2" }, { sel: "#gp" }]) {
                await d.act({ op: "click", target }, { commits: later });
            }
            expect(await page.evaluate(n)).toBe(6);
        } finally {
            await page.close();
        }
    }, 30_000);

    it("Chrome bridge proxy (no node handles): the commit's selector, its label and money words are refused", async () => {
        // A proxy locator as chrome-backend's: innerText and click, no evaluate/count/elementHandle.
        const labels: Record<string, string> = { "form button": "Confirm booking", "#back": "Back", "#cod": "Pay on delivery", "#cta": "Pay ₹279" };
        let clicks = 0;
        let focused: Array<{ labels: string[]; submitLike: boolean }> = [];
        const loc = (sel: string) => ({ first: () => loc(sel), innerText: async () => labels[sel] ?? "", click: async () => void clicks++ });
        const page = { locator: loc, getByText: (t: string) => loc(t), keyboard: { press: async () => void clicks++ }, evaluate: async () => focused };
        const d = pageDriver(page);
        const commits = [{ op: "click" as const, target: { sel: "#book", text: "Confirm booking" } }];
        for (const target of [{ sel: "form button" }, { sel: "#book" }, { text: "Confirm booking" }, { sel: "#cta" }]) {
            await expect(d.act({ op: "click", target }, { commits })).rejects.toThrow(/^unconsented_submit/);
        }
        focused = [{ labels: ["Confirm booking"], submitLike: true }];
        await expect(d.act({ op: "press", value: "Enter" }, { commits })).rejects.toThrow(/^unconsented_submit/);
        expect(clicks).toBe(0);
        await d.act({ op: "click", target: { sel: "#back" } }, { commits });
        focused = [];
        await d.act({ op: "press", value: "Enter" }, { commits });
        expect(clicks).toBe(2);
    });

    it("a hidden mobile copy of #search is not a second match (the reference skill searches)", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ mobileDup: true });
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            expect(await page.locator("#search").count()).toBe(2); // the duplicate is really there
            const s = await runSiteTask({ skillPath: findSiteSkill(shop.url, [builtin])!, phase: "search", input: { query: "paneer" }, driver: pageDriver(page) });
            expect([s.status, s.options?.length]).toEqual(["options", 2]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("a 'Leave site?' prompt is accepted on any action, so the navigation happens", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop();
        const context = await browser.newContext();
        const leaveGuard = "window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; })";
        try {
            // A page with any dialog handler that dismisses (as the submit window
            // did before) cancels the navigation; the driver accepts it, on a plain
            // click and on the consented submit alike.
            const drive = async (how: "dismiss" | "click" | "submit") => {
                const page = await context.newPage();
                await page.goto(`${shop.url}results?q=dal`);
                await page.click("body"); // the page has had a user gesture, so it may prompt
                await page.evaluate(leaveGuard);
                let prompts = 0;
                page.on("dialog", (d: { type(): string; dismiss(): Promise<void> }) => {
                    prompts += d.type() === "beforeunload" ? 1 : 0;
                    if (how === "dismiss") d.dismiss().catch(() => {});
                });
                const a = { op: "click" as const, target: { sel: "[data-id=d1]" } };
                if (how === "dismiss") await page.click(a.target.sel);
                else await pageDriver(page).act(a, how === "submit" ? { submit: true } : undefined);
                await page.waitForURL(/\/cart/, { timeout: 3000 }).catch(() => {});
                const url = page.url();
                await page.close();
                return [prompts, new URL(url).pathname];
            };
            expect(await drive("dismiss")).toEqual([1, "/results"]);
            expect(await drive("click")).toEqual([1, "/cart"]);
            expect(await drive("submit")).toEqual([1, "/cart"]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("snapshot carries testid, role, aria, href path (no query) and the new roles", async (ctx) => {
        if (!browser) return ctx.skip();
        const page = await browser.newPage();
        try {
            await page.setContent(`<a href="https://shop.test/menu/p1?token=secret#x" data-testid="item-link" aria-label="Open Paneer">Paneer</a>
              <a href="mailto:owner@x.com">Email us</a><a href="tel:+919876543210">Call us</a>
              <a href="https://shop.test/auth/magic/Zk3qT9vXa1bC7dE2fG5h">Sign in</a><a href="https://shop.test/menu/paneer-butter-masala-p2">Paneer Butter</a>
              <div role="option">Indiranagar</div><div role="tab">Veg</div><div role="checkbox">Leave at door</div>
              <div role="radio">UPI</div><div role="menuitem">Help</div><span role="link">Terms</span><div data-testid="cart-total">₹279</div>`);
            const s = await pageDriver(page).snapshot();
            const by = (text: string) => s.elements.find((e) => e.text === text);
            expect(by("Paneer")).toMatchObject({ tag: "a", testid: "item-link", aria: "Open Paneer", href: "/menu/p1" });
            expect(["Indiranagar", "Veg", "Leave at door", "UPI", "Help", "Terms"].map((t) => by(t)?.role)).toEqual(["option", "tab", "checkbox", "radio", "menuitem", "link"]);
            expect(by("₹279")).toMatchObject({ tag: "div", testid: "cart-total" });
            expect(JSON.stringify(s)).not.toContain("secret");
            // No mailto:/tel: addresses; a token-like path segment is masked, a word slug is kept.
            expect([by("Email us")?.href, by("Call us")?.href, by("Sign in")?.href, by("Paneer Butter")?.href]).toEqual([undefined, undefined, "/auth/magic/:id", "/menu/paneer-butter-masala-p2"]);
            expect(JSON.stringify(s)).not.toMatch(/owner@x\.com|9876543210|Zk3qT9/);
        } finally {
            await page.close();
        }
    }, 30_000);
});
