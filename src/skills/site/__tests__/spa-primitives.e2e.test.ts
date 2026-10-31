// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// SPA primitives on the synthetic shop in headless Chromium: results that render
// in place (expect), a typeahead location picker (pick), a sold-out item
// (refused) and a site that turns the order down (the submit's verdict), plus
// the ways real pages fool those: a tracking POST before the order, a spinner
// that shows late, the same error twice, a ticking countdown and a long-poll.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainTrace, startTrace, stopTrace } from "../mint/recorder.js";
import { replaySkill } from "../mint/replay.js";
import { pageDriver } from "../page-driver.js";
import { mintConsent, runSiteTask } from "../runtime.js";
import { install, skillSource } from "./spa-skill.js";
import { SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
beforeAll(async () => {
    process.env.BHAI_SPEND_CAP_DAY_INR = "1000000";
    // These time the page's own outcomes; Bhai's cursor glide would pad them (agent-cursor.test covers it).
    process.env.BHAI_NO_AGENT_CURSOR = "true";
    try {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        browser = null;
    }
}, 60_000);
afterAll(async () => {
    delete process.env.BHAI_SPEND_CAP_DAY_INR;
    delete process.env.BHAI_NO_AGENT_CURSOR;
    await browser?.close();
});

// A fresh context on the shop's home page.
const edit = (src: string, from: string, to: string) => {
    expect(src.split(from)).toHaveLength(2); // applies exactly once
    return src.replace(from, to);
};
// The submit with no expect (as built-in and hand-written skills have), and an
// after_confirm that waits for the confirmation while the cart still shows.
const noSubmitExpect = () =>
    edit(
        edit(
            edit(
                skillSource(true),
                `...exp({ expect: { placed: { url: "/(done|otp)" }, turned_down: { sel: "[role=alert]" } } })`,
                "",
            ),
            "{ snapshot: s, input = {} }",
            "{ snapshot: s, input = {}, lastError }",
        ),
        `if (path === "/done") return`,
        `if (path === "/cart" && !lastError) return { actions: [{ op: "waitFor", target: { sel: "h1" } }] };
    if (path === "/done") return`,
    );
const open = async (url: string) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    return { context, page, driver: pageDriver(page) };
};

