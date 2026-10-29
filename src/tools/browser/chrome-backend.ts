// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Chrome Extension Backend ─────────────────
// Implements BrowserBackend by proxying all operations through the
// Chrome Bridge WebSocket to the user's real Chrome browser.
// The agent interacts directly with the user's tabs — no headless browser needed.

import type { BrowserBackend, BrowserPageInfo } from "./browser-backend.js";
import { getActiveExtensionTab, getExtensionTabs, sendBridgeCommand } from "./chrome-bridge.js";
import type { ClickOptions, InteractiveElement, TabInfo } from "./types.js";

// ── ChromePageProxy ──────────────────────────
// Mimics the Playwright Page API surface so existing tool handlers
// can call page.goto(), page.evaluate(), page.mouse.click() etc.
// and the proxy transparently routes to the Chrome extension.

/**
 * Page-ready over the bridge, event-driven: one in-page promise that resolves
 * when a document created after `since` has finished loading and its DOM has
 * been quiet for `quietMs`, or after `maxMs`. A navigation mid-wait destroys
 * the old document and the call errors, so we retry on the new one. Replaces
 * the fixed 300-1000ms sleeps (too slow on fast pages, too early on slow ones).
 */
export const readyJs = (maxMs: number, quietMs: number, since: number) => `new Promise((resolve) => {
  const start = Date.now(); let last = Date.now();
  const mo = new MutationObserver(() => { last = Date.now(); });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true }); // not attributes: animations never stop
  const tick = () => {
    const now = Date.now();
    const fresh = performance.timeOrigin >= ${since} - 1000;
    const settled = document.readyState === "complete" && now - last >= ${quietMs};
    // A single-page app changes route without a new document: once the old one has
    // been settled for a second, accept it instead of waiting out the whole budget.
    if ((settled && (fresh || now - start >= 1000)) || now - start >= ${maxMs}) {
      mo.disconnect(); resolve(fresh ? "ready" : "stale");
    } else setTimeout(tick, 50);
  };
  tick();
})`;

export async function waitBridgeReady(maxMs = 3000, quietMs = 300, since = 0): Promise<void> {
    const deadline = Date.now() + maxMs;
    let errors = 0;
    while (Date.now() < deadline) {
        const left = deadline - Date.now();
        const r = await sendBridgeCommand("execute_js", { code: readyJs(left, quietMs, since) }, left + 2000).catch(
            () => null,
        );
        if (r === "ready" || r === "stale") return; // stale = settled on the same document
        if (++errors >= 3) return; // the bridge keeps failing: don't spin, let the caller carry on
        await new Promise((res) => setTimeout(res, 150));
    }
}

export class ChromePageProxy {
    private _url = "";
    private _title = "";

    constructor(url?: string, title?: string) {
        this._url = url || "";
        this._title = title || "";
    }

    // url() is sync (Playwright API), so it returns the last refresh. Every
    // action that can navigate (click, key press, back/forward) and every wait
    // refreshes, so a click or Enter that changes the page is seen.
    url(): string {
        return this._url;
    }

    /**
     * Re-read url/title after something that may navigate (a click, Enter). A link's
     * navigation starts a beat after the click, so look again shortly after and, while
     * the tab is loading, wait for it (up to 8s) instead of reporting the old page.
     */
    private async syncTab(): Promise<void> {
        const read = () =>
            getActiveExtensionTab().catch(() => null) as Promise<{
                url: string;
                title?: string;
                status?: string;
                pendingUrl?: string;
            } | null>;
        const before = this._url;
        await new Promise((r) => setTimeout(r, 250));
        let tab = await read();
        const end = Date.now() + 8000;
        while (
            tab &&
            (tab.status === "loading" || (tab.pendingUrl && tab.pendingUrl !== tab.url)) &&
            Date.now() < end
        ) {
            await new Promise((r) => setTimeout(r, 200));
            tab = await read();
        }
        if (tab?.url) {
            this._url = tab.url;
            this._title = tab.title || "";
        }
        if (this._url !== before) await waitBridgeReady(3000, 200, Date.now()).catch(() => {});
    }

