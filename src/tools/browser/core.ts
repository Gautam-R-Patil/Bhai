// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Core Infrastructure ───────────────
// Shared browser state, element scanning, and utilities

import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type {
    PlaywrightModule,
    BrowserContext,
    Page,
    InteractiveElement,
    ElementCache,
    PageScanResult
} from "./types.js";
import { getCurrentMode, getActiveBackend } from "./browser-backend.js";
import { ChromePageProxy, ChromeExtensionBackend } from "./chrome-backend.js";
import { runOCR } from "../../models/local-ocr.js";

// ── Browser State ─────────────────────────────

let pw: PlaywrightModule = null;
let browserContext: BrowserContext = null;

const BROWSER_PROFILE_DIR = path.resolve("data", "browser-profile");

// Global element map from last scan (label → Handle mapping)
let lastElementMap: InteractiveElement[] = [];

// ── Smart Element Cache ──────────────────────
let elementCache: ElementCache | null = null;
const CACHE_TTL_MS = 6000; // Cache valid for 6 seconds

function shouldUseCachedElements(currentUrl: string): boolean {
    if (!elementCache) return false;
    if (elementCache.url !== currentUrl) return false;
    if (Date.now() - elementCache.timestamp > CACHE_TTL_MS) return false;
    return true;
}

function cacheElements(url: string, elements: InteractiveElement[]): void {
    elementCache = { url, timestamp: Date.now(), elements };
}

export function invalidateCache(): void {
    elementCache = null;
}

// ── Active page tracker ───────────────────────
let activePageIndex = 0;

export function setActivePageIndex(idx: number): void {
    activePageIndex = idx;
}

export function getActivePageIndex(): number {
    return activePageIndex;
}

// ── Element Map Access ────────────────────────

export function getLastElementMap(): InteractiveElement[] {
    return lastElementMap;
}

export function setLastElementMap(elements: InteractiveElement[]): void {
    lastElementMap = elements;
}

// Helper: Generate the condensed readable text list from the current element map
// Rust-based element compressor (lazy-loaded, falls back to plain format)
let _nativeCompressElements: ((els: unknown[], maxText?: number | null, maxEls?: number | null) => string) | null = null;
let _nativeGetStealthScript: ((seed: number) => string) | null = null;
try {
    const { createRequire } = await import("node:module");
    const _req = createRequire(import.meta.url);
    const _nm = _req(path.resolve("native", "index.js")) as Record<string, unknown>;
    if (typeof _nm.compressElementsForLlm === "function") {
        _nativeCompressElements = _nm.compressElementsForLlm as ((els: unknown[], maxText?: number | null, maxEls?: number | null) => string);
    }
    if (typeof _nm.getStealthInitScript === "function") {
        _nativeGetStealthScript = _nm.getStealthInitScript as ((seed: number) => string);
    }
} catch { /* native unavailable — JS fallbacks used */ }

export function buildElementsText(): string {
    if (lastElementMap.length === 0) return "No interactive elements.";
    // Use Rust compressor: deduplicates, groups repeats, truncates — ~30-50% fewer tokens
    if (_nativeCompressElements) {
        try {
            const input = lastElementMap.map(e => ({
                label: e.label,
                tag: e.tag,
                text: e.text ?? "",
                x: e.x,
                y: e.y,
                width: (e as InteractiveElement & { width?: number }).width ?? 0,
                height: (e as InteractiveElement & { height?: number }).height ?? 0,
                isOcr: e.isOCRElement ?? false,
                editorType: e.editorType ?? null,
            }));
            return _nativeCompressElements(input, 40, 80);
        } catch { /* fall through */ }
    }
    // JS fallback — use OpenCLI [N]<tag>text format
    return lastElementMap.map(e => {
        if (e.editorType) return `[${e.label}]<code-editor:${e.editorType}>`;
        if (e.isOCRElement) return `[${e.label}]<ocr>${e.text}`;
        const t = (e.text ?? "").substring(0, 40);
        return t ? `[${e.label}]<${e.tag}>${t}` : `[${e.label}]<${e.tag}>`;
    }).join('\n');
}

// ── Browser Initialization ────────────────────

export async function getBrowser(): Promise<BrowserContext> {
    // In Chrome extension mode, there's no Playwright context to return.
    // Tools that call getBrowser() for context.pages() will get null back.
    // The getActivePage() and getInteractiveElements() functions handle chrome mode directly.
    if (getCurrentMode() === "chrome") {
        // Return a minimal stub that won't crash callers checking pages()
        return { pages: () => [], newPage: async () => await getActivePage() } as unknown as BrowserContext;
    }

    if (!browserContext) {
        if (!pw) {
            pw = await import("playwright");
        }
        // Ensure profile directory exists
        if (!fs.existsSync(BROWSER_PROFILE_DIR)) {
            fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
        }
        // Rust-generated realistic user-agent (session-stable, varies daily)
        let ua = process.platform === "win32"
            ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        try {
            const { createRequire } = await import("node:module");
            const req = createRequire(import.meta.url);
            const nm = req(path.resolve("native", "index.js")) as Record<string, unknown>;
            if (typeof nm.getStealthUserAgent === "function") {
                const fn = nm.getStealthUserAgent as (platform: string, seed: number) => string;
                ua = fn(process.platform, Math.floor(Date.now() / 86_400_000) % 65536);
            }
        } catch { /* use fallback UA above */ }

        // Stealth args: remove bot fingerprints without bypassCSP (which breaks Playwright internals)
        const stealthArgs = [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled", // removes navigator.webdriver
            "--disable-infobars",
            "--disable-notifications",               // suppress permission prompts
            "--disable-dev-shm-usage",               // stability on Linux/Windows
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-ipc-flooding-protection",
            "--password-store=basic",
            "--use-mock-keychain",
            "--lang=en-US,en",
            "--accept-lang=en-US,en;q=0.9",
        ];

        // Persistent context — keeps cookies, logins, history across sessions
        browserContext = await pw.chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
            headless: false,
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1, // consistent across Retina/non-Retina on all platforms
            userAgent: ua,
            locale: "en-US",
            timezoneId: "America/New_York",
            // Deny all permission prompts upfront — prevents OS-level dialogs blocking automation
            permissions: [],
            args: stealthArgs,
            serviceWorkers: "block", // consistent behavior across SPAs
            // bypassCSP intentionally omitted — breaks Playwright internal eval helpers (R4, _iM, iz)
        });

        // Inject stealth patches at document start.
        // Script is generated by Rust (compiled into binary) — not visible in
        // TypeScript source or in unpacked Electron app bundles.
        // Variable names are randomized per session via session_seed.
        const sessionSeed = Math.floor(Date.now() / 3600_000) % 65536; // hourly rotation
        const stealthScript = _nativeGetStealthScript
            ? _nativeGetStealthScript(sessionSeed)
            : `(function(){try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch(_){}})()`;
        await browserContext.addInitScript(stealthScript);

        // Block unnecessary resources for faster page loads.
        // Images, fonts, and analytics/tracking scripts are typically not needed for agent tasks.
        // This can reduce page load time by 40-60%.
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const abort = (route: any) => route.abort();
            await browserContext.route("**/*.{woff,woff2,ttf,otf,eot}", abort);
            await browserContext.route("**/{analytics,tracking,telemetry,pixel,beacon}*", abort);
            await browserContext.route("**/google-analytics.com/**", abort);
            await browserContext.route("**/googletagmanager.com/**", abort);
            await browserContext.route("**/googlesyndication.com/**", abort);
            await browserContext.route("**/googleadservices.com/**", abort);
            await browserContext.route("**/facebook.net/**", abort);
            await browserContext.route("**/doubleclick.net/**", abort);
            await browserContext.route("**/hotjar.com/**", abort);
            await browserContext.route("**/mixpanel.com/**", abort);
            await browserContext.route("**/segment.io/**", abort);
            await browserContext.route("**/amplitude.com/**", abort);
            console.log("  🚫 Browser: blocked fonts, analytics, ads, tracking for faster page loads");
        } catch { /* route setup non-fatal */ }

        // Attach popup/overlay guard — auto-dismisses cookie banners and modals on every page
        try {
            const { attachPopupGuard } = await import("./popup-guard.js");
            attachPopupGuard(browserContext);
            console.log("  🛡️  Popup guard: cookie banners + modal auto-dismiss enabled");
        } catch { /* non-fatal */ }
    }
    return browserContext;
}

