// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The real loop: Bhai's unpacked Chrome extension in Playwright's Chromium, the
// real bridge (HTTP /discover → WS auth → commands), and the page driver over
// ChromePageProxy, scripted through the synthetic shop. Native messaging is the
// one piece not covered: Playwright's Chromium has no com.atlas.bridge host, so
// the extension takes its HTTP fallback (the fresh-install path).
//
// BRIDGE_E2E_RUNS=500 SITE_E2E_REQUIRE_BROWSER=1 for the acceptance run (0
// failures in 500, latency and page-ready asserted); plain `npm test` does 3 and
// only logs the timings. The extension hardcodes port 18800, so a running Bhai
// skips this file locally; BRIDGE_E2E_PORT=<free port> runs it beside one with a
// copy of the extension patched to that port (its id then pinned through
// ATLAS_EXTENSION_IDS instead of the shipped-folder id; not on Windows, which
// hashes the path differently and accepts any origin while unpinned). A busy
// port fails the run only in CI; SITE_E2E_REQUIRE_BROWSER (the owner's Mac,
// where Bhai holds 18800) skips it.
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDataDir } from "../../../config/paths.js";
import { bhaiExtensionIds, unpackedExtensionId } from "../../../security/extension-origin.js";
import { ChromeExtensionBackend, type ChromePageProxy } from "../../../tools/browser/chrome-backend.js";
import {
    bridgeCommandFailures,
    closeChromeBridge,
    discoverServesTokens,
    getExtensionStatus,
    initChromeBridge,
    onExtensionEvent,
    waitForExtensionConnection,
} from "../../../tools/browser/chrome-bridge.js";
import type { SiteAction } from "../host.js";
import { pageDriver } from "../page-driver.js";
import { findSiteSkill } from "../registry.js";
import { runSiteTask } from "../runtime.js";
import { SHOP_RESOLVER_ARG, startShop } from "./synthetic-shop.js";

// No overlay socket: the extension only talks to the bridge.
vi.mock("../../../overlay/overlay-chat.js", () => ({ getOverlayLocalToken: () => "" }));
// site_task gets the bridge page, as getActivePage() does in Chrome mode.
const mocks = vi.hoisted(() => ({ page: null as unknown }));
vi.mock("../../../tools/browser/core.js", () => ({ getActivePage: async () => mocks.page }));

