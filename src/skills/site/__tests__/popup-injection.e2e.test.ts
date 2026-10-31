// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Popups injected into the synthetic shop mid-flow (rate us, newsletter, a
// second cookie banner, an Escape-only announcement, a transparent click
// shield), on load, on the first interaction or after a delay, on 1-3 of the
// pages search → select → confirm → (OTP) → done passes through. The reference
// skill only knows the home page's own cookie modal, so the page driver
// (unblock) must clear them (the shield is the exception: it removes itself and
// Playwright's click waits it out, so it proves no driver work); half the runs
// also attach the production popup guard. A pass is the order placed, once. Safety holds on every run, passed or
// not: no "Rate now", no Subscribe, no typed email, no Accept while Reject is
// offered, no backdrop click, the cart's own × and the site's own ₹ confirm
// never touched, never two orders. Events are counted by the shop's server
// (a lost keepalive can't hide "/rate", which is logged by its own route).
//
// Plain `npm test`: seven fixed configs (one per kind and timing class, and the
// cookie banner once with no guard, so only the driver can have rejected it)
// plus the deterministic cases. Acceptance: SITE_POPUP_RUNS=200 [SITE_POPUP_SEED=n]
// adds that many seeded random configs (no retries) and requires, per kind,
// passes ≥ 95% of the runs where the popup was shown.
//
// Not covered by the rate (by design, so not counted as passes or failures):
// - every:true + interaction: a popup that re-opens on every pointerdown swallows
//   each retried click (the driver's check runs before the click, the popup opens
//   on it), so the 3rd identical click ends loop_identical_args. Excluded.
// - A popup that opens between the pre-mark clear and the submit's click makes
//   the run report may_have_applied (Playwright refuses the covered click; no
//   order). It counts as a failure here when it happens.
// - Real sites: other vocabularies, shadow DOM, consent banners in iframes
//   (left alone: an overlay with a frame is a keeper), upsells with a price
//   (never dismissed). The Chrome bridge is emulated (click_at → mouse.click,
//   the same CDP mouse dispatch); checkout over the bridge is refused upstream.
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChromePageProxy } from "../../../tools/browser/chrome-backend.js";
import { attachPopupGuard } from "../../../tools/browser/popup-guard.js";
import { pageDriver } from "../page-driver.js";
import { findSiteSkill } from "../registry.js";
import { mintConsent, runSiteTask, type SiteTaskResult } from "../runtime.js";
import { type Popup, popupJs, SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

// The Chrome bridge, backed by a real Playwright page: click_at is page.mouse.click
// (CDP Input.dispatchMouseEvent, as the extension), so the top-most element gets it.
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
let bridgePage: any = null;
vi.mock("../../../tools/browser/chrome-bridge.js", async (orig) => ({
    ...(await orig<object>()),
    getActiveExtensionTab: async () => ({ id: 1, url: bridgePage?.url() ?? "", title: "", status: "complete" }),
    // biome-ignore lint/suspicious/noExplicitAny: bridge args
    sendBridgeCommand: async (cmd: string, a: any = {}) => {
        const p = bridgePage;
        if (cmd === "execute_js") return p.evaluate(a.code);
        if (cmd === "click_at") return void (await p.mouse.click(a.x, a.y));
        if (cmd === "hover") return void (await p.mouse.move(a.x, a.y));
        if (cmd === "type_text") {
            if (a.clear) await p.keyboard.press("ControlOrMeta+A");
            return void (await p.keyboard.insertText(a.text));
        }
        if (cmd === "keyboard") return void (await p.keyboard.press([...(a.modifiers ?? []), a.key].join("+")));
        if (cmd === "navigate") return void (await p.goto(a.url));
        if (cmd === "wait_for") return p.waitForSelector(a.selector, { timeout: a.timeout });
        throw new Error(`bridge mock: no ${cmd}`);
    },
}));

const RUNS = Number(process.env.SITE_POPUP_RUNS ?? 0);
const SEED = Number(process.env.SITE_POPUP_SEED ?? Date.now()) >>> 0;
const builtin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

type Kind = "rate" | "newsletter" | "consent" | "escape" | "shield";
type Cfg = { popup: Popup; otp: boolean; guard: boolean };
const KINDS: Kind[] = ["rate", "newsletter", "consent", "escape", "shield"];
// The event that says the popup was dismissed the right way (the shield removes itself).
const DISMISS: Record<Kind, string> = {
    rate: "notnow",
    newsletter: "close",
    consent: "reject",
    escape: "escape",
    shield: "shield-gone",
};
// Never, in any run: the off-flow link, a subscription, a typed email, accepting
// cookies while Reject is offered, a backdrop click, the cart's ×, the site's ₹ confirm.
const FORBIDDEN = [
    "rate",
    "subscribe",
    "email",
    "accept",
    "backdrop",
    "remove",
    "keep-pay",
    "keep-cancel",
    "keep-escape",
];
const COVER: Cfg[] = [
    { popup: { kind: "rate", pages: ["/"], when: "load" }, otp: false, guard: false },
    { popup: { kind: "newsletter", pages: ["/results"], when: "interaction" }, otp: false, guard: false },
    { popup: { kind: "consent", pages: ["/cart"], when: "load" }, otp: false, guard: true },
    { popup: { kind: "consent", pages: ["/cart"], when: "load" }, otp: false, guard: false },
    { popup: { kind: "escape", pages: ["/results"], when: "load" }, otp: false, guard: false },
    { popup: { kind: "shield", pages: ["/cart"], when: "interaction" }, otp: false, guard: false },
    { popup: { kind: "rate", pages: ["/otp"], when: 150 }, otp: true, guard: true },
];
const name = (c: Cfg) =>
    `${c.popup.kind}@${c.popup.pages.join("+")}/${c.popup.when}${c.popup.every ? "/every" : ""}${c.otp ? "/otp" : ""}${c.guard ? "/guard" : ""}`;

// mulberry32: a seeded run can be replayed exactly.
const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randomCfg = (r: () => number): Cfg => {
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const pages = ["/", "/results", "/cart", "/otp"].sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 3));
    const x = r();
    const when: Popup["when"] = x < 1 / 3 ? "load" : x < 2 / 3 ? "interaction" : Math.floor(r() * 601);
    return {
        popup: { kind: pick(KINDS), pages, when, every: when !== "interaction" && r() < 0.5 },
        otp: pages.includes("/otp") || r() < 0.3,
        guard: r() < 0.5,
    };
};

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
let shop: Awaited<ReturnType<typeof startShop>>;
let skillPath = "";
beforeAll(async () => {
    process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000"; // 200 runs × ₹249 is past the real daily cap
    process.env.ATLAS_NO_AGENT_CURSOR = "true"; // a cursor glide would pad every action
    try {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        // Locally a missing Chromium skips; in CI it must fail, not pass silently.
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        browser = null;
        return;
    }
    shop = await startShop();
    skillPath = findSiteSkill(shop.url, [builtin]) as string;
}, 60_000);
afterAll(async () => {
    delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    delete process.env.ATLAS_NO_AGENT_CURSOR;
    await shop?.close();
    await browser?.close();
});
afterEach(() => {
    shop?.set({ popup: undefined, otp: false, keepModal: false, pay: false, cartClose: false });
    shop?.resetPopups();
});

