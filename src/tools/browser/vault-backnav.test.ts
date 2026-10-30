// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Real-Chromium probes for the page-JS / screenshot lock after a saved secret is
// typed (security/vault.ts). The lock is keyed on ORIGIN, so it survives Back to a
// no-store page that the browser refills (finding #0) and covers a page that echoes
// the value / auto-advances focus, which a screenshot would otherwise show (finding #5).
import { afterAll, beforeAll, expect, it } from "vitest";
import { anySecretTyped, loadVault, runVaultCall, secretTypedIn } from "../../security/vault.js";
import { typeVaultText, vaultTaintError } from "./vault-typing.js";

const KEY = "sk-live-3e9a7c1b5d2f8e4a6c0b9d7f";
const RULES = [{ token: "{{vault:k.apikey}}", domains: ["legit.test"], payment: false }];
const asVault = <T>(fn: () => Promise<T>) => runVaultCall({ tool: "browser_type", rules: RULES }, fn);

// biome-ignore lint/suspicious/noExplicitAny: playwright is optional here
let browser: any = null;
beforeAll(async () => {
    try {
        const { chromium } = await import("playwright-core");
        browser = await chromium.launch({ headless: true });
    } catch (e) {
        if (process.env.CI || process.env.SITE_E2E_REQUIRE_BROWSER) throw e;
    }
}, 60_000);
afterAll(async () => {
    await browser?.close();
});

it("Back to a no-store page that refills the field is still JS-locked (finding #0)", async (ctx) => {
    if (!browser) return ctx.skip();
    loadVault([{ id: "k", label: "Key", kind: "api_key", name: "K", value: KEY, domains: ["legit.test"] }]);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
        const page = await context.newPage();
        // no-store + an unload handler keeps the page out of the bfcache, so Back
        // loads a fresh document (new timeOrigin) and the browser refills the field.
        await page.route("https://legit.test/**", (r: { request: () => { url: () => string }; fulfill: (o: object) => void }) =>
            r.fulfill({
                status: 200,
                contentType: "text/html",
                headers: { "cache-control": "no-store" },
                body: r.request().url().endsWith("/other")
                    ? "<p>other</p>"
                    : '<script>addEventListener("unload",()=>{})</script><input id="key" type="text">',
            }),
        );
        await page.goto("https://legit.test/settings");
        await page.focus("#key");
        expect(await asVault(() => typeVaultText(page, KEY))).toBeNull();
        expect(await vaultTaintError(page)).toMatch(/saved secret/); // locked before nav
        await page.goto("https://legit.test/other");
        await page.goBack();
        await page.waitForTimeout(300);
        // The field is refilled by the browser...
        const refilled = await page.evaluate("[...document.querySelector('#key').value].join(' ')");
        expect(String(refilled).replace(/ /g, "")).toContain(KEY); // the vuln exists
        // ...but page JavaScript is still refused, so browser_run_js can't read it back.
        expect(await vaultTaintError(page)).toMatch(/saved secret/);
    } finally {
        await context.close();
    }
}, 60_000);

it("a page that echoes the value / auto-advances focus taints the origin (finding #5)", async (ctx) => {
    if (!browser) return ctx.skip();
    loadVault([{ id: "k", label: "Key", kind: "api_key", name: "K", value: KEY, domains: ["legit.test"] }]);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
        const page = await context.newPage();
        await page.route("https://legit.test/**", (r: { fulfill: (o: object) => void }) =>
            r.fulfill({
                status: 200,
                contentType: "text/html",
                // mirrors the value into a div and moves focus on once full — a screenshot
                // would show the value even though the typed field itself is masked.
                body: '<input id="a" oninput="document.getElementById(\'m\').textContent=this.value;if(this.value.length>=27)document.getElementById(\'b\').focus()"><input id="b"><div id="m"></div>',
            }),
        );
        await page.goto("https://legit.test/form");
        await page.focus("#a");
        expect(await asVault(() => typeVaultText(page, KEY))).toBeNull();
        // The origin is tainted, so agent.ts withholds the screenshot (an image protect() can't mask).
        expect(anySecretTyped()).toBe(true);
        expect(secretTypedIn("https://legit.test")).toBe(true);
    } finally {
        await context.close();
    }
}, 60_000);
