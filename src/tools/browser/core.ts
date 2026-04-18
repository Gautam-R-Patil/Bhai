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
export function buildElementsText(): string {
    if (lastElementMap.length === 0) return "No interactive elements detected.";
    return lastElementMap.map(e => {
        if (e.editorType) return `[${e.label}] **CODE EDITOR** (${e.editorType}) '${e.text}'`;
        if (e.isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
        return `[${e.label}] ${e.tag} '${e.text}'`;
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
        // Persistent context — keeps cookies, logins, history across sessions
        browserContext = await pw.chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
            headless: false,
            viewport: { width: 1280, height: 800 },
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            serviceWorkers: "block", // Block service workers for consistent behavior
        });

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
            await browserContext.route("**/facebook.net/**", abort);
            await browserContext.route("**/doubleclick.net/**", abort);
            console.log("  🚫 Browser: blocked fonts, analytics, tracking for faster page loads");
        } catch { /* route setup non-fatal */ }
    }
    return browserContext;
}

// ── Get active page ───────────────────────────
// Returns a Playwright Page in playwright mode, or a ChromePageProxy in chrome mode.
// Both support the same API surface used by the tool handlers (goto, evaluate, mouse, keyboard, etc.)

export async function getActivePage(): Promise<Page> {
    // Chrome extension mode: return a proxy that routes to the real Chrome tab
    if (getCurrentMode() === "chrome") {
        const backend = getActiveBackend() as ChromeExtensionBackend;
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

// ── Visual click indicator ────────────────────

export const CLICK_INDICATOR_JS = `
({x, y, type}) => {
    const circle = document.createElement('div');
    circle.style.cssText = \`
        position: fixed; left: \${x - 20}px; top: \${y - 20}px;
        width: 40px; height: 40px; border-radius: 50%;
        background: rgba(59, 130, 246, 0.4);
        border: 2px solid rgba(59, 130, 246, 0.8);
        pointer-events: none; z-index: 999999;
        transition: all 0.5s ease-out;
    \`;
    if (type === 'right') {
        circle.style.background = 'rgba(239, 68, 68, 0.4)';
        circle.style.borderColor = 'rgba(239, 68, 68, 0.8)';
    }
    if (type === 'hold') {
        circle.style.background = 'rgba(34, 197, 94, 0.4)';
        circle.style.borderColor = 'rgba(34, 197, 94, 0.8)';
    }
    document.body.appendChild(circle);
    setTimeout(() => {
        circle.style.transform = 'scale(2)';
        circle.style.opacity = '0';
    }, 100);
    setTimeout(() => circle.remove(), 600);
};
`;

// ── Smart Wait: Ensure page is loaded before scanning ──
export async function waitForPageReady(page: Page, timeoutMs = 3000): Promise<void> {
    // Chrome extension mode: the real Chrome browser handles page loading natively.
    // Just give it a brief moment to stabilize.
    if (getCurrentMode() === "chrome") {
        await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 800)));
        return;
    }

    // Playwright mode (original behavior)
    // Race: domcontentloaded is sufficient for most agent tasks (faster than 'load')
    // networkidle catches AJAX/SPA, hardTimeout prevents hanging
    try {
        await Promise.race([
            page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch((err: Error) => { console.warn("[BROWSER] domcontentloaded wait failed:", err.message); }),
            page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch((err: Error) => { console.warn("[BROWSER] networkidle wait failed:", err.message); }),
        ]);
    } catch (err) { console.warn("[BROWSER] waitForPageReady load state race failed:", (err as Error).message); }

    // Quick DOM stability poll: scan element count twice, 300ms apart.
    // If the count matches, the page has settled. More reliable check.
    try {
        const count1 = await page.evaluate(() => document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]').length);
        await page.waitForTimeout(300);
        const count2 = await page.evaluate(() => document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]').length);
        if (count1 !== count2) {
            // DOM is still changing — wait a bit more for SPA rendering
            await page.waitForTimeout(500);
        }
    } catch (err) { console.warn("[BROWSER] waitForPageReady DOM stability poll failed:", (err as Error).message); }
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

    const candidateMap: Array<{ index: number; x: number; y: number; tag: string; text: string; score: number; editorType?: string }> = [];
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

        if (!(isNativeInt || isRoleInt || hasOnClick || isContentEditable || hasTabIndex || hasCursorPointer || hasButtonClass || hasAriaPopup || hasAriaExpanded || hasAriaControls)) {
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

        const text = (el as HTMLElement).innerText?.replace(/\n/g, ' ').substring(0, 40)
            || (el as HTMLInputElement).placeholder
            || (el as HTMLInputElement).value?.substring(0, 40)
            || el.getAttribute('aria-label')
            || el.getAttribute('title')
            || '';

        let score = 0;
        if (isNativeInt || isRoleInt) score += 10;
        if (hasAriaPopup || hasAriaExpanded) score += 8;
        if (text.trim().length > 0) score += 5;
        if (hasCursorPointer) score += 3;
        if (hasButtonClass) score += 2;

        candidateMap.push({ index: i, x, y, tag, text: text.trim(), score });
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
            candidateMap.push({ index: -1, x: sx, y: sy, tag: sTag, text: sText.trim(), score: 10 });
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
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'code-editor', text: 'Code Editor (Monaco)', score: 25, editorType: 'monaco' });
    });
    // CodeMirror 6
    document.querySelectorAll('.cm-editor').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-cm6-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'code-editor', text: 'Code Editor (CodeMirror)', score: 25, editorType: 'codemirror6' });
    });
    // CodeMirror 5
    document.querySelectorAll('.CodeMirror').forEach((el, i) => {
        if ((el as HTMLElement).closest('.cm-editor')) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-cm5-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'code-editor', text: 'Code Editor (CodeMirror)', score: 25, editorType: 'codemirror5' });
    });
    // Ace
    document.querySelectorAll('.ace_editor').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-ace-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'code-editor', text: 'Code Editor (Ace)', score: 25, editorType: 'ace' });
    });
    // Quill
    document.querySelectorAll('.ql-editor[contenteditable]').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-quill-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'rich-editor', text: 'Rich Text Editor (Quill)', score: 25, editorType: 'quill' });
    });
    // TinyMCE
    document.querySelectorAll('.tox-tinymce').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-tinymce-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'rich-editor', text: 'Rich Text Editor (TinyMCE)', score: 25, editorType: 'tinymce' });
    });
    // ProseMirror / Tiptap
    document.querySelectorAll('.ProseMirror[contenteditable]').forEach((el, i) => {
        const isTiptap = !!(el as HTMLElement).closest('.tiptap') || el.classList.contains('tiptap');
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const type = isTiptap ? 'tiptap' : 'prosemirror';
        const eid = `atlas-editor-${type}-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'rich-editor', text: `Rich Text Editor (${isTiptap ? 'Tiptap' : 'ProseMirror'})`, score: 25, editorType: type });
    });
    // Slate
    document.querySelectorAll('[data-slate-editor]').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-slate-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'rich-editor', text: 'Rich Text Editor (Slate)', score: 25, editorType: 'slate' });
    });
    // Draft.js
    document.querySelectorAll('.DraftEditor-root').forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        const eid = `atlas-editor-draftjs-${edTs}-${i}`;
        el.setAttribute('data-atlas-id', eid);
        editorDetections.push({ index: -1, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: 'rich-editor', text: 'Rich Text Editor (Draft.js)', score: 25, editorType: 'draftjs' });
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
        const backend = getActiveBackend();
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

    // Playwright mode (original behavior below)
    const currentUrl = page.url();

    // ── Smart Cache Check ──
    // Skip rescan if URL hasn't changed and cache is fresh
    if (!forceRefresh && shouldUseCachedElements(currentUrl) && lastElementMap.length > 0) {
        console.log(`  ⚡ Using cached elements (${lastElementMap.length} elements, cache age: ${Date.now() - (elementCache?.timestamp || 0)}ms)`);
        return lastElementMap;
    }

    // Save reference to old elements for deferred disposal (after new ones are assigned)
    const oldElements = [...lastElementMap];

    // Scan ALL frames (main frame + child iframes) — this is critical for
    // Google Docs, Gmail, and other complex apps that render UI in iframes
    const allFrames = page.frames();

    // ═══════════════════════════════════════════════
    // PARALLEL FRAME SCANNING — scan all frames concurrently
    // ═══════════════════════════════════════════════
    const frameScanPromises = allFrames.map(async (frame: Page, fi: number) => {
        try {
            const frameCandidates = await frame.evaluate(SCAN_FRAME_JS);
            return frameCandidates.map((c: InteractiveElement & { score: number }) => ({ ...c, frameIndex: fi }));
        } catch (err) {
            console.warn(`  ⚠️ Frame ${fi} scan failed (detached or cross-origin): ${(err as Error).message}`);
            return [];
        }
    });

    const frameResults = await Promise.all(frameScanPromises);
    const allCandidates: Array<{ x: number; y: number; tag: string; text: string; score: number; atlasId: string; frameIndex: number; editorType?: string }> = frameResults.flat();

    if (allCandidates.length === 0) {
        console.log("  ⚠️ getInteractiveElements: 0 candidates found across all frames");
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
    const handleResults = await Promise.all(
        labeled.map(async (item) => {
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
                    editorType: item.editorType
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