const show = (r: SiteTaskResult) => `${r.task.phase}:${r.status}/${r.reason ?? ""}/${r.writeStatus}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
const toConfirm = async (page: any, driver = pageDriver(page), skill = skillPath) => {
    const s = await runSiteTask({ skillPath: skill, phase: "search", input: { query: "paneer" }, driver });
    expect(s.status, show(s)).toBe("options");
    return runSiteTask({ task: s.task, phase: "select", input: { id: s.options?.[0].id }, driver });
};

type Run = { cfg: Cfg; pass: boolean; shown: number; unsafe: string[]; byDriver: boolean; detail: string };
/** One whole order with `cfg`'s popup, on a fresh context. */
async function flow(cfg: Cfg): Promise<Run> {
    shop.set({ popup: cfg.popup, otp: cfg.otp });
    shop.resetPopups();
    const orders0 = shop.orders();
    const context = await browser.newContext();
    if (cfg.guard) attachPopupGuard(context); // before the page opens, as getBrowser does
    try {
        const page = await context.newPage();
        await page.goto(shop.url);
        const driver = pageDriver(page);
        let r = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver });
        if (r.status === "options")
            r = await runSiteTask({ task: r.task, phase: "select", input: { id: r.options?.[0].id }, driver });
        if (r.status === "confirm")
            r = await runSiteTask({ task: r.task, phase: "confirm", consentToken: mintConsent(r.task), driver });
        if (r.status === "needs_user" && cfg.otp) {
            await pause(1000); // the owner reads the code off their phone; a timed popup opens meanwhile
            r = await runSiteTask({ task: r.task, phase: "resume", answer: "123456", driver });
        }
        const delta = shop.orders() - orders0;
        const ev = shop.popups();
        const kind = cfg.popup.kind as Kind;
        const pass =
            r.status === "done" && /^Order placed #\d+$/.test(r.summary ?? "") && delta === 1 && r.task.stepCount <= 40;
        const unsafe = [...FORBIDDEN.filter((e) => ev[e]), ...(delta > 1 ? [`orders+${delta}`] : [])];
        // Who cleared it: a stamped click is the driver's; with no guard, an Escape can only be the driver's.
        const byDriver = kind === "escape" ? !cfg.guard && !!ev.escape : !!ev[`bhai:${DISMISS[kind]}`];
        const detail = `${name(cfg)} → ${show(r)} orders+${delta} steps=${r.task.stepCount} ${JSON.stringify(ev)}`;
        return { cfg, pass, shown: ev[`shown:${kind}`] ?? 0, unsafe, byDriver, detail };
    } finally {
        await context.close();
    }
}

describe("popup matrix: popups injected mid-flow are cleared and the order completes", { retry: RUNS ? 0 : 2 }, () => {
    for (const cfg of COVER) {
        it(name(cfg), async (ctx) => {
            if (!browser) return ctx.skip();
            const run = await flow(cfg);
            expect(run.unsafe, run.detail).toEqual([]);
            expect(run.shown, run.detail).toBeGreaterThan(0); // not vacuous: the popup was in the flow
            expect(run.pass, run.detail).toBe(true);
            const kind = cfg.popup.kind as Kind;
            if (kind !== "shield") expect(shop.popups()[DISMISS[kind]], run.detail).toBeGreaterThan(0);
            // With no guard, nobody but the page driver could have cleared it.
            if (!cfg.guard && kind !== "shield") expect(run.byDriver, run.detail).toBe(true);
        }, 60_000);
    }

    it.runIf(RUNS > 0)(
        `${RUNS} seeded random popups: per kind, ≥ 95% of shown runs complete; every run safe`,
        async (ctx) => {
            if (!browser) return ctx.skip();
            const r = rng(SEED);
            const runs: Run[] = [];
            for (let i = 0; i < RUNS; i++) runs.push(await flow(randomCfg(r)));
            const rows = KINDS.map((kind) => {
                const of = runs.filter((x) => x.cfg.popup.kind === kind);
                const shown = of.filter((x) => x.shown > 0);
                return {
                    kind,
                    runs: of.length,
                    shown: shown.length,
                    passed: shown.filter((x) => x.pass).length,
                    guardOffByDriver: shown.filter((x) => !x.cfg.guard && x.byDriver).length,
                    guardOff: shown.filter((x) => !x.cfg.guard).length,
                };
            });
            console.log(`popup matrix seed ${SEED}`);
            console.table(rows);
            const failed = runs.filter((x) => x.shown > 0 && !x.pass).map((x) => x.detail);
            if (failed.length) console.log(`seed ${SEED} failures:\n${failed.join("\n")}`);
            // Safety: every run, shown or not, passed or not.
            expect(
                runs.flatMap((x) => (x.unsafe.length ? [`${x.unsafe} ${x.detail}`] : [])),
                `seed ${SEED}`,
            ).toEqual([]);
            for (const row of rows) {
                // A timed popup on a page left before its timer fires never shows: such runs
                // don't count, so check most runs did show it.
                expect(row.shown, `${row.kind} seed ${SEED}`).toBeGreaterThanOrEqual(Math.floor(0.8 * row.runs));
                expect(row.passed, `${row.kind} seed ${SEED}\n${failed.join("\n")}`).toBeGreaterThanOrEqual(
                    Math.ceil(0.95 * row.shown),
                );
            }
        },
        RUNS * 60_000 + 60_000,
    );
});

describe("overlays the driver must clear before the yes is spent, or never touch", { retry: RUNS ? 0 : 2 }, () => {
    it("a popup that opens over the cart after the owner's yes is cleared before the order is marked sent", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const c = await toConfirm(page, driver);
            expect(c.status, show(c)).toBe("confirm");
            await page.evaluate(popupJs({ kind: "rate", pages: ["/cart"], when: "load" }));
            const d = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
            const ev = shop.popups();
            expect([show(d), shop.orders() > 0, ev["bhai:notnow"], ev.rate ?? 0, ev.backdrop ?? 0]).toEqual([
                "after_confirm:done//applied",
                true,
                1,
                0,
                0,
            ]);
        } finally {
            await context.close();
        }
    }, 60_000);

    // The site's own "Confirm your order of ₹249 / Pay ₹249" over the cart: at select
    // (it covers the captcha) and after the yes (it covers the submit).
    for (const at of ["select", "confirm"] as const) {
        it(`a site's own ₹ confirm over the cart (${at}) is never touched: blocked_by_overlay, nothing ordered`, async (ctx) => {
            if (!browser) return ctx.skip();
            if (at === "select") shop.set({ keepModal: true });
            const orders0 = shop.orders();
            const context = await browser.newContext();
            try {
                const page = await context.newPage();
                await page.goto(shop.url);
                const driver = pageDriver(page);
                const t0 = Date.now();
                let r = await toConfirm(page, driver);
                if (at === "confirm") {
                    expect(r.status, show(r)).toBe("confirm");
                    await page.evaluate(popupJs({ kind: "keep", pages: ["/cart"], when: "load", every: true }, 249));
                    r = await runSiteTask({
                        task: r.task,
                        phase: "confirm",
                        consentToken: mintConsent(r.task),
                        driver,
                    });
                }
                const ev = shop.popups();
                expect(r.reason ?? "", show(r)).toMatch(/^blocked_by_overlay: kept "Confirm your order of ₹249/);
                expect([r.status, r.writeStatus, r.retry, r.task.commit, r.repairQueued]).toEqual([
                    "failed",
                    "not_attempted",
                    "ask_owner",
                    undefined,
                    undefined,
                ]);
                expect([
                    shop.orders() - orders0,
                    ev["keep-pay"] ?? 0,
                    ev["keep-cancel"] ?? 0,
                    ev["keep-escape"] ?? 0,
                ]).toEqual([0, 0, 0, 0]);
                expect(await page.getByText("Confirm your order of ₹249").isVisible()).toBe(true);
                expect(Date.now() - t0).toBeLessThan(15_000); // stopped at once, no 3× loop on a 5 s timeout
            } finally {
                await context.close();
            }
        }, 60_000);
    }

    it("Escape is never pressed while a keeper is open: an announcement over a ₹ confirm stays, nothing ordered", async (ctx) => {
        if (!browser) return ctx.skip();
        const orders0 = shop.orders();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const c = await toConfirm(page, driver);
            expect(c.status, show(c)).toBe("confirm");
            // The site's ₹ confirm (a keeper), then an Escape-only announcement on top of it, over
            // the submit: Escape would close both (each listens on the whole page).
            await page.evaluate(popupJs({ kind: "keep", pages: ["/cart"], when: "load", every: true }, 249));
            await page.evaluate(popupJs({ kind: "escape", pages: ["/cart"], when: "load", every: true }));
            const d = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
            const ev = shop.popups();
            expect(d.reason ?? "", show(d)).toMatch(/^blocked_by_overlay: kept "What's new/);
            expect([d.writeStatus, shop.orders() - orders0, ev["keep-escape"] ?? 0, ev.escape ?? 0]).toEqual([
                "not_attempted",
                0,
                0,
                0,
            ]);
        } finally {
            await context.close();
        }
    }, 60_000);

    it("the production popup guard never touches a payment sheet or the cart's own ×", async (ctx) => {
        if (!browser) return ctx.skip();
        // The reference skill, with the shop's gateway as its payment domain.
        const dir = mkdtempSync(path.join(tmpdir(), "site-pay-"));
        const fixture = path.join(builtin, "synthetic-shop");
        copyFileSync(path.join(fixture, "skill.cjs"), path.join(dir, "skill.cjs"));
        writeFileSync(
            path.join(dir, "skill.json"),
            JSON.stringify({
                domains: ["shop.test"],
                paymentDomains: ["pay.test"],
                commits: [{ op: "click", target: { sel: "#checkout", text: "Place order" } }],
            }),
        );
        shop.set({ pay: true, cartClose: true });
        const context = await browser.newContext();
        attachPopupGuard(context);
        try {
            const page = await context.newPage();
            await page.goto(shop.url);
            const driver = pageDriver(page);
            const c = await toConfirm(page, driver, path.join(dir, "skill.cjs"));
            expect([c.status, c.confirm?.amount], show(c)).toEqual(["confirm", 249]);
            await pause(1500); // the guard runs 800 ms after each load
            expect(await page.locator("[data-testid=cart-line]").count()).toBe(1);
            const d = await runSiteTask({ task: c.task, phase: "confirm", consentToken: mintConsent(c.task), driver });
            expect([d.status, d.needsUser?.kind], show(d)).toEqual(["needs_user", "payment"]);
            await pause(2000);
            expect(new URL(page.url()).hostname).toBe("pay.test");
            expect(await page.isVisible("#pay-sheet")).toBe(true);
            expect(await page.frameLocator("#pay-sheet iframe").locator("input").inputValue()).toBe("");
            const ev = shop.popups();
            expect([ev.remove ?? 0, ev["pay-close"] ?? 0]).toEqual([0, 0]);
        } finally {
            await context.close();
        }
    }, 60_000);

    // The bridge clicks the centre's coordinates: whatever is on top gets the click.
    for (const when of ["load", "interaction"] as const) {
        it(`Chrome bridge: a click never lands on a popup over its target (${when})`, async (ctx) => {
            if (!browser) return ctx.skip();
            shop.set({ popup: { kind: "rate", pages: ["/results"], when } });
            const orders0 = shop.orders();
            const context = await browser.newContext();
            try {
                bridgePage = await context.newPage();
                await bridgePage.goto(shop.url);
                const proxy = new ChromePageProxy(shop.url);
                const c = await toConfirm(proxy, pageDriver(proxy));
                const ev = shop.popups();
                expect([c.status, new URL(bridgePage.url()).pathname], show(c)).toEqual(["confirm", "/cart"]);
                expect([ev["bhai:notnow"], ev.backdrop ?? 0, ev.rate ?? 0, shop.orders() - orders0]).toEqual([
                    1, 0, 0, 0,
                ]);
            } finally {
                bridgePage = null;
                await context.close();
            }
        }, 60_000);
    }
});
