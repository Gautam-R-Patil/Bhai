// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// P1 of the Skill Minter, offline: the recorder turns a session on the
// synthetic shop into a trace, and replay proves the reference skill does what
// the session did, phase by phase, with no model call and no network. Each
// mutant (a skill with one classic minting mistake) must fail with its verdict.
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SHOP_RESOLVER_ARG, startShop } from "../../__tests__/synthetic-shop.js";
import { SkillHost } from "../../host.js";
import { commitEvent, drainTrace, loadTrace, startTrace, stopTrace } from "../recorder.js";
import { payableOk, replaySkill } from "../replay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "../../__tests__/fixtures/synthetic-shop");
const lib = createRequire(import.meta.url)(path.resolve(here, "../../../../../scripts/site-skill-lib.cjs"));
const tmp = () => mkdtempSync(path.join(tmpdir(), "site-mint-"));
const INPUT = { query: "paneer" };
const OTP = "123456";

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
let traceDir = "";
let navTraceDir = ""; // the same search, reached by typing the results URL instead
const filesIn = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
        f.isDirectory() ? filesIn(path.join(dir, f.name)) : [readFileSync(path.join(dir, f.name), "utf8")],
    );

beforeAll(async () => {
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        return;
    }
    // The agent's session, with plain Playwright calls standing in for its
    // browser tools, and a drain after each one. A hidden mobile copy of
    // #search is on the home page, as on a responsive site.
    const shop = await startShop({ otp: true, mobileDup: true });
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        traceDir = (await startTrace(context, "shop.test", { root: tmp() })).dir;
        await page.goto(shop.url);
        await drainTrace(page);
        for (const [step, consented] of [
            [() => page.click("#accept"), false],
            [() => page.fill("#q", INPUT.query), false],
            [() => page.locator("#search").filter({ visible: true }).click(), false],
            [() => page.click('[data-id="p1"]'), false],
            [() => page.click("#captcha"), false],
            [() => page.click("#checkout"), true], // the click the owner said yes to
            [() => page.fill("#otp", OTP), false],
            [() => page.click("#verify"), false],
        ] as Array<[() => Promise<void>, boolean]>) {
            await step();
            await drainTrace(page, { consented });
        }
        await stopTrace(page);
        expect(shop.orders()).toBe(1);

        // The agent's browser_navigate straight to the results: no typing recorded.
        navTraceDir = (await startTrace(context, "shop.test", { root: tmp() })).dir;
        await context.clearCookies();
        await page.goto(shop.url);
        await drainTrace(page);
        await page.click("#accept");
        await drainTrace(page);
        await page.goto(new URL(`/results?q=${INPUT.query}`, shop.url).href);
        await drainTrace(page);
        await page.click('[data-id="p1"]');
        await drainTrace(page);
        await stopTrace(page);
    } finally {
        await context.close();
        await shop.close();
    }
}, 60_000);
afterAll(async () => {
    await browser?.close();
});