// ── Get active page ───────────────────────────
// Returns a Playwright Page in playwright mode, or a ChromePageProxy in chrome mode.
// Both support the same API surface used by the tool handlers (goto, evaluate, mouse, keyboard, etc.)

export async function getActivePage(): Promise<Page> {
    // Chrome extension mode: return a proxy that routes to the real Chrome tab
    if (getCurrentMode() === "chrome") {
        const backend = await getActiveBackend() as ChromeExtensionBackend;
        return await backend.getPageProxy() as unknown as Page;
    }

    // Playwright mode (original behavior)
    const context = await getBrowser();
    const pages = context.pages();
    if (pages.length === 0) return await context.newPage();
    // Clamp index in case tabs were closed
    const idx = Math.min(activePageIndex, pages.length - 1);
    return pages[idx];
}

// ── Form State Snapshot (OpenCLI getFormStateJs) ─────────────────────────────
// Returns all form field values as { name/id → value } map in one evaluate() call.
// Handles checkbox/radio as boolean, select-multiple as array.
export const GET_FORM_STATE_JS = `() => {
    const out = {};
    const fields = document.querySelectorAll('input,select,textarea');
    for (const el of fields) {
        const key = el.id || el.name || el.getAttribute('aria-label') || null;
        if (!key) continue;
        if (el.type === 'checkbox' || el.type === 'radio') {
            out[key] = el.checked;
        } else if (el.tagName === 'SELECT' && el.multiple) {
            out[key] = Array.from(el.selectedOptions).map(o => o.value);
        } else {
            out[key] = el.value;
        }
    }
    return out;
}`;

// ── Scroll to ref (OpenCLI scrollToRefJs) ────────────────────────────────────
// Scroll a data-atlas-id (or CSS selector) into view with instant behavior.
export const SCROLL_TO_ELEMENT_JS = `(selector) => {
    const el = document.querySelector('[data-atlas-id="' + selector + '"]')
             || document.querySelector(selector);
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    return !!el;
}`;

// ── AutoScroll with DOM mutation settle (OpenCLI autoScrollJs) ───────────────
// Scrolls page N times with settle detection between each scroll.
// Resolves after each scroll when no DOM mutations for QUIET_MS.
export const AUTO_SCROLL_JS = `(times, delayMs, quietMs) => {
    return new Promise(async (resolve) => {
        for (let i = 0; i < (times || 3); i++) {
            window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
            await new Promise(r => {
                let timer = setTimeout(r, quietMs || 800);
                const obs = new MutationObserver(() => {
                    clearTimeout(timer);
                    timer = setTimeout(() => { obs.disconnect(); r(); }, quietMs || 800);
                });
                obs.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => { obs.disconnect(); r(); }, delayMs || 2000);
            });
        }
        resolve(true);
    });
}`;

// ── Network requests via Performance API (OpenCLI networkRequestsJs) ─────────
// Returns all network requests made by the page without CDP Network domain.
// Works in both Playwright and Chrome extension modes.
export const NETWORK_REQUESTS_JS = `(includeStatic) => {
    const staticExts = /\\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|css)$/i;
    return performance.getEntriesByType('resource').filter(e => {
        if (!includeStatic && staticExts.test(e.name)) return false;
        return true;
    }).map(e => ({
        url: e.name,
        type: e.initiatorType,
        duration: Math.round(e.duration),
        transferSize: e.transferSize || 0,
        status: e.responseStatus || 0,
    }));
}`;

// ── Visual Indicators (Playwright / Headless) ────────────────────────────────
// Injected into the page on each interaction to give the user clear, polished
// feedback about what the browser agent is doing.

