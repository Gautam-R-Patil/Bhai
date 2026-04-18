// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Chrome Extension Backend ─────────────────
// Implements BrowserBackend by proxying all operations through the
// Chrome Bridge WebSocket to the user's real Chrome browser.
// The agent interacts directly with the user's tabs — no headless browser needed.

import type { BrowserBackend, BrowserPageInfo } from "./browser-backend.js";
import type { InteractiveElement, TabInfo, ClickOptions } from "./types.js";
import { sendBridgeCommand, getActiveExtensionTab, getExtensionTabs } from "./chrome-bridge.js";

// ── ChromePageProxy ──────────────────────────
// Mimics the Playwright Page API surface so existing tool handlers
// can call page.goto(), page.evaluate(), page.mouse.click() etc.
// and the proxy transparently routes to the Chrome extension.

export class ChromePageProxy {
    private _url = "";
    private _title = "";

    constructor(url?: string, title?: string) {
        this._url = url || "";
        this._title = title || "";
    }

    url(): string {
        return this._url;
    }

    async title(): Promise<string> {
        if (this._title) return this._title;
        const tab = await getActiveExtensionTab();
        this._title = tab?.title || "";
        return this._title;
    }

    async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
        await sendBridgeCommand("navigate", { url, timeout: opts?.timeout }, opts?.timeout || 30000);
        this._url = url;
        // Wait for page to settle
        await new Promise(resolve => setTimeout(resolve, 500));
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
            code = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(", ")})`;
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
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    async waitForLoadState(_state?: string, _opts?: { timeout?: number }): Promise<void> {
        // The Chrome extension handles page load natively
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Navigation
    async goBack(): Promise<void> {
        await sendBridgeCommand("go_back", {});
    }

    async goForward(): Promise<void> {
        // Forward is not in our command set — execute via JS
        await sendBridgeCommand("execute_js", { code: "window.history.forward()" });
    }

    // Interaction proxies
    mouse = {
        click: async (x: number, y: number, opts?: { button?: string }) => {
            await sendBridgeCommand("click_at", { x, y, button: opts?.button || "left" });
        },
        dblclick: async (x: number, y: number) => {
            await sendBridgeCommand("click_at", { x, y, doubleClick: true });
        },
        move: async (x: number, y: number) => {
            await sendBridgeCommand("hover", { x, y });
        },
    };

    keyboard = {
        press: async (key: string) => {
            await sendBridgeCommand("keyboard", { key, action: "press" });
        },
        down: async (key: string) => {
            await sendBridgeCommand("keyboard", { key, action: "down" });
        },
        up: async (key: string) => {
            await sendBridgeCommand("keyboard", { key, action: "up" });
        },
        type: async (text: string) => {
            await sendBridgeCommand("type_text", { text });
        },
    };

    async screenshot(opts?: { type?: string; quality?: number; fullPage?: boolean }): Promise<Buffer> {
        const result = await sendBridgeCommand("screenshot", {
            format: opts?.type || "jpeg",
            quality: opts?.quality || 55,
        }) as { base64: string };
        return Buffer.from(result.base64, "base64");
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
        const escaped = text.replace(/'/g, "\\'");
        // Use XPath to find elements by text content
        const xpath = exact
            ? `//*[text()='${escaped}']`
            : `//*[contains(text(),'${escaped}')]`;
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
        return new ChromeLocatorProxy(`[aria-label="${text}"], label:has-text("${text}") + input, label:has-text("${text}") + select`);
    }

    async selectOption(selector: string, value: string | string[]): Promise<void> {
        const values = Array.isArray(value) ? value : [value];
        await sendBridgeCommand("select_option", { selector, values });
    }

    // Element query shorthand ($ operator)
    async $(selector: string): Promise<ChromeLocatorProxy | null> {
        const result = await sendBridgeCommand("execute_js", {
            code: `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.left + rect.width/2, y: rect.top + rect.height/2, found: true };
            })()`
        }) as { x: number; y: number; found: boolean } | null;
        if (!result || !result.found) return null;
        return new ChromeLocatorProxy(selector);
    }
}

/**
 * Proxy for Playwright's Locator API.
 * Routes element operations through the Chrome extension bridge
 * by finding elements via JS and using coordinate-based interaction.
 */
class ChromeLocatorProxy {
    private selector: string;

    constructor(selector: string) {
        this.selector = selector;
    }

    private resolveSelector(): string {
        // Handle xpath= prefix
        if (this.selector.startsWith("xpath=")) {
            return this.selector;
        }
        // Handle :has-text() pseudo-selector (not real CSS — convert to JS)
        if (this.selector.includes(":has-text(")) {
            return this.selector; // Will be handled specially in execute
        }
        return this.selector;
    }

    private async findElement(): Promise<{ x: number; y: number; found: boolean }> {
        const sel = this.resolveSelector();

        let code: string;
        if (sel.startsWith("xpath=")) {
            const xpath = sel.substring(6);
            code = `(() => {
                const result = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const el = result.singleNodeValue;
                if (!el) return { found: false, x: 0, y: 0 };
                const rect = el.getBoundingClientRect();
                return { found: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
            })()`;
        } else {
            code = `(() => {
                const el = document.querySelector(${JSON.stringify(sel)});
                if (!el) return { found: false, x: 0, y: 0 };
                const rect = el.getBoundingClientRect();
                return { found: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
            })()`;
        }

        const result = await sendBridgeCommand("execute_js", { code }, 10000) as {
            x: number; y: number; found: boolean;
        };
        return result || { found: false, x: 0, y: 0 };
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
        // Click to focus, then type
        await sendBridgeCommand("click_at", { x: el.x, y: el.y });
        await new Promise(r => setTimeout(r, 100));
        // Clear existing value first
        await sendBridgeCommand("execute_js", {
            code: `(() => {
                const el = document.querySelector(${JSON.stringify(this.selector)});
                if (el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); }
            })()`
        });
        await sendBridgeCommand("type_text", { text });
    }

