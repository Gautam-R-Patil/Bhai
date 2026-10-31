// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A saved secret (security/vault.ts) typed while a site is being recorded for
// the Skill Minter is written to the trace as its token, never as the value.
// Offline: the synthetic shop and local Chromium.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { handleDesktopLine } from "../../../../security/vault.js";
import { SHOP_RESOLVER_ARG, startShop } from "../../__tests__/synthetic-shop.js";
import { drainTrace, startTrace, stopTrace } from "../recorder.js";

const KEY = "sk-live-3e9a7c1b5d2f8e4a6c0b9d7f";
// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => {
    try {
        const { chromium } = await import("playwright-core");
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

const allText = (dir: string): string =>
    readdirSync(dir, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? allText(path.join(dir, d.name)) : readFileSync(path.join(dir, d.name), "utf8")))
        .join("\n");

it("a typed saved secret is stored as its token in the trace", async (ctx) => {
    if (!browser) return ctx.skip();
    handleDesktopLine(
        `##BHAI_VAULT##${JSON.stringify([{ id: "k", label: "Key", kind: "api_key", name: "K", value: KEY, domains: ["shop.test"] }])}`,
    );
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        const dir = (
            await startTrace(context, "shop.test", { root: mkdtempSync(path.join(tmpdir(), "site-trace-vault-")) })
        ).dir;
        await page.goto(shop.url);
        await drainTrace(page);
        await page.fill("#q", KEY);
        await drainTrace(page);
        await stopTrace(page);
        const text = allText(dir);
        expect(text).not.toContain(KEY);
        expect(text).toContain("{{vault:k.apikey}}");
    } finally {
        await context.close();
    }
}, 60_000);