const RUNS = Number(process.env.BRIDGE_E2E_RUNS ?? 3);
const PORT = Number(process.env.BRIDGE_E2E_PORT ?? 18800);
const REQUIRED = !!(process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoExt = realpathSync(path.resolve(here, "../../../../chrome-extension"));
const builtin = path.resolve(here, "fixtures");
const commits: SiteAction[] = [{ op: "click", target: { sel: "#checkout", text: "Place order" } }]; // as skill.cjs declares

let ext = repoExt;
const temps: string[] = [];
if (PORT !== 18800) {
    ext = realpathSync(mkdtempSync(path.join(tmpdir(), "bhai-ext-")));
    temps.push(ext);
    cpSync(repoExt, ext, { recursive: true });
    for (const f of ["background.js", "manifest.json"]) {
        const p = path.join(ext, f);
        writeFileSync(p, readFileSync(p, "utf8").replaceAll("18800", String(PORT)));
    }
    if (process.platform !== "win32") process.env.ATLAS_EXTENSION_IDS = unpackedExtensionId(ext);
}

const portFree = (port: number) =>
    new Promise<boolean>((resolve) => {
        const s = net.createServer();
        s.once("error", () => resolve(false));
        s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
const pct = (s: number[], q: number) => (s.length ? [...s].sort((a, b) => a - b)[Math.ceil(q * s.length) - 1] : 0);

let skip = "";
let shop: Awaited<ReturnType<typeof startShop>> | null = null;
// biome-ignore lint/suspicious/noExplicitAny: Playwright BrowserContext (playwright-core is optional here)
let context: any = null;
let page: ChromePageProxy;
let disconnects = 0;
let bridgeUp = false;

beforeAll(async () => {
    process.env.ATLAS_SPEND_CAP_DAY_INR = "1000000"; // many orders × ₹249 would hit the real daily cap
    if (!(await portFree(PORT))) {
        // Never point the test extension at someone else's bridge (a running Bhai's).
        if (process.env.CI) throw new Error(`port ${PORT} is busy: quit Bhai to run the bridge loop`);
        skip = `port ${PORT} is busy (Bhai is running): quit it, or set BRIDGE_E2E_PORT to a free port`;
        return;
    }
    initChromeBridge(PORT);
    bridgeUp = true;
    await vi.waitFor(() => expect(getExtensionStatus()).toBe("waiting_for_extension"), { timeout: 5000 });
    onExtensionEvent((e) => {
        if (e.type === "extension_disconnected") disconnects++;
    });
    shop = await startShop({ location: true, note: true });
    try {
        const { chromium } = await import("playwright-core");
        const profile = mkdtempSync(path.join(tmpdir(), "bhai-bridge-profile-"));
        temps.push(profile);
        // channel "chromium": the default headless shell can't load extensions.
        context = await chromium.launchPersistentContext(profile, {
            channel: "chromium",
            headless: true,
            args: [SHOP_RESOLVER_ARG, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
        });
    } catch (e) {
        // Locally a missing Chromium skips; in CI it must fail, not pass silently.
        if (REQUIRED) throw e;
        skip = `no Chromium: ${(e as Error).message.split("\n")[0]}`;
    }
}, 60_000);

afterAll(async () => {
    delete process.env.ATLAS_SPEND_CAP_DAY_INR;
    await context?.close().catch(() => {});
    if (bridgeUp) closeChromeBridge();
    await shop?.close();
    // Windows: Chromium's helpers can hold the profile a moment after close; a leftover temp dir is harmless.
    for (const d of temps)
        try {
            rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {}
});

describe("Chrome extension ⇄ bridge loop", { retry: RUNS <= 3 ? 2 : 0 }, () => {
    it("the real extension connects over HTTP discovery, from Bhai's pinned origin", async (ctx) => {
        if (skip) return ctx.skip(skip);
        const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
        const id = new URL(sw.url()).host;
        // Windows pins only ATLAS_EXTENSION_IDS (extension-origin.ts), so there any origin is accepted.
        if (process.platform !== "win32") {
            expect(bhaiExtensionIds()?.has(id)).toBe(true);
            if (PORT === 18800) expect(id).toBe(unpackedExtensionId(ext)); // the shipped folder's own id
        }
        expect(await waitForExtensionConnection(20_000)).toBe(true);
        expect(discoverServesTokens()).toBe(true); // HTTP discovery, no native-messaging handoff
        page = await new ChromeExtensionBackend().getPageProxy();
    }, 60_000);

    it(
        `${RUNS} scripted 20-action runs over the bridge: no failures, latency, page-ready`,
        async (ctx) => {
            if (skip) return ctx.skip(skip);
            expect(await waitForExtensionConnection(20_000)).toBe(true);
            page ??= await new ChromeExtensionBackend().getPageProxy();
            const driver = pageDriver(page, 5000);
            const samples: Record<"read" | "click" | "type" | "press" | "nav" | "ready", number[]> = {
                read: [],
                click: [],
                type: [],
                press: [],
                nav: [],
                ready: [],
            };
            const failures: { run: number; step: number; error: string }[] = [];
            const ordersAtStart = shop!.orders();
            const act = (a: SiteAction, submit = false) =>
                driver.act(a, submit ? { submit: true } : { commits }).then(() => undefined);

            for (let run = 1; run <= RUNS; run++) {
                const failsBefore = bridgeCommandFailures().count;
                const dropsBefore = disconnects;
                const ordersBefore = shop!.orders();
                let step = 0;
                // One timed op. `ready`: it navigates; it counts as a page-ready sample only when an
                // untimed in-page read right after shows the expected page, fully loaded.
                const op = async <T>(cls: keyof typeof samples, f: () => Promise<T>, ready?: RegExp): Promise<T> => {
                    step++;
                    const t = performance.now();
                    const r = await f();
                    const ms = performance.now() - t;
                    samples[cls].push(ms);
                    if (ready) {
                        const [where, state] = (await page.evaluate(
                            "[location.pathname + location.search, document.readyState]",
                        )) as [string, string];
                        if (!ready.test(where) || state !== "complete")
                            throw new Error(`early page-ready: ${where} ${state}, expected ${ready}`);
                        samples.ready.push(ms);
                    }
                    return r;
                };
                const read = async () => {
                    const s = await driver.snapshot();
                    return { ...s, url: new URL(s.url).pathname + new URL(s.url).search };
                };
                try {
                    await op("nav", () => act({ op: "navigate", value: shop!.url }), /^\/$/); // 1
                    expect((await op("read", read)).text).toContain("We use cookies"); // 2
                    await op("click", () => act({ op: "click", target: { sel: "#accept" } })); // 3
                    await op("type", () => act({ op: "type", target: { sel: "#loc" }, value: "Indira" })); // 4
                    await op("read", () => act({ op: "waitFor", target: { text: "Indiranagar 2nd Stage" } })); // 5
                    await op("click", () => act({ op: "click", target: { text: "Indiranagar 2nd Stage, Bengaluru" } })); // 6
                    expect((await op("read", read)).text).toContain("Delivering to Indiranagar 2nd Stage, Bengaluru"); // 7
                    await op("type", () => act({ op: "type", target: { sel: "#q" }, value: "dal" })); // 8
                    await op("type", () => act({ op: "type", target: { sel: "#q" }, value: "paneer" })); // 9: fill replaces
                    await op("press", () => act({ op: "press", value: "Enter" }), /^\/results\?q=paneer$/); // 10
                    const results = await op("read", read); // 11
                    expect(results.url).toBe("/results?q=paneer");
                    expect(results.text).toContain("Paneer Butter Masala");
                    expect(results.text).not.toContain("Dal");
                    await op(
                        "click",
                        () => act({ op: "click", target: { sel: 'a[data-id="p1"]' } }),
                        /^\/cart\?id=p1$/,
                    ); // 12
                    expect((await op("read", read)).text).toMatch(/Paneer Tikka\s*₹249/); // 13
                    await op("type", () => act({ op: "type", target: { sel: "#note" }, value: "ring the bell" })); // 14
                    await op("click", () => act({ op: "click", target: { sel: "#captcha" } })); // 15
                    expect(await op("read", () => page.evaluate("document.getElementById('captcha').checked"))).toBe(
                        true,
                    ); // 16
                    // 17: a driver-level check of the consented submit over the proxy (exactly one
                    // order). Users never reach it: site_task refuses checkout through the
                    // extension (the last test here).
                    await op(
                        "click",
                        () => act({ op: "click", target: { sel: "#checkout" } }, true),
                        /^\/done\?n=\d+$/,
                    );
                    const done = await op("read", read); // 18
                    expect(done.text).toContain(`Order placed #${ordersBefore + 1}`);
                    expect(shop!.orders()).toBe(ordersBefore + 1);
                    await op("nav", () => act({ op: "navigate", value: shop!.url }), /^\/$/); // 19
                    expect((await op("read", read)).text).not.toContain("We use cookies"); // 20: the profile kept the cookie
                    const failed = bridgeCommandFailures();
                    if (failed.count > failsBefore)
                        throw new Error(
                            `bridge command failures: ${JSON.stringify(failed.recent.slice(failsBefore - failed.count))}`,
                        );
                    if (disconnects > dropsBefore)
                        throw new Error(`extension disconnected ${disconnects - dropsBefore}×`);
                } catch (e) {
                    failures.push({ run, step, error: String((e as Error).message ?? e).slice(0, 300) });
                    await waitForExtensionConnection(10_000);
                }
                await context.clearCookies(); // harness, not the bridge: the next run sees the cookie modal again
            }

            const fmt = (k: keyof typeof samples) =>
                `${k} p50/p95 ${Math.round(pct(samples[k], 0.5))}/${Math.round(pct(samples[k], 0.95))}ms`;
            console.log(
                `⏱️ [bridge-loop] runs=${RUNS} ${(["click", "type", "read", "press", "nav"] as const).map(fmt).join(" · ")} · ready p95 ${Math.round(pct(samples.ready, 0.95))}ms · failures=${failures.length}`,
            );
            expect(failures).toEqual([]);
            expect(shop!.orders() - ordersAtStart).toBe(RUNS); // no duplicate, no missing submit
            // Latency targets only on an acceptance run: a shared CI runner at 3 runs proves nothing about them.
            if (RUNS > 3) {
                for (const k of ["click", "type", "read", "press"] as const) {
                    expect(pct(samples[k], 0.5), `${k} p50`).toBeLessThan(1500);
                    expect(pct(samples[k], 0.95), `${k} p95`).toBeLessThan(4000);
                }
                expect(pct(samples.ready, 0.95), "page-ready p95").toBeLessThan(3000);
            }
        },
        120_000 + RUNS * 30_000,
    );

    it("site_task refuses to confirm an order through the extension", async (ctx) => {
        if (skip) return ctx.skip(skip);
        expect(await waitForExtensionConnection(20_000)).toBe(true);
        page ??= await new ChromeExtensionBackend().getPageProxy();
        await context.clearCookies();
        // The search and select phases run for real over the bridge and park the task at confirm.
        const driver = pageDriver(page, 5000);
        const skillPath = findSiteSkill(shop!.url, [builtin])!;
        const dir = path.join(getDataDir(), "site-tasks");
        const s = await runSiteTask({
            skillPath,
            phase: "search",
            input: { query: "paneer" },
            driver,
            checkpointDir: dir,
        });
        expect(s.status).toBe("options");
        const c = await runSiteTask({ task: s.task, phase: "select", input: { id: "p1" }, driver, checkpointDir: dir });
        expect([c.status, c.confirm?.amount]).toEqual(["confirm", 249]);

        mocks.page = page;
        const { siteTask } = await import("../../../tools/site-task.js");
        const before = shop!.orders();
        const r = JSON.parse(await siteTask.handler({ action: "confirm", amount: 249 }));
        expect(r.error).toMatch(/Checkout through the Chrome extension isn't supported/);
        expect(shop!.orders()).toBe(before);
    }, 60_000);
});