// Real headless-Chromium E2E: a few assertions turn on request/abort timing
// (an in-flight search aborted before its successor), which is deterministic on
// macOS/Linux but drifts on a loaded Windows runner — seen as 'options' (the
// request completed) where 'aborted' was expected. Retry absorbs that transient
// ordering; a genuinely broken primitive still fails all attempts.
describe("SPA primitives on the synthetic shop", { retry: 2 }, () => {
    it("results that render in place: without expect the search loops; with expect it waits for them and the order goes through", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true });
        try {
            const a = await open(shop.url);
            const loop = await runSiteTask({
                skillPath: install(false),
                phase: "search",
                input: { query: "paneer" },
                driver: a.driver,
            });
            expect([loop.status, loop.reason, loop.retry, loop.writeStatus]).toEqual([
                "aborted",
                "loop_identical_args",
                "manual",
                "not_attempted",
            ]);
            await a.context.close();

            const skillPath = install(true);
            const b = await open(shop.url);
            // The wait ends when the results show (600 ms after the click), not on the idle
            // fallback: with the fallback at 20 s, anything under 8 s can only be the results.
            // (A tight bound measured Windows process start, not the wait.)
            process.env.BHAI_SITE_EXPECT_IDLE_MS = "20000";
            const t0 = Date.now();
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver: b.driver });
            const ms = Date.now() - t0;
            delete process.env.ATLAS_SITE_EXPECT_IDLE_MS;
            expect([s.status, s.task.lastOutcome, s.options?.map((o) => o.id)]).toEqual([
                "options",
                "results",
                ["p1", "p2"],
            ]);
            expect(ms).toBeLessThan(8000);
            expect(s.task.stepCount).toBeLessThanOrEqual(6); // accept, type, click + 3 skill calls
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: "p1" }, driver: b.driver });
            expect([c.status, c.confirm?.amount]).toEqual(["confirm", 249]);
            const d = await runSiteTask({
                task: c.task,
                phase: "confirm",
                consentToken: mintConsent(c.task),
                driver: b.driver,
            });
            expect([d.status, d.summary, d.task.lastOutcome, shop.orders()]).toEqual([
                "done",
                "Order placed #1",
                "placed",
                1,
            ]);

            // A search with no hits ends on the "empty" outcome, as the owner's input to fix.
            await b.page.goto(shop.url);
            const none = await runSiteTask({ skillPath, phase: "search", input: { query: "zzzz" }, driver: b.driver });
            expect([none.status, none.task.lastOutcome, none.retry]).toEqual(["failed", "empty", "fix_input"]);
            await b.context.close();
        } finally {
            await shop.close();
        }
    }, 60_000);

    it("expect: a stale copy of the outcome never wins, and no outcome fails fast as no_outcome", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true });
        const { context, page, driver } = await open(shop.url);
        try {
            await driver.act({ op: "click", target: { sel: "#accept" } });
            const search = {
                op: "click" as const,
                target: { sel: "#search" },
                expect: { results: { sel: "[data-item]" } },
            };
            await driver.act({ op: "type", target: { sel: "#q" }, value: "paneer" });
            expect(await driver.act(search)).toMatchObject({ outcome: "results" });
            expect((await driver.snapshot()).text).toContain("Paneer Tikka");

            // The paneer results still show while the dal search is in flight: they don't count.
            await driver.act({ op: "type", target: { sel: "#q" }, value: "dal" });
            const t0 = Date.now();
            expect(await driver.act(search)).toMatchObject({ outcome: "results" });
            expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
            const text = (await driver.snapshot()).text;
            expect([text.includes("Dal Makhani"), text.includes("Paneer Tikka")]).toEqual([true, false]);

            process.env.BHAI_SITE_EXPECT_IDLE_MS = "300";
            const t1 = Date.now();
            await expect(driver.act({ ...search, expect: { never: { sel: "#nope" } } })).rejects.toThrow(
                /^no_outcome: none of never/,
            );
            // The fetch in flight and the re-render count as progress; then 300 ms of quiet ends it.
            expect(Date.now() - t1).toBeGreaterThanOrEqual(600);
            expect(Date.now() - t1).toBeLessThan(3000);
        } finally {
            delete process.env.BHAI_SITE_EXPECT_IDLE_MS;
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("pick: two places fit 'Indiranagar' equally → refused with both labels, nothing clicked; a full name picks exactly that one", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true, location: true });
        const skillPath = install(true);
        try {
            const a = await open(shop.url);
            const tie = await runSiteTask({
                skillPath,
                phase: "search",
                input: { query: "paneer", location: "Indiranagar" },
                driver: a.driver,
            });
            expect([tie.status, tie.writeStatus, tie.retry]).toEqual(["refused", "not_attempted", "fix_input"]);
            expect(tie.refused).toEqual({
                field: "location",
                available: ["Indiranagar, Bengaluru", "Indiranagar 2nd Stage, Bengaluru"],
            });
            expect((await a.driver.snapshot()).text).not.toContain("Delivering to");
            await a.context.close();

            for (const [wanted, shown] of [
                ["Indiranagar 2nd Stage", "Indiranagar 2nd Stage, Bengaluru"],
                ["indiranagar, bengaluru", "Indiranagar, Bengaluru"], // the same words: exact beats "every word"
                ["Koramangala", "Koramangala, Bengaluru"],
            ]) {
                const b = await open(shop.url);
                const s = await runSiteTask({
                    skillPath,
                    phase: "search",
                    input: { query: "paneer", location: wanted },
                    driver: b.driver,
                });
                expect([wanted, s.status]).toEqual([wanted, "options"]);
                expect((await b.driver.snapshot()).text).toContain(`Delivering to ${shown}`);
                await b.context.close();
            }
        } finally {
            await shop.close();
        }
    }, 60_000);

    it("sold out → refused with what is in stock, nothing ordered, retry fix_input", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ soldOut: "p1" });
        const { context, driver } = await open(shop.url);
        try {
            const skillPath = install(true);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver });
            expect(s.options?.map((o) => o.id)).toEqual(["p2"]); // the sold-out item isn't offered
            const r = await runSiteTask({ task: s.task, phase: "select", input: { id: "p1" }, driver }); // an id from an older list
            expect([r.status, r.writeStatus, r.retry, shop.orders()]).toEqual([
                "refused",
                "not_attempted",
                "fix_input",
                0,
            ]);
            expect(r.refused).toEqual({ field: "id", available: ["Paneer Butter Masala — ₹299"] });
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("the site's 400 {ok:false} to the order reverts 'sent': one more consented confirm orders, a second refusal stays 'sent'", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true, rejectOrders: 1 });
        const skillPath = install(true);
        const toConfirm = async () => {
            const o = await open(shop.url);
            const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver: o.driver });
            const c = await runSiteTask({ task: s.task, phase: "select", input: { id: "p1" }, driver: o.driver });
            expect(c.status).toBe("confirm");
            return { ...o, c };
        };
        try {
            const a = await toConfirm();
            const r1 = await runSiteTask({
                task: a.c.task,
                phase: "confirm",
                consentToken: mintConsent(a.c.task),
                driver: a.driver,
            });
            expect([r1.status, r1.reason, r1.writeStatus, r1.task.lastOutcome, shop.orders()]).toEqual([
                "confirm",
                "commit_rejected: Payment declined",
                "not_attempted",
                "turned_down",
                0,
            ]);
            const r2 = await runSiteTask({
                task: r1.task,
                phase: "confirm",
                consentToken: mintConsent(r1.task),
                driver: a.driver,
            });
            expect([r2.status, r2.writeStatus, shop.orders()]).toEqual(["done", "applied", 1]);
            await a.context.close();

            shop.set({ rejectOrders: 2 });
            const b = await toConfirm();
            const first = await runSiteTask({
                task: b.c.task,
                phase: "confirm",
                consentToken: mintConsent(b.c.task),
                driver: b.driver,
            });
            expect(first.reason).toBe("commit_rejected: Payment declined");
            const second = await runSiteTask({
                task: first.task,
                phase: "confirm",
                consentToken: mintConsent(first.task),
                driver: b.driver,
            });
            expect([second.status, second.writeStatus, second.retry, shop.orders()]).toEqual([
                "failed",
                "may_have_applied",
                "never",
                1,
            ]);
            expect(() => mintConsent(second.task)).toThrow(/may have gone through/);
            await b.context.close();
        } finally {
            await shop.close();
        }
    }, 60_000);

    it("offline replay verifies a skill that picks, and fails one whose pick would be refused", async (ctx) => {
        if (!browser) return ctx.skip();
        // The agent's session: choose the location from the typeahead, then search.
        const shop = await startShop({ location: true });
        const context = await browser.newContext();
        let dir = "";
        try {
            const page = await context.newPage();
            dir = (await startTrace(context, "shop.test", { root: mkdtempSync(path.join(tmpdir(), "spa-trace-")) }))
                .dir;
            await page.goto(shop.url);
            await drainTrace(page);
            for (const step of [
                () => page.click("#accept"),
                async () => {
                    await page.fill("#loc", "Indiranagar 2nd Stage");
                    await page.locator("#loc-list [role=option]").first().waitFor(); // the agent looks before it clicks
                },
                () => page.getByText("Indiranagar 2nd Stage, Bengaluru").click(),
                () => page.fill("#q", "paneer"),
                () => page.click("#search"),
            ]) {
                await step();
                await drainTrace(page);
            }
            await stopTrace(page);
        } finally {
            await context.close();
            await shop.close();
        }
        const input = { query: "paneer", location: "Indiranagar 2nd Stage" };
        const ok = await replaySkill(install(true), dir, { input, browser });
        expect([ok.ok, ok.phases.search, ok.failures]).toEqual([true, "pass", []]);

        // The same skill picking a place it didn't type: nothing on the recorded list fits.
        const wrong = install(true);
        writeFileSync(wrong, skillSource(true).replace("value: input.location, field", 'value: "Koramangala", field'));
        const bad = await replaySkill(wrong, dir, { input, browser });
        expect(bad.ok).toBe(false);
        expect(bad.failures[0]).toMatchObject({ phase: "search", verdict: "mismatch" });
        expect(bad.failures[0].got).toMatch(/refused$/);

        // An expect that never holds on the page the session saw next fails replay.
        const typo = install(
            true,
            edit(
                skillSource(true),
                `results: { sel: "[data-item]" }, empty: { text: "No results" }`,
                `results: { sel: "[data-itemz]" }, empty: { text: "Nothing found" }`,
            ),
        );
        const unmatched = await replaySkill(typo, dir, { input, browser });
        expect([unmatched.ok, unmatched.failures[0]?.phase, unmatched.failures[0]?.verdict]).toEqual([
            false,
            "search",
            "expect_unmatched",
        ]);

        // The outcome that held reaches the next step as lastOutcome, as at run time.
        const branchy = install(
            true,
            edit(
                edit(skillSource(true), "{ snapshot: s, input = {} }", "{ snapshot: s, input = {}, lastOutcome }"),
                "if (cards.length) return",
                `if (cards.length && lastOutcome === "results") return`,
            ),
        );
        const branched = await replaySkill(branchy, dir, { input, browser });
        expect([branched.ok, branched.phases.search, branched.failures]).toEqual([true, "pass", []]);
    }, 60_000);

    it("a tracking POST's 400 before the order is not the site's 'no': the order isn't re-offered", async (ctx) => {
        if (!browser) return ctx.skip();
        // Same-site: the order starts 700 ms after the tracker's 400 (the verdict listens until the writes are quiet).
        // Third-party: only the tracker answers before the verdict is read (it never counts).
        for (const [track, orderDelayMs] of [
            ["same-site", 700],
            ["third-party", 1500],
        ] as const) {
            const shop = await startShop({ spa: true, track, orderDelayMs });
            const o = await open(shop.url);
            try {
                const skillPath = install(true, noSubmitExpect());
                const s = await runSiteTask({
                    skillPath,
                    phase: "search",
                    input: { query: "paneer" },
                    driver: o.driver,
                });
                const c = await runSiteTask({ task: s.task, phase: "select", input: { id: "p1" }, driver: o.driver });
                const d = await runSiteTask({
                    task: c.task,
                    phase: "confirm",
                    consentToken: mintConsent(c.task),
                    driver: o.driver,
                });
                expect([track, d.status, d.reason, d.writeStatus, shop.orders()]).toEqual([
                    track,
                    "done",
                    undefined,
                    "applied",
                    1,
                ]);
                expect(d.task.commitReverted).toBeUndefined();
            } finally {
                await o.context.close();
                await shop.close();
            }
        }
    }, 60_000);

    it("gone wins only after its target was seen: a spinner that shows 50 ms after the click", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true, spinner: true });
        const { context, driver } = await open(shop.url);
        try {
            await driver.act({ op: "click", target: { sel: "#accept" } });
            await driver.act({ op: "type", target: { sel: "#q" }, value: "paneer" });
            const t0 = Date.now();
            const r = await driver.act({
                op: "click",
                target: { sel: "#search" },
                expect: { loaded: { gone: { sel: ".spinner" } } },
            });
            expect(r).toMatchObject({ outcome: "loaded" });
            expect(Date.now() - t0).toBeGreaterThanOrEqual(500); // the results land ~600 ms in
            expect((await driver.snapshot()).text).toContain("Paneer Tikka");
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("announced wins when the same message comes again in a new alert", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true, rejectOrders: 2 });
        const { context, page, driver } = await open(`${shop.url}cart?id=p1`);
        try {
            const submit = {
                op: "click" as const,
                target: { sel: "#checkout" },
                expect: { declined: { announced: "Payment declined" } },
            };
            for (let n = 0; n < 2; n++) {
                const r = await driver.act(submit, { submit: true, domains: ["shop.test"] });
                expect([n, r]).toEqual([
                    n,
                    { outcome: "declined", verdict: { verdict: "not_done", detail: "Payment declined" } },
                ]);
            }
            expect([await page.locator("[role=alert]").count(), shop.orders()]).toEqual([1, 0]);
        } finally {
            await context.close();
            await shop.close();
        }
    }, 60_000);

    it("a ticking countdown and a long-poll don't keep a failed expect waiting until the cap", async (ctx) => {
        if (!browser) return ctx.skip();
        const shop = await startShop({ spa: true, ticker: true });
        const { context, driver } = await open(shop.url);
        process.env.BHAI_SITE_EXPECT_IDLE_MS = "300";
        process.env.BHAI_SITE_EXPECT_CAP_MS = "20000";
        try {
            await driver.act({ op: "click", target: { sel: "#accept" } });
            await driver.act({ op: "type", target: { sel: "#q" }, value: "paneer" });
            const t0 = Date.now();
            const never = { op: "click" as const, target: { sel: "#search" }, expect: { never: { sel: "#nope" } } };
            await expect(driver.act(never, { domains: ["shop.test"] })).rejects.toThrow(/^no_outcome/);
            // The long-poll counts as progress for 5 s, the countdown for its first 3 ticks; then 300 ms of quiet.
            expect(Date.now() - t0).toBeLessThan(8000);
        } finally {
            delete process.env.BHAI_SITE_EXPECT_IDLE_MS;
            delete process.env.BHAI_SITE_EXPECT_CAP_MS;
            await context.close();
            await shop.close();
        }
    }, 60_000);
});