describe("recorder", () => {
    it("records one stable event per action, on the page it was done on, and finds the commit", (ctx) => {
        if (!browser) return ctx.skip();
        const t = loadTrace(traceDir);
        const brief = (e: { op: string; target: { id?: string; dataId?: string }; value?: string | null }) =>
            [e.op, e.target.id ?? e.target.dataId, e.value].filter((x) => x != null).join(" ");
        expect(t.pages.map((p) => p.events.map(brief))).toEqual([
            ["click accept"],
            ["fill q paneer"],
            ["click search"],
            ["click p1"],
            ["click captcha"],
            ["click checkout"],
            ["typeCode otp {{answer}}"], // a plain <input name="otp"> is a code field too
            ["click verify"],
            [],
        ]);
        expect(t.pages.map((p) => new URL(p.url).pathname)).toEqual([
            "/",
            "/",
            "/",
            "/results",
            "/cart",
            "/cart",
            "/otp",
            "/otp",
            "/done",
        ]);
        expect(t.pages[3].events[0].target).toMatchObject({ tag: "a", dataId: "p1", text: "Add", href: "/cart?id=p1" });
        expect(t.pages[3].events[0].target.path).toMatch(/^body > /);
        expect(t.pages[1].events[0].target.text).toBeUndefined(); // an input's typed value never becomes its label

        const c = commitEvent(t);
        expect(c).toMatchObject({
            k: 5,
            i: 0,
            event: { op: "click", consented: true, target: { id: "checkout", text: "Place order" } },
        });
        // Without the consent mark, the payment-labelled click is still found.
        const unmarked = { pages: t.pages.map((p) => ({ ...p, events: p.events.map(({ consented: _, ...e }) => e) })) };
        expect(commitEvent(unmarked)).toMatchObject({ k: 5, event: { target: { id: "checkout" } } });

        // The capture: the hidden mobile #search stamped, form state kept, live page untouched.
        expect(t.pages[0].html.match(/<button[^>]*data-bhai-hidden[^>]*>Search/g)).toHaveLength(1);
        expect(t.pages[2].html).toMatch(/<input id="q" name="q" value="paneer">/);
        expect(t.pages[5].html).toMatch(/id="captcha"[^>]*checked/);
        expect(t.pages[4].snapshot.elements.map((e) => e.id).filter(Boolean)).toEqual(["captcha", "checkout"]);
        // The code the owner typed is nowhere on disk: not the event, the HTML or the snapshot.
        for (const text of filesIn(traceDir)) expect(text).not.toContain(OTP);
        expect(t.pages[7].snapshot.elements.find((e) => e.id === "otp")).toMatchObject({ text: "" });
    });

    it("takes a submit-like money control as the commit without a consent mark, never a payment choice", () => {
        const url = "https://x.in/checkout";
        const ev = (tag: string, text: string, extra: object = {}) => ({
            op: "click" as const,
            target: { tag, text, path: "body", ...extra },
            url,
        });
        const on = (...events: ReturnType<typeof ev>[]) => ({ pages: [{ k: 0, url, title: "", events }] });
        expect(commitEvent(on(ev("label", "Pay on delivery"), ev("button", "Confirm")))).toBeNull();
        expect(commitEvent(on(ev("input", "Pay now", { type: "radio" }), ev("button", "Place order")))).toMatchObject({
            i: 1,
        });
        expect(commitEvent(on(ev("label", "Pay now", { role: "button" })))).toBeNull();
        expect(commitEvent(on(ev("a", "Pay now", { href: "/wallet" })))).toBeNull(); // a link that goes somewhere
        expect(commitEvent(on(ev("a", "Pay now", { href: "/checkout" })))).toMatchObject({ i: 0 }); // href="#"
        expect(commitEvent(on(ev("input", "Pay now", { type: "submit" })))).toMatchObject({ i: 0 });
    });

    it("keeps a commit that leaves for another origin, by click or by Enter, with the page it was made on", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        // ?enter: a form with no button, submitted by Enter in its field.
        await context.route(
            "http://shop.test/pay*",
            (r: { request(): { url(): string }; fulfill(o: object): Promise<void> }) =>
                r.fulfill({
                    contentType: "text/html",
                    body: `<form action="http://checkout.shop.test/ok"><input id="promo" name="promo">${
                        new URL(r.request().url()).searchParams.has("enter")
                            ? ""
                            : '<button id="place">Place order</button>'
                    }</form>`,
                }),
        );
        await context.route("http://checkout.shop.test/**", (r: { fulfill(o: object): Promise<void> }) =>
            r.fulfill({ contentType: "text/html", body: "<h1>Order #AB-1234 confirmed</h1>" }),
        );
        try {
            for (const how of ["click", "press"] as const) {
                const page = await context.newPage();
                const { dir } = await startTrace(context, "shop.test", { root: tmp() });
                await page.goto(`http://shop.test/pay${how === "press" ? "?enter=1" : ""}`);
                await drainTrace(page);
                await page.fill("#promo", "SAVE10");
                await drainTrace(page);
                await (how === "click" ? page.click("#place") : page.press("#promo", "Enter"));
                await page.waitForURL("http://checkout.shop.test/**");
                await drainTrace(page, { consented: true });
                await stopTrace(page);
                await page.close();
                const t = loadTrace(dir);
                expect(t.pages.map((p) => [new URL(p.url).host, p.events.map((e) => e.op)])).toEqual([
                    ["shop.test", ["fill"]],
                    ["shop.test", [how]],
                    ["checkout.shop.test", []],
                ]);
                expect(commitEvent(t)).toMatchObject({ k: 1, i: 0, event: { op: how, consented: true } });
            }
        } finally {
            await context.close();
        }
    });

    it("keeps nothing of a page off the traced domain, and records nothing once stopped", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        await context.route("http://mail.test/**", (r: { fulfill(o: object): Promise<void> }) =>
            r.fulfill({ contentType: "text/html", body: `<p>Inbox: your bank OTP is 998877</p><input id="reply">` }),
        );
        await context.route("http://shop.test/form", (r: { fulfill(o: object): Promise<void> }) =>
            r.fulfill({ contentType: "text/html", body: `<input id="q">` }),
        );
        try {
            const page = await context.newPage();
            const { dir } = await startTrace(context, "shop.test", { root: tmp() });
            await page.goto("http://shop.test/form");
            await drainTrace(page);
            await page.goto("http://mail.test/inbox?u=me");
            await drainTrace(page);
            await page.fill("#reply", "typed-on-mail");
            await drainTrace(page);
            await page.goto("http://shop.test/form");
            await drainTrace(page);
            await page.fill("#q", "dal");
            await drainTrace(page);
            await stopTrace(page);
            const t = loadTrace(dir);
            expect(t.pages.map((p) => [p.url, !!p.offsite, p.events.map((e) => e.value)])).toEqual([
                ["http://shop.test/form", false, []],
                ["http://mail.test/", true, []],
                ["http://mail.test/", true, []],
                ["http://shop.test/form", false, ["dal"]],
                ["http://shop.test/form", false, []],
            ]);
            expect(readdirSync(path.join(dir, "pages")).sort()).toEqual([
                "0.html",
                "0.json",
                "3.html",
                "3.json",
                "4.html",
                "4.json",
            ]);
            for (const text of filesIn(dir))
                for (const bad of ["998877", "Inbox", "typed-on-mail", "/inbox"]) expect(text).not.toContain(bad);

            // Stopped: typing on the open page and on a newly loaded one reaches
            // nothing, and the site's own storage never held an event.
            await page.fill("#q", "after-stop-1");
            await page.goto("http://shop.test/form");
            await page.fill("#q", "after-stop-2");
            expect(await page.evaluate("sessionStorage.length + localStorage.length")).toBe(0);
            // A new trace on the same context records again, from now on only.
            const again = await startTrace(context, "shop.test", { root: tmp() });
            await drainTrace(page);
            await page.fill("#q", "second");
            await drainTrace(page);
            await stopTrace(page);
            expect(loadTrace(again.dir).pages.map((p) => p.events.map((e) => e.value))).toEqual([["second"], []]);
        } finally {
            await context.close();
        }
    });

    it("never keeps a password, turns code boxes into {{answer}}, and records a label click once", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        await context.route("http://shop.test/login", (r: { fulfill(o: object): Promise<void> }) =>
            r.fulfill({
                contentType: "text/html",
                body: `<!doctype html><html><body><form><input id="pw" type="password"><input id="c" autocomplete="one-time-code">
                  <div>${[0, 1, 2, 3].map((n) => `<input class="box" id="b${n}" maxlength="1">`).join("")}</div>
                  <label id="agree"><input type="checkbox"> I agree to the terms and conditions</label></form></body></html>`,
            }),
        );
        try {
            const page = await context.newPage();
            const { dir } = await startTrace(context, "shop.test", { root: tmp() });
            await page.goto("http://shop.test/login");
            await drainTrace(page);
            await page.fill("#pw", "hunter2-secret");
            await page.fill("#c", "424242");
            for (const n of [0, 1, 2, 3]) await page.fill(`#b${n}`, String(n));
            await page.locator("#agree").click({ position: { x: 120, y: 5 } }); // on the text, not the box
            await drainTrace(page);
            await stopTrace(page);
            const t = loadTrace(dir);
            expect(t.pages[0].events.map((e) => [e.op, e.target.id ?? e.target.tag, e.value])).toEqual([
                ["fill", "pw", null],
                ["typeCode", "c", "{{answer}}"],
                ["typeCode", "b0", "{{answer}}"],
                ["click", "agree", undefined],
            ]);
            const onDisk = readdirSync(path.join(dir, "pages")).map((f) =>
                readFileSync(path.join(dir, "pages", f), "utf8"),
            );
            for (const text of [readFileSync(path.join(dir, "trace.jsonl"), "utf8"), ...onDisk]) {
                expect(text).not.toContain("hunter2");
                expect(text).not.toContain("424242");
            }
        } finally {
            await context.close();
        }
    });
});