// Click: crosshair dot + expanding ring + ripple. Color-coded by type.
export const CLICK_INDICATOR_JS = `
({x, y, type}) => {
    const colors = {
        click: ['rgba(59,130,246,0.15)', 'rgba(59,130,246,0.9)', '#3b82f6'],
        right:  ['rgba(239,68,68,0.15)',  'rgba(239,68,68,0.9)',  '#ef4444'],
        hold:   ['rgba(34,197,94,0.15)',  'rgba(34,197,94,0.9)',  '#22c55e'],
        double: ['rgba(168,85,247,0.15)', 'rgba(168,85,247,0.9)', '#a855f7'],
    };
    const [bg, border, solid] = colors[type] || colors.click;

    // Outer ripple ring
    const ring = document.createElement('div');
    ring.style.cssText = \`position:fixed;left:\${x-24}px;top:\${y-24}px;width:48px;height:48px;
        border-radius:50%;border:2px solid \${border};pointer-events:none;z-index:2147483646;
        animation:atlasRipple 0.6s cubic-bezier(.4,0,.2,1) forwards;\`;

    // Center dot
    const dot = document.createElement('div');
    dot.style.cssText = \`position:fixed;left:\${x-4}px;top:\${y-4}px;width:8px;height:8px;
        border-radius:50%;background:\${solid};pointer-events:none;z-index:2147483647;
        animation:atlasDot 0.4s cubic-bezier(.4,0,.2,1) forwards;\`;

    // Crosshair lines (20px each side)
    const mkLine = (horiz) => {
        const l = document.createElement('div');
        const s = horiz
            ? \`left:\${x-12}px;top:\${y-1}px;width:24px;height:2px;\`
            : \`left:\${x-1}px;top:\${y-12}px;width:2px;height:24px;\`;
        l.style.cssText = \`position:fixed;\${s}background:\${solid};opacity:0.7;pointer-events:none;
            z-index:2147483647;animation:atlasFade 0.5s ease-out forwards;\`;
        return l;
    };

    // Inject keyframes once
    if (!document.getElementById('__atlasKF')) {
        const st = document.createElement('style');
        st.id = '__atlasKF';
        st.textContent = \`
            @keyframes atlasRipple{0%{transform:scale(.3);opacity:1}100%{transform:scale(2.2);opacity:0}}
            @keyframes atlasDot{0%{transform:scale(1.8);opacity:1}100%{transform:scale(.6);opacity:0}}
            @keyframes atlasFade{0%{opacity:.8}100%{opacity:0}}
        \`;
        document.head.appendChild(st);
    }

    [ring, dot, mkLine(true), mkLine(false)].forEach(el => document.body.appendChild(el));
    setTimeout(() => [ring, dot].forEach(el => el.remove()), 650);
    setTimeout(() => document.querySelectorAll('[style*="atlasFade"]').forEach(e => e.remove()), 550);
};
`;

// Scroll: directional arrow animation at the scroll position
export const SCROLL_INDICATOR_JS = `
({direction, amount, x, y}) => {
    const arrows = {up:'↑', down:'↓', left:'←', right:'→'};
    const arrow = arrows[direction] || '↕';
    const el = document.createElement('div');
    el.textContent = arrow + ' ' + Math.abs(amount) + 'px';
    el.style.cssText = \`
        position:fixed;left:\${Math.min(x||640, window.innerWidth-120)}px;
        top:\${Math.min(y||400, window.innerHeight-60)}px;
        padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;
        background:rgba(15,23,42,0.85);color:#94a3b8;border:1px solid #334155;
        pointer-events:none;z-index:2147483647;backdrop-filter:blur(4px);
        animation:atlasScrollFade 0.7s ease-out forwards;
    \`;
    if (!document.getElementById('__atlasKF')) {
        const st = document.createElement('style');
        st.id = '__atlasKF';
        st.textContent = '@keyframes atlasRipple{0%{transform:scale(.3);opacity:1}100%{transform:scale(2.2);opacity:0}}@keyframes atlasDot{0%{transform:scale(1.8);opacity:1}100%{transform:scale(.6);opacity:0}}@keyframes atlasFade{0%{opacity:.8}100%{opacity:0}}';
        document.head.appendChild(st);
    }
    const kf = document.getElementById('__atlasKF');
    if (!kf.textContent.includes('atlasScrollFade')) {
        kf.textContent += '@keyframes atlasScrollFade{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(' + (direction==='up'?-1:1)*16 + 'px)}}';
    }
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 750);
};
`;

// ATLAS action HUD: floating pill at top-right showing current action.
// Persists while action runs, fades out on completion.
export const ATLAS_HUD_JS = `
({label, done}) => {
    const ID = '__atlasHUD';
    let hud = document.getElementById(ID);
    if (done) {
        if (hud) { hud.style.opacity = '0'; setTimeout(() => hud?.remove(), 300); }
        return;
    }
    if (!hud) {
        hud = document.createElement('div');
        hud.id = ID;
        // Icon + text row
        hud.innerHTML = '<span id="__atlasHUDdot" style="width:6px;height:6px;border-radius:50%;background:#3b82f6;display:inline-block;animation:atlasPulse 1.2s ease-in-out infinite;flex-shrink:0"></span>' +
                        '<span id="__atlasHUDtxt" style="margin-left:7px;font-size:11px;font-weight:500;color:#e2e8f0;letter-spacing:0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px"></span>';
        hud.style.cssText = \`
            position:fixed;top:10px;right:10px;display:flex;align-items:center;
            padding:6px 12px;border-radius:20px;
            background:rgba(15,23,42,0.9);border:1px solid #1e3a5f;
            backdrop-filter:blur(8px);pointer-events:none;z-index:2147483647;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            box-shadow:0 4px 20px rgba(0,0,0,0.4);
            transition:opacity 0.3s ease;opacity:0;
        \`;
        const kf = document.getElementById('__atlasKF');
        const pp = '@keyframes atlasPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}';
        if (kf) { if(!kf.textContent.includes('atlasPulse')) kf.textContent += pp; }
        else {
            const s = document.createElement('style');
            s.id='__atlasKF'; s.textContent = pp;
            document.head.appendChild(s);
        }
        document.body.appendChild(hud);
        requestAnimationFrame(() => { hud.style.opacity = '1'; });
    }
    const txt = document.getElementById('__atlasHUDtxt');
    if (txt) txt.textContent = label;
};
`;