    /** The active tab's URL right now (url() is a cache: clicks, redirects and tab switches don't update it). */
    async liveUrl(): Promise<string> {
        const tab = await getActiveExtensionTab();
        this._url = tab?.url ?? "";
        if (tab?.title) this._title = tab.title;
        return this._url;
    }

    /** Re-read the active tab's URL and title from the extension (best effort). */
    async refresh(): Promise<void> {
        const tab = await getActiveExtensionTab().catch(() => null);
        if (tab?.url) {
            this._url = tab.url;
            this._title = tab.title || "";
        }
    }

    async title(): Promise<string> {
        await this.refresh();
        return this._title;
    }

    async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
        const since = Date.now();
        await sendBridgeCommand("navigate", { url, timeout: opts?.timeout }, opts?.timeout || 30000);
        this._url = url;
        await waitBridgeReady(Math.min(opts?.timeout ?? 10000, 10000), 300, since);
        // Re-fetch actual URL (may have redirected)
        const tab = await getActiveExtensionTab();
        if (tab) {
            this._url = tab.url;
            this._title = tab.title;
        }
    }

    async evaluate(fn: ((...args: unknown[]) => unknown) | string, ...args: unknown[]): Promise<unknown> {
        let code: string;
        if (typeof fn === "function") {
            // Serialize function and args for remote execution
            code = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
        } else {
            code = fn;
        }
        return sendBridgeCommand("execute_js", { code }, 15000);
    }

    async waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown> {
        const timeout = opts?.timeout || 10000;
        await sendBridgeCommand("wait_for", { selector, timeout }, timeout + 1000);
        return {}; // Playwright returns ElementHandle — we return a stub
    }

    async waitForTimeout(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
        await this.refresh();
    }

    // Playwright-compatible (fn, arg, options): polls evaluate() until truthy.
    // Evaluate errors (e.g. mid-navigation) count as "not yet".
    async waitForFunction(
        fn: ((...args: unknown[]) => unknown) | string,
        arg?: unknown,
        opts?: { timeout?: number; polling?: number | "raf" },
    ): Promise<unknown> {
        const timeout = opts?.timeout ?? 30000;
        const polling = typeof opts?.polling === "number" ? opts.polling : 100;
        const deadline = Date.now() + timeout;
        for (;;) {
            const value = await (arg === undefined ? this.evaluate(fn) : this.evaluate(fn, arg)).catch(() => null);
            if (value) return value;
            if (Date.now() + polling > deadline) throw new Error(`waitForFunction: timeout ${timeout}ms exceeded`);
            await new Promise((resolve) => setTimeout(resolve, polling));
        }
    }

    async waitForLoadState(_state?: string, opts?: { timeout?: number }): Promise<void> {
        await waitBridgeReady(Math.min(opts?.timeout ?? 5000, 5000));
        await this.refresh();
    }

    // Navigation
    async goBack(): Promise<void> {
        const since = Date.now();
        await sendBridgeCommand("go_back", {});
        await waitBridgeReady(5000, 300, since);
        await this.refresh();
    }

    async goForward(): Promise<void> {
        // Forward is not in our command set — execute via JS
        const since = Date.now();
        await sendBridgeCommand("execute_js", { code: "window.history.forward()" });
        await waitBridgeReady(5000, 300, since);
        await this.refresh();
    }

    // Interaction proxies
    /**
     * A click lands only inside the viewport (real input, like a person's). A point
     * outside it (a scan label below the fold) is scrolled into view first and
     * moved by however far the page actually scrolled.
     */
    private async intoView(x: number, y: number): Promise<[number, number]> {
        const v = (await this.evaluate("({ w: innerWidth, h: innerHeight })").catch(() => null)) as {
            w: number;
            h: number;
        } | null;
        if (!v || (x >= 0 && y >= 0 && x < v.w && y < v.h)) return [x, y];
        const dx = x < 0 || x >= v.w ? Math.round(x - v.w / 2) : 0;
        const dy = y < 0 || y >= v.h ? Math.round(y - v.h / 2) : 0;
        const moved = (await this.evaluate(
            `(() => { const sx = scrollX, sy = scrollY; scrollBy({ left: ${dx}, top: ${dy}, behavior: "instant" }); return { dx: scrollX - sx, dy: scrollY - sy }; })()`,
        ).catch(() => null)) as { dx: number; dy: number } | null;
        return moved ? [x - moved.dx, y - moved.dy] : [x, y];
    }

    mouse = {
        click: async (x: number, y: number, opts?: { button?: string }) => {
            const [cx, cy] = await this.intoView(x, y);
            await sendBridgeCommand("click_at", { x: cx, y: cy, button: opts?.button || "left" });
            await this.syncTab();
        },
        dblclick: async (x: number, y: number) => {
            const [cx, cy] = await this.intoView(x, y);
            await sendBridgeCommand("click_at", { x: cx, y: cy, doubleClick: true });
            await this.syncTab();
        },
        // wheel() — maps deltaX/deltaY to the Chrome extension's scroll command.
        // page.mouse.wheel() is a Playwright-only API; ChromePageProxy must implement it.
        wheel: async (deltaX: number, deltaY: number) => {
            const direction = deltaY > 0 ? "down" : deltaY < 0 ? "up" : deltaX > 0 ? "right" : "left";
            const amount = Math.abs(deltaY || deltaX);
            await sendBridgeCommand("scroll", { direction, amount });
        },
        move: async (x: number, y: number, opts?: { steps?: number }) => {
            const steps = opts?.steps || 1;
            if (steps <= 1) {
                await sendBridgeCommand("hover", { x, y });
                return;
            }
            // Simulate interpolated movement — needed for CSS :hover transitions.
            // Get the last known position (approximation: start from page center if unknown).
            const startX = 640,
                startY = 400;
            for (let i = 1; i <= steps; i++) {
                const ix = Math.round(startX + (x - startX) * (i / steps));
                const iy = Math.round(startY + (y - startY) * (i / steps));
                await sendBridgeCommand("hover", { x: ix, y: iy });
            }
        },
    };

    keyboard = {
        // Playwright-style combos ("ControlOrMeta+a", "Shift+Tab") as a key plus modifiers.
        press: async (combo: string) => {
            const parts = combo.length > 1 ? combo.split("+") : [combo];
            const key = parts.pop() || combo;
            const modifiers = parts.map((m) =>
                m === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : m === "Cmd" ? "Meta" : m,
            );
            await sendBridgeCommand("keyboard", { key, modifiers, action: "press" });
            if (key === "Enter") await this.syncTab();
            else await this.refresh();
        },
        down: async (key: string) => {
            await sendBridgeCommand("keyboard", { key, action: "down" });
        },
        up: async (key: string) => {
            await sendBridgeCommand("keyboard", { key, action: "up" });
        },
        // vaultRules: the text holds a saved secret; the extension types it only
        // if the page's origin matches, checked in the page in the same step.
        // `clear` (Bhai extension, not Playwright): replace the field instead of typing at the caret.
        type: async (text: string, opts?: { vaultRules?: unknown[]; clear?: boolean }) => {
            const clear = opts?.clear === true;
            const r = (await sendBridgeCommand(
                "type_text",
                opts?.vaultRules ? { text, vaultRules: opts.vaultRules, secret: true, clear } : { text, clear },
            )) as { success?: boolean; error?: string; guarded?: boolean } | null;
            if (r && r.success === false) throw new Error(r.error || "type_text failed");
            if (opts?.vaultRules && !r?.guarded)
                console.warn("  🔐 [vault] the Chrome extension is out of date: no in-page origin check (update it)");
        },
    };

    async screenshot(opts?: { type?: string; quality?: number; fullPage?: boolean }): Promise<Buffer> {
        return chromeScreenshot(opts?.type === "png" ? "png" : "jpeg", opts?.quality);
    }

    // Frames — Chrome extension scans all frames via chrome.scripting
    frames(): ChromePageProxy[] {
        // The extension handles frame scanning internally via allFrames:true
        // Return self as the only "frame" — the extension merges them
        return [this];
    }

    // ── Playwright Page API compatibility methods ──
    // These methods are called by existing tool handlers (browserClick, browserSelect,
    // browserUploadFile, browserMultiAction). They return proxy objects that route
    // operations through the Chrome extension bridge.

    locator(selector: string): ChromeLocatorProxy {
        return new ChromeLocatorProxy(selector);
    }

    getByText(text: string, opts?: { exact?: boolean }): ChromeLocatorProxy {
        // Convert text search to a CSS/XPath selector via JS execution
        const exact = opts?.exact ?? false;
        // An XPath string literal: concat() when the text holds both quote kinds.
        const lit = !text.includes("'")
            ? `'${text}'`
            : !text.includes('"')
              ? `"${text}"`
              : `concat('${text.split("'").join(`', "'", '`)}')`;
        const has = (expr: string) => (exact ? `normalize-space(${expr})=${lit}` : `contains(${expr},${lit})`);
        // Text nodes, plus buttons / inputs named by value or aria-label (<input value="Submit"> has no text node).
        const xpath = `//*[not(self::script or self::style or self::title)][text()[${has(".")}]] | //*[@value][self::input or self::button][${has("@value")}] | //*[@aria-label][${has("@aria-label")}]`;
        return new ChromeLocatorProxy(`xpath=${xpath}`);
    }

    getByRole(role: string, opts?: { name?: string }): ChromeLocatorProxy {
        let selector = `[role="${role}"]`;
        if (opts?.name) {
            // Match by role + accessible name (aria-label, text content, etc.)
            selector = `[role="${role}"][aria-label="${opts.name}"], [role="${role}"]:has-text("${opts.name}")`;
        }
        return new ChromeLocatorProxy(selector);
    }

    getByLabel(text: string): ChromeLocatorProxy {
        return new ChromeLocatorProxy(
            `[aria-label="${text}"], label:has-text("${text}") + input, label:has-text("${text}") + select`,
        );
    }

    async selectOption(selector: string, value: string | string[]): Promise<void> {
        const values = Array.isArray(value) ? value : [value];
        await sendBridgeCommand("select_option", { selector, values });
    }

    // Element query shorthand ($ operator)
    async $(selector: string): Promise<ChromeLocatorProxy | null> {
        const result = (await sendBridgeCommand("execute_js", {
            code: `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.left + rect.width/2, y: rect.top + rect.height/2, found: true };
            })()`,
        })) as { x: number; y: number; found: boolean } | null;
        if (!result || !result.found) return null;
        return new ChromeLocatorProxy(selector);
    }
}