describe("offline replay", () => {
    it("passes the reference skill on all four phases: no model call, no network, fast", async (ctx) => {
        if (!browser) return ctx.skip();
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            const r = await replaySkill(path.join(fixture, "skill.cjs"), traceDir, {
                input: INPUT,
                answer: OTP,
                browser,
            });
            expect(r.failures).toEqual([]);
            expect(r).toMatchObject({
                ok: true,
                phases: { search: "pass", select: "pass", confirm: "pass", after_confirm: "pass" },
            });
            expect(r.warnings).toEqual([]);
            expect(r.calls).toBeLessThan(25); // a dozen skill calls, each a few ms
            expect(r.ms).toBeLessThan(10_000);
            expect(fetchSpy).not.toHaveBeenCalled(); // the LLM client's only transport
            expect(JSON.stringify(r).length).toBeLessThan(8_192);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("leaves the phases the session never reached unverified, not failed", async (ctx) => {
        if (!browser) return ctx.skip();
        const t = loadTrace(traceDir);
        // The owner stopped on the cart page without ordering.
        const partial = { ...t, pages: t.pages.slice(0, 5).map((p, k) => (k === 4 ? { ...p, events: [] } : p)) };
        const r = await replaySkill(path.join(fixture, "skill.cjs"), partial, { input: INPUT, browser });
        expect(r).toMatchObject({
            ok: true,
            phases: { search: "pass", confirm: "unverified", after_confirm: "unverified" },
        });
    });

    it("takes the payable amount, not the item price or another number on the review page", async (ctx) => {
        if (!browser) return ctx.skip();
        expect(payableOk("Item total ₹249 · Delivery ₹30 · To pay ₹279", 279)).toBe(true);
        expect(payableOk("Item total ₹249 · Delivery ₹30 · To pay ₹279", 249)).toBe(false);
        expect(payableOk("MRP ₹499 · Subtotal ₹249 · Total ₹279 · 2 items · 560001", 279)).toBe(true);
        expect(payableOk("Paneer Tikka ₹249 · qty 2", 2)).toBe(false); // not in rupees
        expect(payableOk("Paneer Tikka ₹249 · Delivery ₹30", 249)).toBe(true); // no total shown: the largest
        // The shop's cart with a delivery fee: the reference skill reads the first
        // rupee value (the item price) and must fail; reading "To pay" passes.
        const t = loadTrace(traceDir);
        const fee = {
            ...t,
            pages: t.pages.map((p) =>
                new URL(p.url).pathname === "/cart"
                    ? {
                          ...p,
                          snapshot: {
                              ...p.snapshot,
                              text: p.snapshot.text.replace(
                                  "Paneer Tikka ₹249",
                                  "Paneer Tikka ₹249\nItem total ₹249 · Delivery ₹30 · To pay ₹279",
                              ),
                          },
                      }
                    : p,
            ),
        };
        const itemPrice = await replaySkill(path.join(fixture, "skill.cjs"), fee, {
            input: INPUT,
            answer: OTP,
            browser,
        });
        expect(itemPrice.failures[0]).toMatchObject({
            phase: "confirm",
            verdict: "amount_not_on_page",
            k: 5,
            got: "249",
        });
        const toPay = mutate(
            "amount: price(s.text) || 0",
            "amount: price((/To pay.*/.exec(s.text) || [s.text])[0]) || 0",
        );
        expect(await replaySkill(toPay, fee, { input: INPUT, answer: OTP, browser })).toMatchObject({
            ok: true,
            phases: { confirm: "pass" },
        });
    });

    const mutate = (from: string, to: string) => {
        const dir = tmp();
        cpSync(fixture, dir, { recursive: true });
        const src = readFileSync(path.join(dir, "skill.cjs"), "utf8");
        expect(src.split(from)).toHaveLength(2); // the mutation applies exactly once
        writeFileSync(path.join(dir, "skill.cjs"), src.replace(from, to));
        return path.join(dir, "skill.cjs");
    };
    it.for([
        [
            "the query hard-coded",
            'value: String(input.query || "")',
            'value: "paneer"',
            { phase: "search", verdict: "generalization", k: 1 },
        ],
        [
            "the commit clicked in select",
            'if (!el("captcha")?.checked) return { actions: [{ op: "click", target: { sel: "#captcha" } }] };',
            'return { actions: [{ op: "click", target: { sel: "#checkout" } }] };',
            { phase: "select", verdict: "commit_outside_confirm", k: 4 },
        ],
        [
            "a selector that is not on the page",
            '{ sel: "#q" }',
            '{ sel: "#nope" }',
            { phase: "search", verdict: "mismatch", k: 1 },
        ],
        [
            "done without the order id",
            '(/Order placed #\\d+/.exec(s.text) || ["Order placed"])[0]',
            '"Order placed"',
            { phase: "after_confirm", verdict: "confirm_pattern", k: 8 },
        ],
        [
            "a review page that reads the input (the runtime re-checks with none)",
            "summary: line.trim(),",
            'summary: line.trim() + (input.id || ""),',
            { phase: "confirm", verdict: "recheck_differs", k: 5 },
        ],
    ] as Array<[string, string, string, object]>)("fails a skill with %s", async ([, from, to, want], ctx) => {
        if (!browser) return ctx.skip();
        const r = await replaySkill(mutate(from, to), traceDir, { input: INPUT, answer: OTP, browser });
        expect(r.ok).toBe(false);
        expect(r.failures[0]).toMatchObject(want);
    });

    // The session reached the results by URL. A skill that navigates there too
    // must build the URL from the input, with the query the session used.
    const NAV_FROM = 'if (phase === "search") {';
    const navTo = (url: string) =>
        `${NAV_FROM}\n        if (path === "/") return { actions: [{ op: "navigate", value: new URL(${url}, s.url).href }] };`;
    it("passes a skill that navigates to the results with the input", async (ctx) => {
        if (!browser) return ctx.skip();
        const r = await replaySkill(
            mutate(NAV_FROM, navTo('"/results?q=" + encodeURIComponent(input.query)')),
            navTraceDir,
            { input: INPUT, browser },
        );
        expect(r.failures).toEqual([]);
        expect(r.phases.search).toBe("pass");
    });
    it.for([
        [
            "the query hard-coded in the URL",
            '"/results?q=paneer"',
            { phase: "search", verdict: "generalization", k: 1 },
        ],
        [
            "a query the session never sent",
            '"/results?q=" + encodeURIComponent(input.query) + "-veg"',
            { phase: "search", verdict: "mismatch", k: 1 },
        ],
    ] as Array<[string, string, object]>)("fails a navigating skill with %s", async ([, url, want], ctx) => {
        if (!browser) return ctx.skip();
        const r = await replaySkill(mutate(NAV_FROM, navTo(url)), navTraceDir, { input: { query: "paneer" }, browser });
        expect(r.ok).toBe(false);
        expect(r.failures[0]).toMatchObject(want);
    });
});

describe("site-skill-lib", () => {
    it("folds case, accents, punctuation and spacing, and keeps Indic text intact", () => {
        expect(lib.fold("  Crème   Brûlée! ")).toBe("creme brulee");
        expect(lib.fold("Fish & Chips")).toBe("fish and chips");
        expect(lib.fold("पनीर")).not.toBe(lib.fold("पनर")); // vowel signs are not accents
        expect(lib.sameText("Paneer Tikka", " paneer  TIKKA ")).toBe(true);
        expect(lib.sameText("Paneer Tikka", "Paneer Tikka Masala")).toBe(false);
        expect(lib.sameText("", "")).toBe(false);
    });

    it("reads rupees, paths and elements", () => {
        expect([lib.price("Total ₹1,249.50"), lib.price("Rs. 249"), lib.price("INR 99"), lib.price("free")]).toEqual([
            1249.5,
            249,
            99,
            undefined,
        ]);
        expect([lib.path("https://x.in/a/b?q=1"), lib.path("nope")]).toEqual(["/a/b", ""]);
        const s = { elements: [{ id: "q" }, { id: "go", text: "Search now" }] };
        expect(lib.el(s, { id: "go" })).toBe(s.elements[1]);
        expect(lib.el(s, { text: /search/i })).toBe(s.elements[1]);
        expect(lib.el(s, (e: { id: string }) => e.id === "q")).toBe(s.elements[0]);
        expect(lib.el(s, { id: "none" })).toBeUndefined();
    });

    it("picks the one choice meant, and calls a tie ambiguous instead of guessing", () => {
        const areas = ["Indiranagar", "Indiranagar 2nd Stage"];
        expect(lib.rank(areas, "indiranagar").best).toBe("Indiranagar");
        expect(lib.rank(areas, "2nd stage, Indiranagar").best).toBe("Indiranagar 2nd Stage");
        const menu = [{ label: "Paneer Tikka — ₹249" }, { label: "Paneer Butter Masala — ₹299" }];
        expect(lib.rank(menu, "paneer tikka").best).toBe(menu[0]); // the price is not part of the name
        const tie = lib.rank(menu, "Paneer");
        expect([tie.best, tie.ambiguous]).toEqual([null, menu]);
        expect(lib.rank(menu, "Dal Makhani")).toEqual({ best: null, ambiguous: [], ranked: [] });
    });

    it("ranks 5000 choices without an O(n²) blow-up", () => {
        const many = Array.from({ length: 5000 }, (_, n) => ({ label: `Dish number ${n} — ₹${n}` }));
        const t0 = performance.now();
        const r = lib.rank(many, "dish number 4321");
        // Linear ranking of 5000 items is a few ms locally; the bound only has to
        // catch a genuine O(n²) regression, which would be seconds. 100 ms was too
        // tight for a loaded CI runner (saw 147 ms on Node 24 / ubuntu).
        expect(performance.now() - t0).toBeLessThan(1000);
        expect(r.best).toBe(many[4321]);
    });

    it("reaches every skill as step()'s third argument, frozen", async () => {
        const dir = tmp();
        writeFileSync(path.join(dir, "skill.json"), "{}");
        writeFileSync(
            path.join(dir, "skill.cjs"),
            "exports.step = (phase, ctx, lib) => ({ done: { summary: [lib.fold('Crème'), typeof lib.rank, Object.isFrozen(lib)].join('|') } });",
        );
        const host = new SkillHost(path.join(dir, "skill.cjs"));
        try {
            expect(await host.call("search", {})).toEqual({ done: { summary: "creme|function|true" } });
        } finally {
            host.close();
        }
    });
});