// ── Smart Wait: SPA-aware page readiness ─────────────────────────────────────
// Avoids networkidle (never fires on SPAs with background analytics/polling).
// Strategy: domcontentloaded → framework hydration signal → DOM stability.
export async function waitForPageReady(page: Page, timeoutMs = 4000): Promise<void> {
    if (getCurrentMode() === "chrome") {
        await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 600)));
        return;
    }

    const deadline = Date.now() + timeoutMs;

    // Step 1: domcontentloaded — HTML parsed, synchronous scripts done
    try {
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 3000) });
    } catch { /* continue even on timeout */ }

    if (Date.now() >= deadline) return;

    // Step 2: Framework hydration signal — reads existing globals, no side effects
    try {
        await page.waitForFunction(
            () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;
                const isNext  = typeof w.__NEXT_DATA__ !== "undefined";
                const isVue   = typeof w.__vue_app__ !== "undefined";
                const isNuxt  = typeof w.__NUXT__ !== "undefined";
                const root    = document.getElementById("root") || document.getElementById("__next") || document.getElementById("app");
                const isReact = root ? Object.keys(root).some(k => k.startsWith("__reactFiber")) : false;
                if (isNext || isVue || isNuxt || isReact) return document.readyState === "complete";
                return document.readyState !== "loading";
            },
            { timeout: Math.min(deadline - Date.now(), 2500), polling: 150 }
        );
    } catch { /* framework not detected or timed out — continue */ }

    if (Date.now() >= deadline) return;

    // Step 3: DOM stability (OpenCLI waitForDomStableJs pattern)
    // MutationObserver resets a quiet-timer on every mutation.
    // Resolves when quiet for QUIET_MS or after MAX_MS cap.
    // More reliable than the setInterval approach — no polling, immediate resolution.
    const stabilityBudget = Math.min(deadline - Date.now(), 2000);
    if (stabilityBudget > 600) {
        const QUIET_MS = Math.min(350, stabilityBudget / 3);
        try {
            await page.evaluate((maxMs: number, quietMs: number) => {
                return new Promise<string>((resolve) => {
                    let timer: ReturnType<typeof setTimeout> | null = null;
                    const cap = setTimeout(() => { obs.disconnect(); resolve('capped'); }, maxMs);
                    const obs = new MutationObserver(() => {
                        if (timer) clearTimeout(timer);
                        timer = setTimeout(() => { clearTimeout(cap); obs.disconnect(); resolve('quiet'); }, quietMs);
                    });
                    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
                    // Start quiet timer immediately — resolve if nothing changes
                    timer = setTimeout(() => { clearTimeout(cap); obs.disconnect(); resolve('quiet'); }, quietMs);
                });
            }, stabilityBudget, QUIET_MS).catch(() => {}); // non-fatal
        } catch { /* stability budget exhausted — page is usable */ }
    }
}