/**
 * The active tab's viewport. CDP first: it works with the window unfocused and in any
 * tab; captureVisibleTab (the bridge's screenshot) needs the window in front and
 * fails with "Cannot access contents of url" in some windows. Older extensions
 * without the cdp command fall back to it.
 */
async function chromeScreenshot(format: "png" | "jpeg", quality?: number): Promise<Buffer> {
    const cdp = (await sendBridgeCommand(
        "cdp",
        {
            method: "Page.captureScreenshot",
            params: { format, ...(format === "jpeg" ? { quality: quality || 55 } : {}) },
        },
        10000,
    ).catch(() => null)) as { data?: string } | null;
    if (cdp?.data) return Buffer.from(cdp.data, "base64");
    const result = (await sendBridgeCommand("screenshot", { format, quality: quality || 55 })) as { base64: string };
    return Buffer.from(result.base64, "base64");
}

export class ChromeLocatorProxy {
    private selector: string;
    /** Which match: 0 = first (the first visible one), -1 = last, n = nth. */
    private index: number;

    constructor(selector: string, index = 0) {
        this.selector = selector;
        this.index = index;
    }

    /** A JS expression for every element the selector (CSS or xpath=) matches. */
    private allJs(): string {
        return this.selector.startsWith("xpath=")
            ? `(() => { const r = document.evaluate(${JSON.stringify(this.selector.slice(6))}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return Array.from({ length: r.snapshotLength }, (_, k) => r.snapshotItem(k)); })()`
            : `(() => { try { return Array.from(document.querySelectorAll(${JSON.stringify(this.selector)})); } catch { return []; } })()`;
    }