    async type(text: string): Promise<void> {
        await this.fill(text);
    }

    async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
        const code = `(() => {
            const el = document.querySelector(${JSON.stringify(this.selector)});
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`;
        return await sendBridgeCommand("execute_js", { code }, 5000) as {
            x: number; y: number; width: number; height: number;
        } | null;
    }

    async textContent(): Promise<string | null> {
        const code = `(() => {
            const el = document.querySelector(${JSON.stringify(this.selector)});
            return el ? el.textContent : null;
        })()`;
        return await sendBridgeCommand("execute_js", { code }, 5000) as string | null;
    }

    async innerText(): Promise<string> {
        const code = `(() => {
            const el = document.querySelector(${JSON.stringify(this.selector)});
            return el ? el.innerText : '';
        })()`;
        return (await sendBridgeCommand("execute_js", { code }, 5000) as string) || "";
    }

    async isVisible(): Promise<boolean> {
        const code = `(() => {
            const el = document.querySelector(${JSON.stringify(this.selector)});
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        })()`;
        return (await sendBridgeCommand("execute_js", { code }, 5000) as boolean) || false;
    }

    async scrollIntoViewIfNeeded(): Promise<void> {
        await sendBridgeCommand("execute_js", {
            code: `(() => {
                const el = document.querySelector(${JSON.stringify(this.selector)});
                if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            })()`
        });
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
        throw new Error("File upload is not supported in Chrome extension mode. Switch to Playwright mode with browser_set_mode('playwright') for file uploads.");
    }

    async hover(): Promise<void> {
        const el = await this.findElement();
        if (!el.found) throw new Error(`Element not found: ${this.selector}`);
        await sendBridgeCommand("hover", { x: el.x, y: el.y });
    }

    async focus(): Promise<void> {
        await sendBridgeCommand("execute_js", {
            code: `(() => {
                const el = document.querySelector(${JSON.stringify(this.selector)});
                if (el && el.focus) el.focus();
            })()`
        });
    }

    // Chain support for .first(), .last(), .nth()
    first(): ChromeLocatorProxy {
        return new ChromeLocatorProxy(`${this.selector}:first-of-type`);
    }

    last(): ChromeLocatorProxy {
        return new ChromeLocatorProxy(`${this.selector}:last-of-type`);
    }

    nth(index: number): ChromeLocatorProxy {
        return new ChromeLocatorProxy(`${this.selector}:nth-of-type(${index + 1})`);
    }
}

// ── Chrome Extension Backend Implementation ──

export class ChromeExtensionBackend implements BrowserBackend {
    readonly mode = "chrome" as const;
    private pageProxy: ChromePageProxy | null = null;

    // ── Navigation ──

    async navigate(url: string, opts?: { newTab?: boolean; waitFor?: string; timeout?: number }): Promise<{ title: string; url: string }> {
        const timeout = opts?.timeout || 30000;

        if (opts?.newTab) {
            await sendBridgeCommand("navigate", { url, newTab: true, timeout }, timeout);
        } else {
            await sendBridgeCommand("navigate", { url, timeout }, timeout);
        }

        // Wait for page to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        if (opts?.waitFor) {
            await sendBridgeCommand("wait_for", {
                selector: opts.waitFor,
                timeout: 10000,
            }, 12000).catch(() => { /* non-fatal */ });
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
        // Chrome handles page loading natively — give it a moment to stabilize
        await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 800)));
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
        return tabs.map(t => ({
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
        const result = await sendBridgeCommand("scan_elements", { forceRefresh }, 15000) as {
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

        // Wait after click (like Playwright mode)
        const waitMs = opts?.waitAfterMs ?? 1000;
        if (waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
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

    async hover(x: number, y: number): Promise<void> {
        await sendBridgeCommand("hover", { x, y });
    }

    async selectOption(selector: string, values: string[]): Promise<void> {
        await sendBridgeCommand("select_option", { selector, values });
    }

    // ── Extraction ──

    async executeJS(code: string): Promise<unknown> {
        return sendBridgeCommand("execute_js", { code }, 15000);
    }

    async screenshot(opts?: { quality?: number; fullPage?: boolean }): Promise<Buffer> {
        const result = await sendBridgeCommand("screenshot", {
            format: "jpeg",
            quality: opts?.quality || 55,
        }) as { base64: string };
        return Buffer.from(result.base64, "base64");
    }

    async waitForSelector(selector: string, timeoutMs = 10000): Promise<boolean> {
        try {
            await sendBridgeCommand("wait_for", { selector, timeout: timeoutMs }, timeoutMs + 1000);
            return true;
        } catch {
            return false;
        }
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
        if (!this.pageProxy) {
            const tab = await getActiveExtensionTab();
            this.pageProxy = new ChromePageProxy(tab?.url || "", tab?.title || "");
        }
        return this.pageProxy;
    }
}