// ── Retry Helper for flaky operations ──────────
export async function withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 2,
    delayMs = 300
): Promise<T> {
    let lastError: Error | null = null;
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err as Error;
            if (i < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
}

// ── Interactive Elements Scan JS ────────────────
// The JS function injected into EACH frame to find interactive elements.
// Returns raw candidates with coordinates relative to the frame's viewport.

export const SCAN_FRAME_JS = () => {
    const els = Array.from(document.querySelectorAll('*'));

    // ── UI Modal Context Guard ──
    // Only treat modals as active if they're actually visible (not hidden off-screen or display:none)
    const activeModals = els.filter(el => {
        const role = el.getAttribute('role');
        if (role !== 'dialog' && role !== 'menu' && role !== 'alertdialog' && role !== 'listbox') return false;
        // Check CSS visibility — hidden modals (dropdowns, drawers) shouldn't filter out the page
        try {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        } catch { return false; }
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return false;
        return true;
    });

    let activeModalRect: DOMRect | null = null;
    if (activeModals.length > 0) {
        const activeModal = activeModals[activeModals.length - 1];
        activeModalRect = activeModal.getBoundingClientRect();
    }

    // fingerprint = stable identity string for 3-tier element resolution (OpenCLI pattern).
    // Format: "tag|id|role|trimmedText|ariaLabel" — survives SPA re-renders.
    const candidateMap: Array<{ index: number; x: number; y: number; width: number; height: number; tag: string; text: string; score: number; editorType?: string; fingerprint?: string; hash?: number }> = [];
    const seenCoords = new Set<string>();

    for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLElement;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const className = el.className;
        const hasOnClick = el.hasAttribute('onclick');

        const isNativeInt = ['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag);
        const isRoleInt = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'listbox', 'treeitem'].includes(role || '');
        const isContentEditable = el.hasAttribute('contenteditable');
        const hasTabIndex = el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1';
        const hasAriaPopup = el.hasAttribute('aria-haspopup');
        const hasAriaExpanded = el.hasAttribute('aria-expanded');
        const hasAriaControls = el.hasAttribute('aria-controls');

        let hasCursorPointer = false;
        let hasButtonClass = false;

        if (!isNativeInt && !isRoleInt && !hasOnClick && !isContentEditable && !hasAriaPopup && !hasAriaExpanded) {
            if (typeof className === 'string') {
                const lowerClass = className.toLowerCase();
                if (lowerClass.includes('btn') || lowerClass.includes('button') || lowerClass.includes('dropdown')) {
                    hasButtonClass = true;
                }
            }
            try {
                const style = window.getComputedStyle(el);
                if (style.cursor === 'pointer') hasCursorPointer = true;
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            } catch { continue; }
        }

        // ── Framework listener detection (OpenCLI dom-snapshot.ts) ──────────
        // React/Vue/Angular attach event listeners as non-enumerable properties.
        // Check for framework fiber keys to mark framework-wired elements interactive
        // even when they have no native onclick or cursor:pointer.
        let hasFrameworkListener = false;
        if (!(isNativeInt || isRoleInt || hasOnClick || isContentEditable || hasTabIndex || hasCursorPointer || hasButtonClass || hasAriaPopup || hasAriaExpanded || hasAriaControls)) {
            for (const k of Object.keys(el)) {
                if (k.startsWith('__reactFiber') || k.startsWith('__reactEventHandlers') ||
                    k.startsWith('__vue') || k.startsWith('ng-reflect') ||
                    k.startsWith('_nghost') || k.startsWith('_ngcontent')) {
                    hasFrameworkListener = true;
                    break;
                }
            }
        }

        if (!(isNativeInt || isRoleInt || hasOnClick || isContentEditable || hasTabIndex || hasCursorPointer || hasButtonClass || hasAriaPopup || hasAriaExpanded || hasAriaControls || hasFrameworkListener)) {
            continue;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        // Check if element is inside a scrollable container — don't filter by window viewport alone
        const isInScrollableContainer = (() => {
            let parent = el.parentElement;
            while (parent && parent !== document.documentElement) {
                const ps = window.getComputedStyle(parent);
                if ((ps.overflowY === 'auto' || ps.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
                    return true;
                }
                parent = parent.parentElement;
            }
            return false;
        })();
        if (!isInScrollableContainer) {
            // Allow elements up to 2x viewport height for pages that render below the fold
            if (rect.top > window.innerHeight * 2 || rect.bottom < -window.innerHeight) continue;
            if (rect.left > window.innerWidth * 2 || rect.right < -window.innerWidth) continue;
        }

        // ── Paint-order occlusion detection (OpenCLI step 7) ────────────────
        // elementFromPoint samples center — if another element is in front with
        // solid background (opacity > 0.5 and non-transparent BG), the element
        // is behind an overlay and should be deprioritized (not removed, just lower score).
        let isOccluded = false;
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);
        if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
            try {
                const topEl = document.elementFromPoint(cx, cy);
                if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
                    const tcs = window.getComputedStyle(topEl);
                    const tOpacity = parseFloat(tcs.opacity || '1');
                    const tBg = tcs.backgroundColor;
                    if (tOpacity >= 0.5 && tBg !== 'rgba(0, 0, 0, 0)' && tBg !== 'transparent') {
                        isOccluded = true;
                    }
                }
            } catch { /* elementFromPoint can throw in iframes */ }
        }

        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);

        if (activeModalRect) {
            if (x < activeModalRect.left || x > activeModalRect.right ||
                y < activeModalRect.top || y > activeModalRect.bottom) {
                continue;
            }
        }

        const coordKey = `${x},${y}`;
        if (seenCoords.has(coordKey)) continue;
        seenCoords.add(coordKey);

        // ── Compound form enrichment (inspired by OpenCLI dom-snapshot.ts) ──
        // For input/select/textarea, build rich metadata text so the LLM
        // understands the field type, label, current value, and available options
        // without needing to inspect the form manually.
        let text = '';

        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const inputEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            const inputType = (inputEl as HTMLInputElement).type || 'text';

            // Resolve the accessible label in priority order:
            // 1. aria-label / aria-labelledby  2. <label for=id>  3. placeholder  4. name
            let labelText = el.getAttribute('aria-label') || '';
            if (!labelText && el.id) {
                const labelEl = document.querySelector(`label[for="${el.id}"]`);
                if (labelEl) labelText = (labelEl as HTMLElement).innerText?.trim() || '';
            }
            if (!labelText) {
                // Check if directly wrapped in a <label>
                const parentLabel = el.closest('label');
                if (parentLabel) {
                    labelText = (parentLabel as HTMLElement).innerText?.replace(/\n/g, ' ').trim().substring(0, 30) || '';
                }
            }
            const placeholder = (inputEl as HTMLInputElement).placeholder || '';
            const currentVal  = (inputEl as HTMLInputElement).value?.substring(0, 30) || '';
            const ariaLblBy   = el.getAttribute('aria-labelledby');
            if (!labelText && ariaLblBy) {
                const lbEl = document.getElementById(ariaLblBy);
                if (lbEl) labelText = (lbEl as HTMLElement).innerText?.trim() || '';
            }

            if (tag === 'select') {
                // OpenCLI: list all options (up to 20) so agent can pick the right one
                const selectEl = el as HTMLSelectElement;
                const opts = Array.from(selectEl.options).slice(0, 20).map(o => o.text.trim()).filter(Boolean);
                const selectedText = selectEl.options[selectEl.selectedIndex]?.text.trim() || '';
                let t = labelText || placeholder || el.getAttribute('name') || 'select';
                if (selectedText) t += ` value=${selectedText}`;
                if (opts.length > 0) t += ` options=[${opts.join(', ')}]`;
                text = t.substring(0, 80);
            } else if (inputType === 'date' || inputType === 'datetime-local' || inputType === 'month' || inputType === 'week' || inputType === 'time') {
                // Date inputs: expose format hint and constraints
                let t = labelText || placeholder || el.getAttribute('name') || inputType;
                const min = (el as HTMLInputElement).min;
                const max = (el as HTMLInputElement).max;
                const fmt = inputType === 'date' ? 'YYYY-MM-DD' : inputType === 'time' ? 'HH:MM' : inputType;
                t += ` format=${fmt}`;
                if (min) t += ` min=${min}`;
                if (max) t += ` max=${max}`;
                if (currentVal) t += ` value=${currentVal}`;
                text = t.substring(0, 80);
            } else if (inputType === 'checkbox' || inputType === 'radio') {
                const checked = (el as HTMLInputElement).checked;
                const lbl = labelText || el.getAttribute('value') || placeholder || el.getAttribute('name') || inputType;
                text = `${lbl.substring(0, 30)} [${checked ? '✓' : ' '}]`;
            } else if (inputType === 'file') {
                const accept = (el as HTMLInputElement).accept || '';
                const multiple = (el as HTMLInputElement).multiple;
                text = `${labelText || 'file upload'}${accept ? ` accept=${accept}` : ''}${multiple ? ' multiple' : ''}`.substring(0, 60);
            } else {
                // Text, email, tel, number, search, password, url, textarea
                const displayType = inputType !== 'text' ? `[${inputType}]` : '';
                let t = `${displayType}${labelText || placeholder || el.getAttribute('name') || ''}`;
                if (currentVal && inputType !== 'password') t += ` value=${currentVal}`;
                text = t.substring(0, 60);
            }
            // Tag enrichment: input[type] for non-text inputs in the tag field
            if (tag === 'input' && inputType !== 'text' && inputType !== 'submit' && inputType !== 'button') {
                // Handled by the text prefix above; tag stays as 'input'
            }
        } else {
            // Non-form elements: use innerText / aria-label as before
            text = (el as HTMLElement).innerText?.replace(/\n/g, ' ').substring(0, 40)
                || el.getAttribute('aria-label')
                || el.getAttribute('title')
                || '';
        }

        let score = 0;
        if (isNativeInt || isRoleInt) score += 10;
        if (hasAriaPopup || hasAriaExpanded) score += 8;
        if (text.trim().length > 0) score += 5;
        if (hasCursorPointer) score += 3;
        if (hasButtonClass) score += 2;
        if (hasFrameworkListener) score += 4;
        if (isOccluded) score -= 6;   // deprioritize occluded elements (don't remove)

        // DJB2 hash for incremental diff marking (OpenCLI dom-snapshot.ts step 13)
        // New elements (not in previous scan) get * prefix in output
        const fpStr = tag + '|' + (el.id||'') + '|' + (typeof className==='string'?className.slice(0,50):'') + '|' + text.trim().slice(0,40);
        let djb2 = 5381;
        for (let ci = 0; ci < fpStr.length; ci++) djb2 = ((djb2 * 33) + fpStr.charCodeAt(ci)) >>> 0;

        // Stable fingerprint for three-tier resolution (OpenCLI innovation)
        const fp = [
            tag,
            el.id || '',
            role || '',
            text.trim().substring(0, 30),
            el.getAttribute('aria-label') || '',
            el.getAttribute('data-testid') || '',
        ].join('|');

        candidateMap.push({ index: i, x, y, width: rect.width, height: rect.height, tag, text: text.trim(), score, fingerprint: fp, hash: djb2 });
    }

    // ── Shadow DOM traversal ──
    for (let si = 0; si < els.length; si++) {
        const shadowHost = els[si] as HTMLElement;
        if (!shadowHost.shadowRoot) continue;
        const shadowEls = Array.from(shadowHost.shadowRoot.querySelectorAll('*'));
        for (const sel of shadowEls) {
            const sTag = (sel as HTMLElement).tagName?.toLowerCase() || '';
            const sRole = sel.getAttribute?.('role') || '';
            const sIsInt = ['a', 'button', 'input', 'textarea', 'select'].includes(sTag) ||
                          ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio'].includes(sRole || '') ||
                          sel.hasAttribute?.('contenteditable');
            if (!sIsInt) continue;
            const sRect = sel.getBoundingClientRect();
            if (sRect.width < 5 || sRect.height < 5) continue;
            const sx = Math.round(sRect.left + sRect.width / 2);
            const sy = Math.round(sRect.top + sRect.height / 2);
            const sKey = `${sx},${sy}`;
            if (seenCoords.has(sKey)) continue;
            seenCoords.add(sKey);
            const sText = (sel as HTMLElement).innerText?.replace(/\n/g, ' ').substring(0, 40) ||
                          sel.getAttribute?.('aria-label') || '';
            candidateMap.push({ index: -1, x: sx, y: sy, width: sRect.width, height: sRect.height, tag: sTag, text: sText.trim(), score: 10 });
        }
    }

    // ── Editor Detection ──
    const editorDetections: typeof candidateMap = [];
    const edTs = Date.now();

    // Monaco
    document.querySelectorAll('.monaco-editor').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-monaco-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'code-editor', text: 'Code Editor (Monaco)', score: 25, editorType: 'monaco' });
    });
    // CodeMirror 6
    document.querySelectorAll('.cm-editor').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-cm6-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'code-editor', text: 'Code Editor (CodeMirror)', score: 25, editorType: 'codemirror6' });
    });
    // CodeMirror 5
    document.querySelectorAll('.CodeMirror').forEach((el, i) => {
        if ((el as HTMLElement).closest('.cm-editor')) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-cm5-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'code-editor', text: 'Code Editor (CodeMirror)', score: 25, editorType: 'codemirror5' });
    });
    // Ace
    document.querySelectorAll('.ace_editor').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-ace-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'code-editor', text: 'Code Editor (Ace)', score: 25, editorType: 'ace' });
    });
    // Quill
    document.querySelectorAll('.ql-editor[contenteditable]').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-quill-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'rich-editor', text: 'Rich Text Editor (Quill)', score: 25, editorType: 'quill' });
    });
    // TinyMCE
    document.querySelectorAll('.tox-tinymce').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-tinymce-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'rich-editor', text: 'Rich Text Editor (TinyMCE)', score: 25, editorType: 'tinymce' });
    });
    // ProseMirror / Tiptap
    document.querySelectorAll('.ProseMirror[contenteditable]').forEach((el, i) => {
        const isTiptap = !!(el as HTMLElement).closest('.tiptap') || el.classList.contains('tiptap');
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const type = isTiptap ? 'tiptap' : 'prosemirror';
        const eid = `atlas-editor-${type}-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'rich-editor', text: `Rich Text Editor (${isTiptap ? 'Tiptap' : 'ProseMirror'})`, score: 25, editorType: type });
    });
    // Slate
    document.querySelectorAll('[data-slate-editor]').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-slate-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'rich-editor', text: 'Rich Text Editor (Slate)', score: 25, editorType: 'slate' });
    });
    // Draft.js
    document.querySelectorAll('.DraftEditor-root').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-draftjs-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, tag: 'rich-editor', text: 'Rich Text Editor (Draft.js)', score: 25, editorType: 'draftjs' });
    });

    // Merge: editors first, then deduplicate by coords
    if (editorDetections.length > 0) {
        const editorCoords = new Set(editorDetections.map(e => `${e.x},${e.y}`));
        const filtered = candidateMap.filter(c => !editorCoords.has(`${c.x},${c.y}`));
        candidateMap.length = 0;
        candidateMap.push(...editorDetections, ...filtered);
    }

    candidateMap.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (Math.abs(b.y - a.y) > 5) return a.y - b.y;
        return a.x - b.x;
    });

    // Tag them in the DOM and return metadata.
    // Cap at 150 elements — more than enough for any page, saves token budget.
    const finalMap = candidateMap.slice(0, 150).map((c, i) => {
        const id = `atlas-el-${Date.now()}-${i}`;
        if (c.index >= 0) {
            const el = els[c.index] as HTMLElement;
            el.setAttribute('data-atlas-id', id);
        }
        return {
            label: -1, // Labels assigned AFTER merging across frames
            x: c.x,
            y: c.y,
            tag: c.tag,
            text: c.text,
            score: c.score,
            atlasId: id,
            editorType: c.editorType
        };
    });

    return finalMap;
};

// ── Batch dispose handles asynchronously ───────
async function batchDisposeHandles(elements: InteractiveElement[]): Promise<void> {
    const disposePromises = elements
        .filter(el => el.handle && typeof el.handle.dispose === 'function')
        .map(el => el.handle.dispose().catch((err: Error) => { console.warn("[BROWSER] Handle disposal failed:", err.message); }));

    // Don't await all individually — let them run in parallel
    if (disposePromises.length > 0) {
        await Promise.all(disposePromises);
    }
}

// ── OCR Fallback Scan ────────────────────────
// When DOM scanning finds very few interactive elements, take a screenshot
// and run OCR to find text regions that can be clicked by coordinates.

async function ocrFallbackScan(page: Page): Promise<InteractiveElement[]> {
    try {
        const screenshotBuffer = await page.screenshot({ type: "png", fullPage: false });
        const tmpPath = path.join(tmpdir(), `atlas-ocr-fallback-${Date.now()}.png`);
        fs.writeFileSync(tmpPath, screenshotBuffer);

        const ocrResult = await runOCR(tmpPath);

        // Clean up temp file
        try { fs.unlinkSync(tmpPath); } catch { /* */ }

        if (!ocrResult.regions || ocrResult.regions.length === 0) return [];

        return ocrResult.regions
            .filter(r => r.bounds.width > 20 && r.bounds.height > 10 && r.text.trim().length > 0)
            .slice(0, 50) // Cap OCR elements
            .map((r, i) => ({
                label: i + 1, // Will be reassigned by caller
                x: Math.round(r.bounds.x + r.bounds.width / 2),
                y: Math.round(r.bounds.y + r.bounds.height / 2),
                tag: "ocr-text",
                text: r.text.substring(0, 40).trim(),
                atlasId: `atlas-ocr-${Date.now()}-${i}`,
                isOCRElement: true,
            }));
    } catch (err) {
        console.warn(`  ⚠️ OCR fallback failed: ${(err as Error).message}`);
        return [];
    }
}

// ── Get Interactive Elements ──────────────────

export async function getInteractiveElements(page: Page, forceRefresh = false): Promise<InteractiveElement[]> {
    const scanStart = Date.now();

    // Chrome extension mode: delegate to the Chrome backend's scanner
    if (getCurrentMode() === "chrome") {
        const backend = await getActiveBackend();
        const elements = await backend.scanElements(forceRefresh);
        lastElementMap = elements;
        const url = (typeof page.url === "function") ? page.url() : "";
        if (url) cacheElements(url, elements);
        console.log(`  🔍 Chrome extension: scanned ${elements.length} interactive elements`);

        // OCR fallback when very few DOM elements found
        if (elements.length < 3) {
            const ocrElements = await ocrFallbackScan(page);
            if (ocrElements.length > 0) {
                for (const ocr of ocrElements) {
                    ocr.label = elements.length + ocrElements.indexOf(ocr) + 1;
                }
                elements.push(...ocrElements);
                lastElementMap = elements;
                console.log(`  🔍 OCR fallback added ${ocrElements.length} text regions`);
            }
        }

        console.log(`  ⏱️ Scan completed in ${Date.now() - scanStart}ms (${elements.length} elements${elements.some(e => e.editorType) ? ', editors detected' : ''}${elements.some(e => e.isOCRElement) ? ', OCR fallback used' : ''})`);
        return elements;
    }

    // Playwright mode
    const currentUrl = page.url();

    // ── Smart Cache Check ──
    if (!forceRefresh && shouldUseCachedElements(currentUrl) && lastElementMap.length > 0) {
        console.log(`  ⚡ Using cached elements (${lastElementMap.length} elements, cache age: ${Date.now() - (elementCache?.timestamp || 0)}ms)`);
        return lastElementMap;
    }

    const oldElements = [...lastElementMap];

    // ═══════════════════════════════════════════════
    // PRIMARY: ariaSnapshot — no JS injection, works on minified SPAs
    // (Next.js, React, Vue) where SCAN_FRAME_JS returned 0 elements.
    // Uses Playwright's internal incrementalAriaSnapshot via the browser's
    // native accessibility engine — bypasses eval scope entirely.
    // ═══════════════════════════════════════════════
    let ariaElements: InteractiveElement[] = [];
    try {
        const yaml = await page.locator("body").ariaSnapshot({ timeout: 3000 });
        if (yaml && yaml.trim().length > 10) {
            const INTERACTIVE_ROLES = new Set([
                "button", "link", "textbox", "searchbox", "combobox", "listbox",
                "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
                "option", "switch", "slider", "spinbutton", "treeitem",
            ]);

            // Parse YAML into (role, name, ref) tuples — works with and without [ref=] annotations
            // Playwright 1.58 format: "- button \"Submit\"" (no refs)
            // Playwright 1.60+ format: "- button \"Submit\" [ref=e42]"
            const parsed: Array<{ role: string; name: string; ref: string; idx: number }> = [];
            yaml.split("\n").forEach((line: string, idx: number) => {
                const m = /^[\s-]*(\w+)\s+"([^"]*)"/.exec(line);
                if (!m) return;
                const role = m[1].toLowerCase();
                if (!INTERACTIVE_ROLES.has(role)) return;
                const ref = (/\[ref=([\w\d]+)\]/.exec(line)?.[1]) ?? "";
                parsed.push({ role, name: m[2], ref, idx });
            });

            // Resolve bounding boxes in parallel (much faster than sequential)
            const BATCH = 20; // max concurrent boundingBox calls
            for (let i = 0; i < Math.min(parsed.length, 120); i += BATCH) {
                const batch = parsed.slice(i, i + BATCH);
                const boxes = await Promise.all(
                    batch.map(async (p) => {
                        try {
                            const loc = page.getByRole(
                                p.role as Parameters<typeof page.getByRole>[0],
                                { name: p.name, exact: true }
                            ).first();
                            const box = await loc.boundingBox({ timeout: 1200 }).catch(() => null);
                            if (box && box.width > 2 && box.height > 2) return { p, box };
                            // Retry with exact:false for partial name matches
                            const loc2 = page.getByRole(
                                p.role as Parameters<typeof page.getByRole>[0],
                                { name: p.name, exact: false }
                            ).first();
                            const box2 = await loc2.boundingBox({ timeout: 800 }).catch(() => null);
                            if (box2 && box2.width > 2 && box2.height > 2) return { p, box: box2 };
                            return null;
                        } catch { return null; }
                    })
                );
                for (const result of boxes) {
                    if (!result) continue;
                    const { p, box } = result;
                    ariaElements.push({
                        label: ariaElements.length + 1,
                        x: Math.round(box.x + box.width / 2),
                        y: Math.round(box.y + box.height / 2),
                        tag: p.role,
                        text: p.name.substring(0, 60),
                        atlasId: p.ref ? `aria-${p.ref}` : `aria-${p.idx}`,
                        handle: undefined,
                    });
                }
            }

            if (ariaElements.length > 0) {
                console.log(`  🌳 ariaSnapshot: ${ariaElements.length}/${parsed.length} interactive elements (${Date.now() - scanStart}ms)`);
            }
        }
    } catch { /* ariaSnapshot unavailable or page not ready — fall through to SCAN_FRAME_JS */ }

    // ═══════════════════════════════════════════════
    // FALLBACK: SCAN_FRAME_JS across all frames
    // Used when ariaSnapshot yields < 3 elements (canvas apps, WebGL, old pages)
    // ═══════════════════════════════════════════════
    const allFrames = page.frames(); // hoisted — also used for handle fetching below
    let legacyCandidates: Array<{ x: number; y: number; tag: string; text: string; score: number; atlasId: string; frameIndex: number; editorType?: string }> = [];
    if (ariaElements.length < 3) {
        const frameScanPromises = allFrames.map(async (frame: Page, fi: number) => {
            try {
                const frameCandidates = await frame.evaluate(SCAN_FRAME_JS);
                return frameCandidates.map((c: InteractiveElement & { score: number }) => ({ ...c, frameIndex: fi }));
            } catch (err) {
                if (ariaElements.length === 0) {
                    console.warn(`  ⚠️ Frame ${fi} scan failed: ${(err as Error).message}`);
                }
                return [];
            }
        });
        const frameResults = await Promise.all(frameScanPromises);
        legacyCandidates = frameResults.flat();
    }

    // Prefer ariaSnapshot results; merge legacy if ariaSnapshot was sparse
    const allCandidates: Array<{ x: number; y: number; tag: string; text: string; score: number; atlasId: string; frameIndex: number; editorType?: string }> =
        ariaElements.length >= 3
            ? ariaElements.map(e => ({ ...e, score: 10, frameIndex: 0 }))
            : legacyCandidates;

    if (allCandidates.length === 0) {
        console.log("  ⚠️ getInteractiveElements: 0 candidates found across all methods");
        return [];
    }

    // De-duplicate across frames by center coordinates (some elements in iframes
    // overlap with main frame elements)
    const seenCoords = new Set<string>();
    const uniqueCandidates = allCandidates.filter(c => {
        const key = `${c.x},${c.y}`;
        if (seenCoords.has(key)) return false;
        seenCoords.add(key);
        return true;
    });

    // Sort deterministically same as before
    uniqueCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (Math.abs(b.y - a.y) > 5) return a.y - b.y;
        return a.x - b.x;
    });

    // Assign final labels (1-indexed)
    const labeled = uniqueCandidates.slice(0, 400).map((c, i) => ({
        ...c,
        label: i + 1,
    }));

    // Parallel handle fetching (18-20x faster than sequential)
    // ariaSnapshot elements (atlasId starts with "aria-") skip DOM handle lookup —
    // they have no data-atlas-id in the DOM. Coordinate-based clicking works fine for them.
    const handleResults = await Promise.all(
        labeled.map(async (item) => {
            // ariaSnapshot path: return immediately without handle (coordinate click used)
            if (item.atlasId?.startsWith("aria-")) {
                return {
                    label: item.label,
                    x: item.x,
                    y: item.y,
                    tag: item.tag,
                    text: item.text,
                    atlasId: item.atlasId,
                    handle: undefined,
                    editorType: item.editorType,
                } as InteractiveElement;
            }
            // SCAN_FRAME_JS path: look up data-atlas-id DOM handle for precise clicking
            try {
                const frame = allFrames[item.frameIndex];
                if (!frame) return null;
                const handle = await frame.$(`[data-atlas-id="${item.atlasId}"]`);
                if (!handle) return null;
                return {
                    label: item.label,
                    x: item.x,
                    y: item.y,
                    tag: item.tag,
                    text: item.text,
                    atlasId: item.atlasId,
                    handle,
                    editorType: item.editorType,
                } as InteractiveElement;
            } catch {
                return null;
            }
        })
    );
    const resultElements: InteractiveElement[] = handleResults.filter((r): r is InteractiveElement => r !== null);

    console.log(`  🔍 Scanned ${allFrames.length} frame(s) in parallel, found ${resultElements.length} interactive elements`);

    // OCR fallback when very few DOM elements found
    if (resultElements.length < 3) {
        const ocrElements = await ocrFallbackScan(page);
        if (ocrElements.length > 0) {
            for (let oi = 0; oi < ocrElements.length; oi++) {
                ocrElements[oi].label = resultElements.length + oi + 1;
            }
            resultElements.push(...ocrElements);
            console.log(`  🔍 OCR fallback added ${ocrElements.length} text regions`);
        }
    }

    // Update global state
    lastElementMap = resultElements;

    // Dispose old handles AFTER new ones are assigned to prevent races
    setTimeout(() => batchDisposeHandles(oldElements).catch((err: Error) => { console.warn("[BROWSER] Batch handle disposal failed:", err.message); }), 500);

    // Cache the results
    cacheElements(currentUrl, resultElements);

    console.log(`  ⏱️ Scan completed in ${Date.now() - scanStart}ms (${resultElements.length} elements${resultElements.some(e => e.editorType) ? ', editors detected' : ''}${resultElements.some(e => e.isOCRElement) ? ', OCR fallback used' : ''})`);
    return resultElements;
}

// ── Accessibility Tree Extraction ────────────

/**
 * Format a single accessibility tree node and its children as an indented text tree.
 * Filters out noise roles (none, generic) to keep the output compact.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAccessibilityTree(node: any, depth: number): string {
    let result = "";
    const indent = "  ".repeat(depth);
    const role = node.role || "";
    const name = node.name || "";
    const value = node.value || "";

    // Skip noise roles that add bulk without semantic value
    if (role && role !== "none" && role !== "generic") {
        result += `${indent}[${role}] ${name}`;
        if (value) result += ` = "${value}"`;
        result += "\n";
    }

    if (node.children) {
        for (const child of node.children) {
            result += formatAccessibilityTree(child, role && role !== "none" && role !== "generic" ? depth + 1 : depth);
        }
    }
    return result;
}

/**
 * Extract the accessibility tree from a Playwright page.
 * Returns a compact indented text representation of the page's semantic structure.
 * This is typically 80-90% smaller than the full DOM and captures the same interactive elements.
 *
 * Falls back to empty string in Chrome extension mode or if the API is unavailable.
 */
export async function getAccessibilityTree(page: Page): Promise<string> {
    // Chrome extension mode doesn't support Playwright's accessibility API
    if (getCurrentMode() === "chrome") {
        return "";
    }

    try {
        const snapshot = await page.accessibility.snapshot();
        if (!snapshot) return "";
        return formatAccessibilityTree(snapshot, 0);
    } catch {
        // accessibility.snapshot() may not be available in all Playwright versions
        // or may fail on certain pages — degrade gracefully
        return "";
    }
}

/**
 * Full page scan: returns both the accessibility tree (compact, fast) and
 * the DOM-based interactive element list (detailed, fallback).
 *
 * Callers get the best of both worlds:
 * - accessibilityTree: lightweight semantic view for LLM reasoning
 * - elements: coordinate-mapped handles for precise click/type actions
 */
export async function scanPage(page: Page, forceRefresh = false): Promise<PageScanResult> {
    const title = await page.title();
    const url = page.url();

    // Run accessibility tree extraction and DOM element scan in parallel
    const [accessibilityTree, elements] = await Promise.all([
        getAccessibilityTree(page),
        getInteractiveElements(page, forceRefresh),
    ]);

    return {
        url,
        title,
        accessibilityTree,
        elements,
    };
}
