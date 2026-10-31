// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The owner's Stop on the synthetic shop in headless Chromium: at any point of
// search → select → confirm → resume, the running step returns in under 2 s,
// no page action or read starts after Stop, and no order is ever half-sent:
// before the write-ahead mark nothing reaches the shop; after it the consented
// submit is the one order and the result says it may have been placed.
// Three shops: P (form POST, the reference skill), S (SPA whose checkout sends
// a tracking POST, then the order 2.5 s after the click: longer than the bound,
// so Stop must not wait for it) and O (an OTP after the order).
// Plain `npm test` runs the 7 named stop points; SITE_STOP_RUNS=50 adds 43
// seeded random ones (SITE_STOP_SEED replays a sequence).
// Measured from Stop to runSiteTask's return: the agent's own unwind and the
// "Stopped." the owner sees are not timed here (no LLM in tests).
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageDriver } from "../page-driver.js";
import { findSiteSkill } from "../registry.js";
import { mintConsent, type PageDriver, type Phase, runSiteTask, type SiteTaskResult } from "../runtime.js";
import { install } from "./spa-skill.js";
import { SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

const NAMED = 7;
const RUNS = Math.max(NAMED, Number(process.env.SITE_STOP_RUNS ?? NAMED));
const SEED = Number(process.env.SITE_STOP_SEED ?? Date.now() % 2 ** 31);
const HALT_MS = 2000;
const ORDER_DELAY_MS = 2500;
const builtin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

type Variant = "P" | "S" | "O";
type Call = { kind: string; sel?: string; phase: Phase; t0: number; t1?: number };
type Stop = { at: (c: Call, k: number) => boolean; delay: number };
type Shop = Awaited<ReturnType<typeof startShop>>;

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
const shops = {} as Record<Variant, { shop: Shop; skillPath: string; settleMs: number }>;
// An unstopped run: per driver call, the ms from its start to the end of the flow.
const calls0 = {} as Record<Variant, number[]>;
beforeAll(async () => {
    process.env.BHAI_SPEND_CAP_DAY_INR = "1000000";
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
    const p = await startShop();
    const o = await startShop({ otp: true });
    // The submit carries expect: without it, watchWrites reads /track's 400 as the
    // site's "no" before the delayed order is sent (see the open issue in page-driver's watchWrites).
    const s = await startShop({ spa: true, track: "same-site", orderDelayMs: ORDER_DELAY_MS });
    shops.P = { shop: p, skillPath: findSiteSkill(p.url, [builtin]) as string, settleMs: 1000 };
    shops.O = { shop: o, skillPath: findSiteSkill(o.url, [builtin]) as string, settleMs: 1000 };
    shops.S = { shop: s, skillPath: install(true), settleMs: ORDER_DELAY_MS + 500 };
}, 60_000);
afterAll(async () => {
    delete process.env.BHAI_SPEND_CAP_DAY_INR;
    delete process.env.BHAI_NO_AGENT_CURSOR;
    await Promise.all(Object.values(shops).map((s) => s.shop.close()));
    await browser?.close();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One flow on a fresh context, driven like the agent drives site_task: each
 * phase only while not stopped. `stop` aborts at the k-th driver call that
 * matches, `delay` ms into it (0: before the real driver gets the call).
 */
async function run(v: Variant, stop?: Stop) {
    const { shop, skillPath, settleMs } = shops[v];
    shop.resetRequests();
    const orders0 = shop.orders();
    const context = await browser.newContext();
    // Trusted clicks, typing and keys, across navigations (the binding outlives the document).
    const events: Array<{ t: number; id: string }> = [];
    await context.exposeBinding("__bhaiAct", (_src: unknown, t: number, id: string) => void events.push({ t, id }));
    await context.addInitScript(
        `for (const t of ["click", "input", "keydown"]) addEventListener(t, (e) => { if (e.isTrusted) window.__bhaiAct(Date.now(), String(e.target && (e.target.id || e.target.tagName))); }, true);`,
    );
    const page = await context.newPage();
    await page.goto(shop.url);

    const ac = new AbortController();
    const calls: Call[] = [];
    let phase: Phase = "search";
    let inFlight = false;
    let fired: { wall: number; perf: number; landed: Phase | null } | null = null;
    const fire = () => {
        fired = { wall: Date.now(), perf: performance.now(), landed: inFlight ? phase : null };
        ac.abort();
    };
    let armed = !!stop;
    const real = pageDriver(page, 5000, undefined, ac.signal);
    const watch = async <T>(c: { kind: string; sel?: string }, go: () => Promise<T>): Promise<T> => {
        const call: Call = { ...c, phase, t0: performance.now() };
        calls.push(call);
        if (armed && stop?.at(call, calls.length)) {
            armed = false;
            if (stop.delay === 0) fire();
            else setTimeout(fire, stop.delay);
        }
        try {
            return await go(); // the real call starts synchronously: nothing added before a dispatch
        } finally {
            call.t1 = performance.now();
        }
    };
    const driver: PageDriver = {
        ...real,
        snapshot: () => watch({ kind: "snapshot" }, () => real.snapshot()),
        act: (a, o) => watch({ kind: o?.submit ? "submit" : a.op, sel: a.target?.sel }, () => real.act(a, o)),
    };

    const base = { driver, signal: ac.signal };
    const flow: Array<[Phase, (r: SiteTaskResult) => Promise<SiteTaskResult>, string]> = [
        ["search", () => runSiteTask({ skillPath, phase: "search", input: { query: "paneer" }, ...base }), "options"],
        ["select", (r) => runSiteTask({ task: r.task, phase: "select", input: { id: "p1" }, ...base }), "confirm"],
        [
            "confirm",
            (r) => runSiteTask({ task: r.task, phase: "confirm", consentToken: mintConsent(r.task), ...base }),
            v === "O" ? "needs_user" : "done",
        ],
        ...(v === "O"
            ? [
                  [
                      "resume",
                      (r: SiteTaskResult) => runSiteTask({ task: r.task, phase: "resume", answer: "123456", ...base }),
                      "done",
                  ] as const,
              ]
            : []),
    ] as Array<[Phase, (r: SiteTaskResult) => Promise<SiteTaskResult>, string]>;
    let last: SiteTaskResult | undefined;
    let returned = 0; // performance.now() when the phase running at Stop returned
    for (const [p, f, want] of flow) {
        if (ac.signal.aborted) break; // the agent starts no tool after Stop
        phase = p;
        inFlight = true;
        last = await f(last as SiteTaskResult); // search ignores it
        inFlight = false;
        const landed = (fired as { landed: Phase | null } | null)?.landed;
        if (landed === p) returned = performance.now();
        if (last.status !== want) break;
    }
    const ended = performance.now();
    if (stop && !fired) await pause(450); // a random stop may land after the flow ended
    if (fired) await pause(settleMs); // a committed order may still be on its way
    await context.close();
    return {
        v,
        last: last as SiteTaskResult,
        fired: fired as { wall: number; perf: number; landed: Phase | null } | null,
        returned,
        calls,
        ended,
        events,
        requests: shop.requests(),
        orders: shop.orders() - orders0,
    };
}
type Run = Awaited<ReturnType<typeof run>>;

const halts: number[] = [];
/** The invariants every stopped run keeps. `strict`: Stop came before the real driver had the call. */
function check(x: Run, label: string, strict: boolean) {
    const ctx = `${label} (${x.v}) seed=${SEED}`;
    const f = x.fired;
    if (!f) throw new Error(`${ctx}: Stop never fired`);
    const ws = x.last.writeStatus;
    const posts = x.requests.filter((r) => r.method === "POST");
    const orders = posts.filter((r) => r.path === "/order");
    // Trusted page events after Stop: only the consented submit's click (after the
    // mark), or (not strict) the tail of the action the browser already had at Stop:
    // on that call's own target (any target when it names no #id, e.g. a press), and
    // only until that call returned.
    const late = x.events.filter((e) => e.t > f.wall);
    const handed = strict
        ? []
        : x.calls.filter((c) => c.kind !== "snapshot" && c.t0 <= f.perf && (c.t1 ?? Infinity) > f.perf);
    const tail = (e: { t: number; id: string }) =>
        handed.some(
            (c) =>
                (!/^#[\w-]+$/.test(c.sel ?? "") || c.sel === `#${e.id}`) &&
                e.t <= f.wall + ((c.t1 ?? Number.POSITIVE_INFINITY) - f.perf) + 50, // 50 ms: clock rounding
        );
    const stray = late.filter((e) => !(e.id === "checkout" && ws !== "not_attempted") && !tail(e));
    expect(stray, `${ctx}: page events after Stop`).toEqual([]);
    expect(
        x.calls.filter((c) => c.t0 > f.perf),
        `${ctx}: driver calls started after Stop`,
    ).toEqual([]);
    if (f.landed) {
        expect([x.last.status, x.last.reason], `${ctx}: the running step's result`).toEqual(["aborted", "stopped"]);
        const halt = Math.max(x.returned - f.perf, ...late.map((e) => e.t - f.wall));
        halts.push(halt);
        expect(halt, `${ctx}: Stop to return`).toBeLessThan(HALT_MS);
    }
    // Never half an order: each order has its box ticked, at most one per run, and
    // an order the shop saw is never reported as not attempted.
    for (const o of orders) expect(/captcha=on|"captcha":true/.test(o.body), `${ctx}: ${o.body}`).toBe(true);
    expect(orders.length, ctx).toBeLessThanOrEqual(1);
    expect(x.orders, ctx).toBeLessThanOrEqual(1);
    for (const r of posts.filter((p) => p.path.startsWith("/verify"))) expect(r.body, ctx).toContain("otp=123456");
    if (ws === "not_attempted") {
        expect([posts.map((p) => p.path), x.orders], `${ctx}: nothing sent`).toEqual([[], 0]);
    } else if (x.last.status === "aborted" || x.last.status === "failed") {
        expect(x.last.retry, ctx).toBe("never");
    }
    if (orders.length) expect(ws, ctx).not.toBe("not_attempted");
    return { ws, orders, posts };
}

// Real headless-Chromium E2E: timing-bound assertions on a loaded runner; retry
// absorbs a transient, a real regression fails every attempt (as the sibling E2E files).
describe("global Stop on the synthetic shop", { retry: 2 }, () => {
    it("unstopped warm-up: each shop's flow ends done with one order", async (ctx) => {
        if (!browser) return ctx.skip();
        for (const v of ["P", "S", "O"] as const) {
            const x = await run(v);
            expect([v, x.last.status, x.orders]).toEqual([v, "done", 1]);
            calls0[v] = x.calls.map((c) => x.ended - c.t0);
        }
    }, 120_000);

    const sel = (kind: string, s?: string, p?: Phase) => (c: Call) =>
        c.kind === kind && (!s || c.sel === s) && (!p || c.phase === p);
    const named: Array<{ label: string; v: Variant; stop: Stop; landed: Phase; ws: string; orders: number }> = [
        {
            label: "1 type #q",
            v: "P",
            stop: { at: sel("type", "#q"), delay: 0 },
            landed: "search",
            ws: "not_attempted",
            orders: 0,
        },
        {
            label: "2 click #search, 150 ms into its outcome wait",
            v: "S",
            stop: { at: sel("click", "#search"), delay: 150 },
            landed: "search",
            ws: "not_attempted",
            orders: 0,
        },
        {
            label: "3 click #captcha",
            v: "P",
            stop: { at: sel("click", "#captcha"), delay: 0 },
            landed: "select",
            ws: "not_attempted",
            orders: 0,
        },
        // After the yes is spent, before the write-ahead mark.
        {
            label: "4 confirm's re-read",
            v: "P",
            stop: { at: sel("snapshot", undefined, "confirm"), delay: 0 },
            landed: "confirm",
            ws: "not_attempted",
            orders: 0,
        },
        {
            label: "5 the submit",
            v: "P",
            stop: { at: sel("submit"), delay: 0 },
            landed: "confirm",
            ws: "may_have_applied",
            orders: 1,
        },
        // Clicked; the page's own script sends the order 2.5 s later.
        {
            label: "6 the submit, 200 ms in",
            v: "S",
            stop: { at: sel("submit"), delay: 200 },
            landed: "confirm",
            ws: "may_have_applied",
            orders: 1,
        },
        {
            label: "7 typing the OTP",
            v: "O",
            stop: { at: sel("type", "#otp", "resume"), delay: 0 },
            landed: "resume",
            ws: "may_have_applied",
            orders: 1,
        },
    ];
    it.for(named)(
        "named stop point $label",
        { timeout: 60_000 },
        async ({ label, v, stop, landed, ws, orders }, ctx) => {
            if (!browser) return ctx.skip();
            const x = await run(v, stop);
            expect(x.fired?.landed, label).toBe(landed);
            const got = check(x, label, stop.delay === 0);
            expect([got.ws, got.orders.length], label).toEqual([ws, orders]);
            if (label.startsWith("6")) {
                // Stop returned before the shop even saw the order: the step didn't wait for it.
                const returnedAt = (x.fired?.wall ?? 0) + (x.returned - (x.fired?.perf ?? 0));
                expect(got.orders[0].at, label).toBeGreaterThan(returnedAt);
            }
            if (label.startsWith("7"))
                expect(
                    got.posts.filter((p) => p.path.startsWith("/verify")),
                    label,
                ).toEqual([]);
            const sorted = [...halts].sort((a, b) => a - b);
            console.log(
                `  ⏹ ${label}: halt ${halts.at(-1)?.toFixed(0)} ms (max ${sorted.at(-1)?.toFixed(0)}, p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(0)})`,
            );
        },
    );

    it(`random stop points: ${RUNS - NAMED} seeded runs (SITE_STOP_RUNS)`, async (ctx) => {
        if (!browser || RUNS <= NAMED) return ctx.skip();
        if (!calls0.P) throw new Error("the warm-up didn't run");
        console.log(`  ⏹ random stop points, SITE_STOP_SEED=${SEED}`);
        // mulberry32
        let s = SEED >>> 0;
        const rand = () => {
            s = (s + 0x6d2b79f5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        let landed = 0;
        const committed: Record<Variant, number> = { P: 0, S: 0, O: 0 };
        for (let i = 0; i < RUNS - NAMED; i++) {
            const v = (["P", "S", "O"] as const)[i % 3];
            // The k-th driver call, up to 400 ms in but not past where the flow ended
            // unstopped (a stop after the flow is no test of a running step).
            const k = 1 + Math.floor(rand() * calls0[v].length);
            const delay = Math.floor(rand() * Math.min(401, calls0[v][k - 1]));
            const x = await run(v, { at: (_c, n) => n === k, delay });
            const { ws } = check(x, `random #${i} k=${k} delay=${delay}`, delay === 0);
            if (x.fired?.landed) landed++;
            if (ws !== "not_attempted" && x.fired?.landed) committed[v]++;
        }
        console.log(
            `  ⏹ landed inside a step: ${landed}/${RUNS - NAMED}; stopped after the mark, by shop: ${JSON.stringify(committed)}`,
        );
        const sorted = [...halts].sort((a, b) => a - b);
        console.log(
            `  ⏹ halt over all stops: max ${sorted.at(-1)?.toFixed(0)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(0)} ms`,
        );
        // Most random stops must hit a running step, or the scheme says nothing.
        if (RUNS - NAMED >= 10) expect(landed / (RUNS - NAMED)).toBeGreaterThanOrEqual(0.8);
    }, 1_800_000);
});
