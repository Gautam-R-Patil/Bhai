// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Fault matrix on the synthetic shop in headless Chromium: four faults
// (selector renamed, page reload, a network drop, tab closed) at five
// points of search → select → yes → confirm:
//   P1 before search · P2 after options, before select · P3 after the confirm
//   is shown, before the yes · P4 after the yes (token minted), before confirm ·
//   P5 inside confirm: the order reached the shop, its reply is lost.
// Each phase call gets a fresh pageDriver on the context's live page, as
// site_task does per call (a closed tab leaves a blank one, as getActivePage
// gives; here the last open page approximates its pick).
// P1-P4 must RESUME: options → confirm ₹249 → done, one order. P5 can't: the
// order exists and the reply is gone, so the only right end is SAFE_STOP (may
// have been placed, never resubmitted, and no page reopened or re-navigated
// after the order: closed@P5 must end aborted/off_site). P5 is reported apart
// and never counted as a recovery; a safe stop at P1-P4 counts as a failure.
// N/A: selector@P5 (nothing is located after the submit; /done is read by
// text) and closed@P1 (no task exists yet; search reads the live tab's URL and
// a blank tab has no skill).
// P3 and P4 differ only in when the token is minted (the yes is synchronous
// here, no owner in between), so they are near-identical runs.
// Plain `npm test` runs each cell once with a 1.5 s network drop; SITE_FAULT_RUNS=25
// is the acceptance run (~100 per fault, a 5 s drop). 25 runs per cell give point
// estimates, not confidence bounds.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageDriver } from "../page-driver.js";
import { findSiteSkill } from "../registry.js";
import { mintConsent, runSiteTask, type SiteTaskResult } from "../runtime.js";
import { SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

const RUNS = Number(process.env.SITE_FAULT_RUNS ?? 1);
const RECOVERY_MS = 60_000;
const OFFLINE_MS = RUNS > 1 ? 5000 : 1500; // the default run keeps CI time down
const builtin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

type Fault = "selector" | "reload" | "offline" | "closed";
type Point = "P1" | "P2" | "P3" | "P4" | "P5";
type Outcome = { cls: "RESUMED" | "SAFE_STOP" | "FAIL"; ms: number; detail: string };
const TARGET: Record<Fault, number> = { selector: 0.95, reload: 0.9, offline: 0.9, closed: 0.9 };
const CELLS: Array<[Fault, Point]> = [
    ["selector", "P1"],
    ["selector", "P2"],
    ["selector", "P3"],
    ["selector", "P4"],
    ["reload", "P1"],
    ["reload", "P2"],
    ["reload", "P3"],
    ["reload", "P4"],
    ["reload", "P5"],
    ["offline", "P1"],
    ["offline", "P2"],
    ["offline", "P3"],
    ["offline", "P4"],
    ["offline", "P5"],
    ["closed", "P2"],
    ["closed", "P3"],
    ["closed", "P4"],
    ["closed", "P5"],
];

let browser: any = null;
let shop: Awaited<ReturnType<typeof startShop>>;
let skillPath = "";
beforeAll(async () => {
    process.env.BHAI_SPEND_CAP_DAY_INR = "1000000"; // 18 cells × 25 runs × ₹249 is past the real daily cap
    process.env.BHAI_NO_AGENT_CURSOR = "true"; // a cursor glide would pad every action
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
    delete process.env.BHAI_SPEND_CAP_DAY_INR;
    delete process.env.BHAI_NO_AGENT_CURSOR;
    await shop?.close();
    await browser?.close();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Every attempt, retried ones too: a retry never hides a duplicate.
let dupes = 0;
const results = new Map<string, Outcome[]>(); // the latest attempt of each cell

/** One flow on a fresh context with `fault` injected at `at`. */
async function run(fault: Fault, at: Point): Promise<Outcome> {
    shop.resetRequests();
    const orders0 = shop.orders();
    const posts = () => shop.requests().filter((r) => r.method === "POST" && r.path.startsWith("/order")).length;
    const ctx = await browser.newContext();
    let restore: Promise<void> | null = null;
    let t0 = Number.NaN;
    let t1 = Number.NaN;
    // Page loads after the order reached the shop (P5 sets t0 there): a reopened tab
    // must never go back to the cart (shop.requests() logs no GETs).
    const navs: string[] = [];
    ctx.on("request", (r: any) => {
        if (at === "P5" && !Number.isNaN(t0) && r.isNavigationRequest()) navs.push(new URL(r.url()).pathname);
    });
    const active = async (): Promise<any> =>
        ctx
            .pages()
            .filter((p: any) => !p.isClosed())
            .at(-1) ?? ctx.newPage();
    const driver = async () => pageDriver(await active(), 5000, active);
    const drop = async () => {
        await ctx.setOffline(true);
        restore = pause(OFFLINE_MS).then(() => ctx.setOffline(false));
    };
    const inject = async () => {
        t0 = performance.now();
        const page = await active();
        if (fault === "selector") {
            if (at === "P2") shop.set({ renameIds: true }); // the cart is redesigned before it loads
            if (at === "P3" || at === "P4")
                await page.evaluate("document.getElementById('checkout').id = 'place-order-v2'");
        } else if (fault === "reload") await page.reload();
        else if (fault === "offline") await drop();
        else await page.close();
    };
    const fail = (detail: string): Outcome => ({ cls: "FAIL", ms: t1 - t0, detail });
    const show = (r: SiteTaskResult) => `${r.task.phase}:${r.status}/${r.reason ?? ""}/${r.writeStatus}`;
    try {
        if (fault === "selector" && at === "P1") shop.set({ renameSearch: true, renameIds: true }); // a redesign before the task
        await (await ctx.newPage()).goto(shop.url);
        if (at === "P1") await inject();
        const s = await runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, driver: await driver() });
        if (at === "P1") t1 = performance.now();
        if (s.status !== "options" || !s.options?.length) return fail(show(s));
        if (at === "P2") await inject();
        const c = await runSiteTask({
            task: s.task,
            phase: "select",
            input: { id: s.options[0].id },
            driver: await driver(),
        });
        if (at === "P2") t1 = performance.now();
        if (c.status !== "confirm" || c.confirm?.amount !== 249) return fail(show(c));
        if (at === "P3") await inject();
        const token = mintConsent(c.task); // the owner's yes
        if (at === "P4") await inject();
        if (at === "P5") {
            // The order reaches the shop (fetched here, server-side counted), then the
            // fault hits and its reply never reaches the page.
            await ctx.route(/\/order$/, async (route: any) => {
                if (route.request().method() !== "POST") return route.continue();
                await route.fetch({ url: route.request().url().replace("shop.test", "127.0.0.1"), maxRedirects: 0 });
                t0 = performance.now();
                const page = route.request().frame().page();
                if (fault === "reload") page.reload().catch(() => {});
                else if (fault === "closed") await page.close();
                await route.abort("internetdisconnected").catch(() => {});
                if (fault === "offline") await drop(); // after the abort: setOffline waits on a paused request
            });
        }
        const d = await runSiteTask({ task: c.task, phase: "confirm", consentToken: token, driver: await driver() });
        if (at !== "P1" && at !== "P2") t1 = performance.now();
        const delta = shop.orders() - orders0;
        const sent = posts();
        dupes += Math.max(0, delta - 1) + Math.max(0, sent - 1);
        if (at !== "P5") {
            const ok = d.status === "done" && d.writeStatus === "applied" && delta === 1 && sent === 1;
            return ok ? { cls: "RESUMED", ms: t1 - t0, detail: "" } : fail(`${show(d)} orders+${delta} posts=${sent}`);
        }
        // P5: the order exists; the task must say so and refuse to send it again.
        let refused = false;
        try {
            mintConsent(d.task);
        } catch (e) {
            refused = /may have gone through/.test(String(e));
        }
        const probe = await runSiteTask({
            task: d.task,
            phase: "confirm",
            consentToken: "x",
            driver: await driver(),
        });
        const after = shop.orders() - orders0;
        const safe =
            (d.status === "failed" || d.status === "aborted") &&
            d.writeStatus === "may_have_applied" &&
            d.retry === "never" &&
            delta === 1 &&
            sent === 1 &&
            refused &&
            probe.reason === "commit_unresolved" &&
            // A reload is the fault itself; nothing else may load a page after the order.
            (fault === "reload" || navs.length === 0) &&
            (fault !== "closed" || (d.status === "aborted" && d.reason === "off_site")) &&
            after === 1 &&
            posts() === 1;
        return safe
            ? { cls: "SAFE_STOP", ms: t1 - t0, detail: show(d) }
            : fail(`${show(d)} orders+${delta} posts=${sent} refused=${refused} probe=${probe.reason} navs=${navs}`);
    } finally {
        await restore; // a setOffline after close would throw
        shop.set({ renameSearch: false, renameIds: false });
        await ctx.close();
    }
}

// A loaded CI runner drifts on render timing (as reference-skill.e2e): retry the
// single-run cells; the acceptance run never retries.
describe("fault matrix: selector, reload, network, closed tab × P1-P5", { retry: RUNS === 1 ? 2 : 0 }, () => {
    for (const [fault, at] of CELLS) {
        it(
            `${fault}@${at}`,
            async (ctx) => {
                if (!browser) return ctx.skip();
                const outs: Outcome[] = [];
                results.set(`${fault}@${at}`, outs);
                for (let i = 0; i < RUNS; i++) outs.push(await run(fault, at));
                const want = at === "P5" ? "SAFE_STOP" : "RESUMED";
                const good = outs.filter((o) => o.cls === want).length;
                expect(dupes).toBe(0);
                // Every run's next phase call returned within the bound, failed ones too.
                for (const o of outs) expect(o.ms).toBeLessThan(RECOVERY_MS);
                // P5: every run, since it is the safety property, not a recovery rate.
                if (at === "P5") expect(outs.filter((o) => o.cls !== want).map((o) => o.detail)).toEqual([]);
                else
                    expect(good, outs.map((o) => o.detail).join("; ")).toBeGreaterThanOrEqual(
                        Math.ceil(TARGET[fault] * RUNS),
                    );
            },
            RUNS * RECOVERY_MS + 30_000,
        );
    }

    it("summary: no duplicate order, every recovery < 60 s, per-fault recovery rate (P1-P4) on target", (ctx) => {
        if (!browser) return ctx.skip();
        const rows = [...results].map(([cell, outs]) => {
            const ms = outs.map((o) => o.ms).sort((a, b) => a - b);
            return {
                cell,
                RESUMED: outs.filter((o) => o.cls === "RESUMED").length,
                SAFE_STOP: outs.filter((o) => o.cls === "SAFE_STOP").length,
                FAIL: outs.filter((o) => o.cls === "FAIL").length,
                p50ms: Math.round(ms[Math.floor(ms.length / 2)]),
                maxms: Math.round(ms[ms.length - 1]),
            };
        });
        console.table(rows);
        console.log("N/A: selector@P5 (nothing located after the submit), closed@P1 (no task to resume yet)");
        expect(dupes).toBe(0);
        expect(Math.max(...rows.map((r) => r.maxms))).toBeLessThan(RECOVERY_MS);
        for (const fault of Object.keys(TARGET) as Fault[]) {
            const rec = rows.filter((r) => r.cell.startsWith(`${fault}@`) && !r.cell.endsWith("@P5"));
            const n = rec.reduce((s, r) => s + r.RESUMED + r.SAFE_STOP + r.FAIL, 0);
            const ok = rec.reduce((s, r) => s + r.RESUMED, 0); // a safe stop is not a recovery
            console.log(`${fault}: recovered ${ok}/${n} at P1-P4`);
            expect(ok / n, fault).toBeGreaterThanOrEqual(TARGET[fault]);
            const p5 = rows.find((r) => r.cell === `${fault}@P5`);
            if (p5) console.log(`${fault}@P5: safe stop ${p5.SAFE_STOP}/${p5.SAFE_STOP + p5.FAIL} (not a recovery)`);
        }
    });
});