    /** A JS expression for the element, honouring the index. */
    private elJs(): string {
        // "first" means the first one a person could click: hidden duplicates (menus, templates) come first in the DOM.
        return `(() => {
            const all = ${this.allJs()};
            const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const i = ${this.index};
            if (i === 0) return all.find(shown) || all[0] || null;
            return all[i < 0 ? all.length + i : i] || null;
        })()`;
    }

    /** In-page IIFE running `body` with `el` bound to this locator's element (or null). */
    withEl(body: string): string {
        return `(() => { const el = ${this.elJs()}; ${body} })()`;
    }

    private run<T>(body: string, timeoutMs = 5000): Promise<T> {
        return sendBridgeCommand("execute_js", { code: this.withEl(body) }, timeoutMs) as Promise<T>;
    }

    private async findElement(): Promise<{ x: number; y: number; found: boolean }> {
        const r = await this.run<{ x: number; y: number; found: boolean } | null>(
            `if (!el) return { found: false, x: 0, y: 0 };
            el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            const rect = el.getBoundingClientRect();
            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
            10000,
        );
        return r || { found: false, x: 0, y: 0 };
    }

    async click(opts?: { timeout?: number }): Promise<void> {
        const el = await this.findElement();
        if (!el.found) throw new Error(`Element not found: ${this.selector}`);
        await sendBridgeCommand("click_at", { x: el.x, y: el.y });
    }

    async dblclick(): Promise<void> {
        const el = await this.findElement();
        if (!el.found) throw new Error(`Element not found: ${this.selector}`);
        await sendBridgeCommand("click_at", { x: el.x, y: el.y, doubleClick: true });
    }

    async fill(text: string): Promise<void> {
        const el = await this.findElement();
        if (!el.found) throw new Error(`Element not found: ${this.selector}`);
        await sendBridgeCommand("click_at", { x: el.x, y: el.y }); // focus
        await sendBridgeCommand("type_text", { text, clear: true }); // replace, like Playwright fill()
    }

    async type(text: string): Promise<void> {
        await this.fill(text);
    }

    async count(): Promise<number> {
        const n = await sendBridgeCommand("execute_js", { code: `${this.allJs()}.length` }, 5000);
        return (n as number) || 0;
    }

    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
        return this.run(
            "if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };",
        );
    }

    textContent(): Promise<string | null> {
        return this.run("return el ? el.textContent : null;");
    }

    async innerText(): Promise<string> {
        return ((await this.run("return el ? el.innerText : '';")) as string) || "";
    }

    async isVisible(): Promise<boolean> {
        return (
            ((await this.run(
                "if (!el) return false; const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;",
            )) as boolean) || false
        );
    }

    async scrollIntoViewIfNeeded(): Promise<void> {
        // Instant, and only when needed: callers measure the box right after.
        await this.run(
            "if (!el) return; const r = el.getBoundingClientRect(); if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });",
        );
    }

    async selectOption(value: string | string[]): Promise<string[]> {
        const values = Array.isArray(value) ? value : [value];
        await sendBridgeCommand("select_option", { selector: this.selector, values });
        return values;
    }

    async setInputFiles(files: string | string[]): Promise<void> {
        // File upload through Chrome extension is limited
        // We can trigger the file input click but can't programmatically set files
        // due to browser security restrictions
        throw new Error(
            "File upload is not supported in Chrome extension mode. Switch to Playwright mode with browser_set_mode('playwright') for file uploads.",
        );
    }

    async hover(): Promise<void> {
        const el = await this.findElement();
        if (!el.found) throw new Error(`Element not found: ${this.selector}`);
        await sendBridgeCommand("hover", { x: el.x, y: el.y });
    }

    async focus(): Promise<void> {
        await this.run("if (el && el.focus) el.focus();");
    }

    // Playwright semantics: the first / last / index-th MATCH (not :first-of-type).
    first(): ChromeLocatorProxy {
        return new ChromeLocatorProxy(this.selector, 0);
    }

    last(): ChromeLocatorProxy {
        return new ChromeLocatorProxy(this.selector, -1);
    }

    nth(index: number): ChromeLocatorProxy {
        return new ChromeLocatorProxy(this.selector, index);
    }
}

// ── Chrome Extension Backend Implementation ──

export class ChromeExtensionBackend implements BrowserBackend {
    readonly mode = "chrome" as const;
    private pageProxy: ChromePageProxy | null = null;

    // ── Navigation ──

    async navigate(
        url: string,
        opts?: { newTab?: boolean; waitFor?: string; timeout?: number },
    ): Promise<{ title: string; url: string }> {
        const timeout = opts?.timeout || 30000;

        const since = Date.now();
        if (opts?.newTab) {
            await sendBridgeCommand("navigate", { url, newTab: true, timeout }, timeout);
        } else {
            await sendBridgeCommand("navigate", { url, timeout }, timeout);
        }
        await waitBridgeReady(Math.min(timeout, 10000), 300, since);

        if (opts?.waitFor) {
            await sendBridgeCommand(
                "wait_for",
                {
                    selector: opts.waitFor,
                    timeout: 10000,
                },
                12000,
            ).catch(() => {
                /* non-fatal */
            });
        }

        const tab = await getActiveExtensionTab();
        const title = tab?.title || "";
        const finalUrl = tab?.url || url;

        // Update proxy cache
        if (this.pageProxy) {
            this.pageProxy = new ChromePageProxy(finalUrl, title);
        }

        return { title, url: finalUrl };
    }

    async goBack(): Promise<void> {
        await sendBridgeCommand("go_back", {});
    }

    async waitForReady(timeoutMs = 3000): Promise<void> {
        await waitBridgeReady(timeoutMs);
    }

    // ── Page / Tab Access ──

    async getActivePage(): Promise<BrowserPageInfo> {
        const tab = await getActiveExtensionTab();
        if (!tab) {
            return { url: "", title: "" };
        }
        return { url: tab.url, title: tab.title };
    }

    async getAllTabs(): Promise<TabInfo[]> {
        const tabs = await getExtensionTabs();
        return tabs.map((t) => ({
            index: t.index,
            title: t.title,
            url: t.url,
            active: t.active,
        }));
    }

    async switchTab(index: number): Promise<void> {
        const tabs = await getExtensionTabs();
        const target = tabs[index];
        if (!target) {
            throw new Error(`Tab index ${index} out of range (${tabs.length} tabs open)`);
        }
        await sendBridgeCommand("switch_tab", { tabId: target.id });
        this.pageProxy = null; // Invalidate page proxy
    }

    async newTab(url?: string): Promise<void> {
        await sendBridgeCommand("navigate", { url: url || "about:blank", newTab: true });
        this.pageProxy = null;
    }

    async closeTab(index?: number): Promise<void> {
        if (index !== undefined) {
            const tabs = await getExtensionTabs();
            const target = tabs[index];
            if (target) {
                await sendBridgeCommand("close_tab", { tabId: target.id });
            }
        } else {
            await sendBridgeCommand("close_tab", {});
        }
        this.pageProxy = null;
    }

    // ── Element Scanning ──

    async scanElements(forceRefresh = false): Promise<InteractiveElement[]> {
        const result = (await sendBridgeCommand("scan_elements", { forceRefresh }, 15000)) as {
            elements: Array<{
                label: number;
                x: number;
                y: number;
                tag: string;
                text: string;
                atlasId: string;
                editorType?: string;
            }>;
        };

        // Map to InteractiveElement format (no handle for Chrome mode)
        return (result.elements || []).map((e, i) => ({
            label: i + 1,
            x: e.x,
            y: e.y,
            tag: e.tag,
            text: e.text,
            atlasId: e.atlasId,
            handle: undefined, // No Playwright handles in Chrome mode
            editorType: e.editorType as InteractiveElement["editorType"],
        }));
    }

    // ── Interaction ──

    async clickAt(x: number, y: number, opts?: ClickOptions): Promise<void> {
        await sendBridgeCommand("click_at", {
            x,
            y,
            doubleClick: opts?.doubleClick || false,
            button: opts?.button || "left",
            modifiers: opts?.modifiers || [],
        });

        // Wait for whatever the click started (navigation, re-render) to settle.
        const waitMs = opts?.waitAfterMs ?? 2000;
        if (waitMs > 0) await waitBridgeReady(waitMs, 300);
    }

    async typeText(text: string, editorType?: string): Promise<void> {
        await sendBridgeCommand("type_text", { text, editorType });
    }

    async pressKey(key: string, modifiers?: string[]): Promise<void> {
        await sendBridgeCommand("keyboard", { key, modifiers, action: "press" });
    }

    async scroll(direction: "up" | "down" | "left" | "right", amount: number, elementSelector?: string): Promise<void> {
        await sendBridgeCommand("scroll", { direction, amount, selector: elementSelector });
    }

    async hover(x: number, y: number, steps = 1): Promise<void> {
        if (steps <= 1) {
            await sendBridgeCommand("hover", { x, y });
            return;
        }
        const startX = 640,
            startY = 400;
        for (let i = 1; i <= steps; i++) {
            const ix = Math.round(startX + (x - startX) * (i / steps));
            const iy = Math.round(startY + (y - startY) * (i / steps));
            await sendBridgeCommand("hover", { x: ix, y: iy });
        }
    }

    async selectOption(selector: string, values: string[]): Promise<void> {
        await sendBridgeCommand("select_option", { selector, values });
    }

    // ── Extraction ──

    async executeJS(code: string): Promise<unknown> {
        return sendBridgeCommand("execute_js", { code }, 15000);
    }

    async screenshot(opts?: { quality?: number; fullPage?: boolean }): Promise<Buffer> {
        return chromeScreenshot("jpeg", opts?.quality);
    }

    async waitForSelector(selector: string, timeoutMs = 10000): Promise<boolean> {
        try {
            await sendBridgeCommand("wait_for", { selector, timeout: timeoutMs }, timeoutMs + 1000);
            return true;
        } catch {
            return false;
        }
    }

    // ── Native input via CDP (OpenCLI nativeType + setFileInput) ──

    /** nativeType via Input.insertText — single CDP call, handles Unicode/CJK correctly.
     *  Much faster than per-character key dispatch. Focus element first via evaluate. */
    async nativeType(text: string): Promise<void> {
        // First focus the active element if needed, then insert text in one shot
        await sendBridgeCommand(
            "execute_js",
            {
                code: `(function(){const a=document.activeElement; if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)){a.focus();}})()`,
            },
            3000,
        ).catch(() => {});
        await sendBridgeCommand("cdp", { method: "Input.insertText", params: { text } }, 5000);
    }

    /** setFileInput via DOM.setFileInputFiles — Chrome reads from filesystem, no base64. */
    async setFileInput(paths: string[], selector: string): Promise<void> {
        // Get backendNodeId for the selector
        const domResult = (await sendBridgeCommand(
            "execute_js",
            {
                code: `(function(){const el=document.querySelector(${JSON.stringify(selector)});return el?Array.from(el.getAttributeNames()).reduce((a,k)=>{a[k]=el.getAttribute(k);return a;},{}):null;})()`,
            },
            5000,
        )) as Record<string, string> | null;
        if (!domResult) throw new Error(`setFileInput: element not found: ${selector}`);
        // Use CDP DOM.setFileInputFiles
        await sendBridgeCommand(
            "cdp",
            {
                method: "DOM.setFileInputFiles",
                params: { files: paths, selector },
            },
            10000,
        );
    }

    // ── Playwright-specific (not available in Chrome mode) ──

    async getPlaywrightPage(): Promise<unknown | null> {
        return null;
    }

    async getPlaywrightContext(): Promise<unknown | null> {
        return null;
    }

    // ── Get Playwright-compatible page proxy ──

    async getPageProxy(): Promise<ChromePageProxy> {
        if (!this.pageProxy) this.pageProxy = new ChromePageProxy();
        await this.pageProxy.refresh(); // the user (or a click) may have changed the tab since
        return this.pageProxy;
    }
}
