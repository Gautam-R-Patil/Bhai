// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Navigation Tools ──────────────────
// Navigate, scan, back, switch tabs, close

import type { ToolDefinition } from "../get-current-time.js";
import type { InteractiveElement } from "./types.js";
import {
    getBrowser,
    getActivePage,
    getInteractiveElements,
    getAccessibilityTree,
    waitForPageReady,
    setLastElementMap,
    getLastElementMap,
    setActivePageIndex,
    getActivePageIndex,
    invalidateCache,
    ATLAS_HUD_JS,
} from "./core.js";
import {
    getCachedActions,
    shouldReplayActions,
    replayActions,
    markActionFailed
} from "./action-cache.js";

// ═══════════════════════════════════════════════
// TOOL: Navigate
// ═══════════════════════════════════════════════

export const browserNavigate: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_navigate",
            description: "Navigate to a URL in the current tab. Returns page title, URL, and a condensed DOM of interactive elements. Use browser_switch_tab with new_tab=true to open a new tab first if needed.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL to navigate to" },
                    new_tab: { type: "boolean", description: "Open URL in a new tab instead of the current one" },
                    wait_for: { type: "string", description: "CSS selector to wait for (optional)" },
                    timeout_ms: { type: "number", description: "Navigation timeout in milliseconds (default: 30000)" },
                },
                required: ["url"],
            },
        },
    },
    async handler(input) {
        try {
            const context = await getBrowser();
            let page;
            if (input.new_tab) {
                page = await context.newPage();
            } else {
                page = await getActivePage();
            }
            const timeout = (input.timeout_ms as number) || 30000;
            // Show HUD while navigating
            const navDomain = (input.url as string).replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
            await page.evaluate(ATLAS_HUD_JS, { label: `🌐 Navigating to ${navDomain}`, done: false }).catch(() => {});
            // Catch navigation timeouts — page is likely usable even if not fully loaded
            await page.goto(input.url as string, { waitUntil: "domcontentloaded", timeout }).catch(() => null);

            // Smart wait for the page to stabilize
            await waitForPageReady(page);
            // Clear HUD once page is ready
            await page.evaluate(ATLAS_HUD_JS, { label: '', done: true }).catch(() => {});

            if (input.wait_for) {
                await page.waitForSelector(input.wait_for as string, { timeout: 10000 }).catch(() => null);
            }

            const title = await page.title();
            const url = page.url();
            const tabCount = context.pages().length;

            // Run a11y tree + DOM scan in parallel
            const [accessibilityTree, elementMap] = await Promise.all([
                getAccessibilityTree(page),
                getInteractiveElements(page),
            ]);
            setLastElementMap(elementMap);

            const serializedElements = elementMap.map(e => ({
                label: e.label,
                x: e.x,
                y: e.y,
                tag: e.tag,
                text: e.text,
                editorType: e.editorType,
                isOCRElement: e.isOCRElement,
            }));

            // Generate Condensed DOM Markdown
            let interactive_elements_text = "No interactive elements detected.";
            if (serializedElements.length > 0) {
                interactive_elements_text = serializedElements.map(e => {
                    if ((e as any).editorType) return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                    if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                    return `[${e.label}] ${e.tag} '${e.text}'`;
                }).join('\n');
            }

            const result: Record<string, unknown> = {
                success: true, title, url, open_tabs: tabCount,
                interactive_elements_text,
                tip: "Read interactive_elements_text to find the label ID, then use browser_click_at with the label to click."
            };

            if (accessibilityTree) {
                result.accessibility_tree = accessibilityTree;
            }

            // Check action cache — if we have a high-success cached sequence for this URL,
            // inform the agent so it can use browser_replay_actions instead of re-analyzing
            try {
                const cached = getCachedActions(url);
                if (cached && shouldReplayActions(cached)) {
                    result.cached_actions_available = true;
                    result.cached_action_count = cached.actions.length;
                    result.cached_success_rate = Math.round(
                        (cached.successCount / Math.max(1, cached.successCount + cached.failCount)) * 100
                    );
                    result.tip = "Cached actions available for this page! Use browser_replay_actions to replay them (skips LLM analysis). Falls back automatically if they fail.";
                }
            } catch { /* action cache lookup non-fatal */ }

            return JSON.stringify(result);
        } catch (err) {
            return JSON.stringify({ error: `Navigation failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: DOM Scanner (TEXT ONLY)
// ═══════════════════════════════════════════════

export const browserScan: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_scan",
            description: "Scan the active browser page to get a textual DOM tree of all clickable/interactive elements. Returns an accessibility tree (compact semantic view) plus a labeled element list. Use the label numbers with browser_click_at's 'label' param for precise clicking. Set visual=true for design tools (Canva, Figma), maps, or any page where you need to SEE the layout visually. Use hover_at to pre-hover before scanning — essential for pages like YouTube where controls are hidden until hover.",
            parameters: {
                type: "object",
                properties: {
                    full_page: { type: "boolean", description: "Capture full page (default: false)" },
                    clean: { type: "boolean", description: "No element labels — just the raw page (for reading text/images)" },
                    visual: { type: "boolean", description: "Attach a screenshot so you can SEE the page. Use for design tools, maps, image-heavy pages, or when you need visual context to make decisions." },
                    hover_at: {
                        type: "object",
                        description: "If provided, hover at these coordinates (with interpolated steps) BEFORE scanning. Use to reveal hover-hidden controls — e.g. {x: 640, y: 400} on a YouTube page reveals the player controls. Wait is applied before scan.",
                        properties: {
                            x: { type: "number" },
                            y: { type: "number" },
                            steps: { type: "number", description: "Mouse interpolation steps (default: 8)" },
                            wait_ms: { type: "number", description: "How long to dwell after hovering before scanning (default: 600ms)" },
                        }
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();

            // Pre-hover: reveal hidden controls before scanning (e.g. YouTube player controls)
            if (input.hover_at) {
                const ha = input.hover_at as { x?: number; y?: number; steps?: number; wait_ms?: number };
                const hx = ha.x ?? 640, hy = ha.y ?? 400;
                const hSteps = ha.steps ?? 8, hWait = ha.wait_ms ?? 600;
                await page.mouse.move(hx, hy, { steps: hSteps });
                await page.waitForTimeout(hWait);
            }

            const title = await page.title();
            const url = page.url();

            let elementMap: InteractiveElement[] = [];

            // Run accessibility tree extraction in parallel with DOM scan
            // A11y tree is faster (80-90% smaller than DOM) and gives a semantic page view
            const a11yPromise = getAccessibilityTree(page);

            if (!input.clean) {
                // Force-refresh cache when hover_at was used (new elements may be visible now)
                elementMap = await getInteractiveElements(page, !!input.hover_at);
            }

            const accessibilityTree = await a11yPromise;

            setLastElementMap(elementMap);

            // Strip the handles out of the metadata sent to the LLM (they don't serialize)
            const serializedElements = elementMap.map(e => ({
                label: e.label,
                x: e.x,
                y: e.y,
                tag: e.tag,
                text: e.text,
                editorType: e.editorType,
                isOCRElement: e.isOCRElement,
            }));

            // Generate Condensed DOM Markdown
            let interactive_elements_text = "No interactive elements detected.";
            if (serializedElements.length > 0) {
                interactive_elements_text = serializedElements.map(e => {
                    if ((e as any).editorType) return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                    if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                    return `[${e.label}] ${e.tag} '${e.text}'`;
                }).join('\n');
            }

            const result: Record<string, unknown> = {
                success: true,
                title, url,
                interactive_elements_text,
                viewport: { width: 1280, height: 800 },
                tip: "Use interactive_elements_text to find the label ID, then click it using browser_click_at."
            };

            // Include accessibility tree if available (compact semantic page view)
            if (accessibilityTree) {
                result.accessibility_tree = accessibilityTree;
                result.tip = "Read accessibility_tree for a compact semantic view of the page. Use interactive_elements_text labels for clicking.";
            }

            // Visual mode: attach an optimized screenshot for design tools, maps, etc.
            // Using JPEG with quality 55 for optimal size/quality balance
            if (input.visual) {
                try {
                    const screenshotBuffer = await page.screenshot({
                        type: 'jpeg',
                        quality: 55,  // Reduced from 60 for smaller payload
                        fullPage: !!input.full_page,
                        scale: 'css'  // Use CSS pixels, not device pixels (smaller on retina)
                    });
                    result.screenshot_base64 = screenshotBuffer.toString('base64');
                    result.mime_type = 'image/jpeg';
                    result.screenshot_size_kb = Math.round(screenshotBuffer.length / 1024);
                    result.tip = "Use the screenshot to understand the visual layout. Use interactive_elements_text labels for clicking.";
                } catch { /* screenshot failed, text-only fallback */ }
            }

            return JSON.stringify(result);
        } catch (err) {
            return JSON.stringify({ error: `DOM Scan failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Back
// ═══════════════════════════════════════════════

export const browserBack: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_back",
            description: "Go back in browser history (like clicking the back button).",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        try {
            const page = await getActivePage();
            await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
            await waitForPageReady(page);

            const title = await page.title();
            const url = page.url();

            const elementMap = await getInteractiveElements(page);
            setLastElementMap(elementMap);

            const serializedElements = elementMap.map(e => ({
                label: e.label,
                x: e.x,
                y: e.y,
                tag: e.tag,
                text: e.text,
                editorType: e.editorType,
                isOCRElement: e.isOCRElement,
            }));

            let interactive_elements_text = "No interactive elements detected.";
            if (serializedElements.length > 0) {
                interactive_elements_text = serializedElements.map(e => {
                    if ((e as any).editorType) return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                    if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                    return `[${e.label}] ${e.tag} '${e.text}'`;
                }).join('\n');
            }

            return JSON.stringify({ success: true, title, url, interactive_elements_text });
        } catch (err) {
            return JSON.stringify({ error: `Back failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Switch Tab
// ═══════════════════════════════════════════════

export const browserSwitchTab: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_switch_tab",
            description: "Switch to a different browser tab by index (0-based), open a new tab (with optional URL), or close the active tab. Use this to manage multiple tabs.",
            parameters: {
                type: "object",
                properties: {
                    tab_index: { type: "number", description: "Switch to tab at this index (0-based)" },
                    new_tab: { type: "boolean", description: "Open a new empty tab (then use browser_navigate to go somewhere)" },
                    url: { type: "string", description: "If new_tab=true, optionally navigate to this URL immediately" },
                    close_active: { type: "boolean", description: "Close the currently active tab" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const context = await getBrowser();
            const pages = context.pages();

            // Close active tab
            if (input.close_active) {
                if (pages.length === 1) {
                    return JSON.stringify({ error: "Cannot close the last remaining tab." });
                }
                const page = await getActivePage();
                await page.close();
                const newPages = context.pages();
                const newIdx = Math.min(getActivePageIndex(), newPages.length - 1);
                setActivePageIndex(newIdx);
                await newPages[newIdx].bringToFront();
                return JSON.stringify({ success: true, action: "closed_active", active_tab: newIdx, open_tabs: newPages.length });
            }

            // Open new tab
            if (input.new_tab) {
                const newPage = await context.newPage();
                if (input.url) {
                    await newPage.goto(input.url as string, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
                    await waitForPageReady(newPage);
                }
                const newPages = context.pages();
                const newTabIdx = newPages.indexOf(newPage);
                setActivePageIndex(newTabIdx);
                await newPage.bringToFront();

                // Invalidate cache when switching pages
                invalidateCache();

                const title = await newPage.title();
                const url = newPage.url();

                // Scan elements in the new tab
                const elementMap = await getInteractiveElements(newPage);
                setLastElementMap(elementMap);

                const serializedElements = elementMap.map(e => ({
                    label: e.label,
                    x: e.x,
                    y: e.y,
                    tag: e.tag,
                    text: e.text,
                    editorType: e.editorType,
                    isOCRElement: e.isOCRElement,
                }));

                let interactive_elements_text = "No interactive elements detected.";
                if (serializedElements.length > 0) {
                    interactive_elements_text = serializedElements.map(e => {
                        if ((e as any).editorType) return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                        if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                        return `[${e.label}] ${e.tag} '${e.text}'`;
                    }).join('\n');
                }

                return JSON.stringify({
                    success: true,
                    action: "new_tab_opened",
                    title, url,
                    active_tab: newTabIdx,
                    open_tabs: newPages.length,
                    interactive_elements_text
                });
            }

            // Switch to existing tab by index
            if (input.tab_index !== undefined) {
                const idx = input.tab_index as number;
                if (idx < 0 || idx >= pages.length) {
                    return JSON.stringify({ error: `Tab index ${idx} out of range. Available tabs: 0 to ${pages.length - 1}` });
                }
                setActivePageIndex(idx);
                await pages[idx].bringToFront();

                // Invalidate cache when switching pages
                invalidateCache();

                const title = await pages[idx].title();
                const url = pages[idx].url();

                // Scan elements in the switched-to tab
                const elementMap = await getInteractiveElements(pages[idx]);
                setLastElementMap(elementMap);

                const serializedElements = elementMap.map(e => ({
                    label: e.label,
                    x: e.x,
                    y: e.y,
                    tag: e.tag,
                    text: e.text,
                    editorType: e.editorType,
                    isOCRElement: e.isOCRElement,
                }));

                let interactive_elements_text = "No interactive elements detected.";
                if (serializedElements.length > 0) {
                    interactive_elements_text = serializedElements.map(e => {
                        if ((e as any).editorType) return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                        if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                        return `[${e.label}] ${e.tag} '${e.text}'`;
                    }).join('\n');
                }

                return JSON.stringify({
                    success: true,
                    action: "switched_tab",
                    title, url,
                    active_tab: idx,
                    open_tabs: pages.length,
                    interactive_elements_text
                });
            }

            // No action specified — list tabs
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tabList = await Promise.all(pages.map(async (p: any, i: number) => ({
                index: i,
                title: await p.title(),
                url: p.url(),
                active: i === getActivePageIndex()
            })));

            return JSON.stringify({ tabs: tabList, active_tab: getActivePageIndex(), open_tabs: pages.length });
        } catch (err) {
            return JSON.stringify({ error: `Tab switch failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Close Browser
// ═══════════════════════════════════════════════

export const browserClose: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_close",
            description: "Close the browser completely (all tabs). The browser will restart on next use.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        try {
            const context = await getBrowser();
            await context.close();
            return JSON.stringify({ success: true, message: "Browser closed. Will restart on next navigation." });
        } catch (err) {
            return JSON.stringify({ error: `Close failed: ${(err as Error).message}` });
        }
    },
};
