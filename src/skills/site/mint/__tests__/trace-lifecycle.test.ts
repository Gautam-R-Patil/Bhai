// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A recorded session ends by itself and is not kept forever: a new trace on
// the same browser closes the old one (its last page kept), a step after a
// long pause or past the page cap is not recorded, and trace folders older
// than 14 days are deleted. Offline: the synthetic shop and local Chromium.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SHOP_RESOLVER_ARG, startShop } from "../../__tests__/synthetic-shop.js";
import {
    drainTrace,
    loadTrace,
    MAX_TRACE_PAGES,
    startTrace,
    stopTrace,
    sweepTraces,
    TRACE_IDLE_MS,
    TRACE_RETENTION_MS,
    tracing,
} from "../recorder.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "site-trace-life-"));
const lines = (dir: string) =>
    existsSync(path.join(dir, "trace.jsonl"))
        ? readFileSync(path.join(dir, "trace.jsonl"), "utf8").split("\n").filter(Boolean)
        : [];

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => {
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, args: [SHOP_RESOLVER_ARG] });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
        return;
    }
    shop = await startShop();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await shop?.close();
});

describe("a trace ends by itself", () => {
    it("a new trace on the same browser closes the old one, keeping its last page and what was done there", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const root = tmp();
            const first = (await startTrace(context, "shop.test", { root })).dir;
            await page.goto(shop.url);
            await drainTrace(page);
            await page.click("#accept"); // done on page 0, not drained yet
            const second = (await startTrace(page, "other.test", { root })).dir;
            expect(tracing(page)).toBe("other.test");
            const t = loadTrace(first);
            expect(t.pages).toHaveLength(1);
            expect(t.pages[0].events.map((e) => e.target.id)).toEqual(["accept"]);
            // The page on shop.test no longer records into either trace.
            await page.fill("#q", "dal");
            await drainTrace(page);
            await stopTrace(page);
            expect(loadTrace(first).pages).toHaveLength(1);
            expect(loadTrace(second).pages.every((p) => p.offsite && p.events.length === 0)).toBe(true);
        } finally {
            await context.close();
        }
    }, 60_000);

    it("a browser step after a long pause is not recorded, and the trace is closed", async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const dir = (await startTrace(context, "shop.test", { root: tmp() })).dir;
            await page.goto(shop.url);
            await drainTrace(page);
            await page.click("#accept");
            await drainTrace(page);
            expect(lines(dir)).toHaveLength(1);
            const later = Date.now() + TRACE_IDLE_MS + 1000;
            const now = vi.spyOn(Date, "now").mockReturnValue(later);
            try {
                await page.fill("#q", "my home address"); // a different task, an hour later
                expect(await drainTrace(page)).toBeNull();
            } finally {
                now.mockRestore();
            }
            expect(tracing(page)).toBeNull();
            const t = loadTrace(dir);
            expect(t.pages).toHaveLength(2); // the page before the pause is kept, with nothing done after it
            expect(JSON.stringify(t.pages)).not.toContain("my home address");
            expect(readFileSync(path.join(dir, "pages", "1.html"), "utf8")).not.toContain("my home address");
        } finally {
            await context.close();
        }
    }, 60_000);

    it(`stops after ${MAX_TRACE_PAGES} pages`, async (ctx) => {
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        try {
            const page = await context.newPage(); // about:blank: off the domain, so each drain is a cheap stub
            const dir = (await startTrace(context, "shop.test", { root: tmp() })).dir;
            for (let i = 0; i < MAX_TRACE_PAGES; i++) expect(await drainTrace(page)).toBe(i);
            expect(await drainTrace(page)).toBeNull();
            expect(tracing(page)).toBeNull();
            expect(lines(dir)).toHaveLength(MAX_TRACE_PAGES);
        } finally {
            await context.close();
        }
    }, 60_000);
});

describe("retention", () => {
    it("deletes trace folders older than 14 days, never a newer or a recording one", async (ctx) => {
        const root = tmp();
        const make = (id: string, ageMs: number) => {
            const dir = path.join(root, id);
            mkdirSync(path.join(dir, "pages"), { recursive: true });
            writeFileSync(path.join(dir, "meta.json"), "{}");
            writeFileSync(path.join(dir, "trace.jsonl"), "");
            const at = (Date.now() - ageMs) / 1000;
            utimesSync(path.join(dir, "trace.jsonl"), at, at);
            return dir;
        };
        const old = make("t_old", TRACE_RETENTION_MS + 60_000);
        const fresh = make("t_fresh", TRACE_RETENTION_MS - 60_000);
        expect(sweepTraces(root)).toBe(1);
        expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);

        // startTrace sweeps too, and a trace still recording is never swept, however old it looks.
        if (!browser) return ctx.skip();
        const context = await browser.newContext();
        try {
            const old2 = make("t_old2", TRACE_RETENTION_MS + 60_000);
            const live = (await startTrace(context, "shop.test", { root })).dir;
            expect(existsSync(old2)).toBe(false);
            expect(sweepTraces(root, Date.now() + 2 * TRACE_RETENTION_MS)).toBe(1); // t_fresh, not the live one
            expect(existsSync(live)).toBe(true);
            await stopTrace(await context.newPage());
        } finally {
            await context.close();
        }
    }, 60_000);
});
