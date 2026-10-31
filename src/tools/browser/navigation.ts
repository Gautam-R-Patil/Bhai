// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Navigation Tools ──────────────────
// Navigate, scan, back, switch tabs, close

import type { ToolDefinition } from "../get-current-time.js";
import { withAgentUIHidden } from "./agent-cursor.js";
import { checkAuthWall } from "./auth-wall.js";
import { getActiveBackend, getCurrentMode } from "./browser-backend.js";
import { quickCaptchaCheck } from "./captcha.js";
import {
    BHAI_HUD_JS,
    buildElementsText,
    getAccessibilityTree,
    getActivePage,
    getBrowser,
    getInteractiveElements,
    getLastElementMap,
    invalidateCache,
    pickActivePage,
    resetBrowserContext,
    setActivePageIndex,
    setLastElementMap,
    waitForPageReady,
} from "./core.js";
import { takePageEvents } from "./popup-guard.js";
import type { InteractiveElement } from "./types.js";
import { unsafeBrowserUrl } from "../../security/url-safety.js";

// Statuses that mean the site refused us (bot wall / rate limit / outage) — report as failure.
const BLOCKING_STATUSES = new Set([403, 429, 503]);

// ═══════════════════════════════════════════════
// TOOL: Navigate
// ═══════════════════════════════════════════════

/**
 * Add the semantic tree after the element list, only in the room the agent's
 * result cap leaves (agent.ts TOOL_RESULT_LIMITS: navigate 4000, scan 6000;
 * past that it truncates or offloads): the clickable labels must survive.
 */
export function addTreeWithinBudget(result: Record<string, unknown>, tree: string, limit: number): void {
    // Screenshots become image parts before the cap, so they don't count.
    const room = limit - JSON.stringify({ ...result, screenshot_base64: undefined }).length - 60;
    if (!tree || room < 300) return;
    let t = tree.slice(0, room);
    for (let over = JSON.stringify(t).length - room; over > 0; over = JSON.stringify(t).length - room) {
        t = t.slice(0, t.length - over); // JSON escapes (\n, \") make it longer than its length
    }
    result.accessibility_tree = t.length < tree.length ? `${t}\n…(truncated)` : t;
}

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
            const urlRaw = String(input.url ?? "").trim();
            if (!urlRaw) {
                return JSON.stringify({ error: "url is required" });
            }
            const unsafe = unsafeBrowserUrl(urlRaw);
            if (unsafe) return JSON.stringify({ error: unsafe, url: urlRaw.slice(0, 120) });
            // Where the time goes (a Wikipedia page took 14s): logged once the result is built.
            const t0 = Date.now();
            const lap: string[] = [];
            let tLast = t0;
            const mark = (step: string) => {
                const now = Date.now();
                lap.push(`${step} ${now - tLast}ms`);
                tLast = now;
            };

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
                    `(${BHAI_HUD_JS})(${JSON.stringify({ label: `🌐 Navigating to ${navDomain}`, done: false })})`,
                )
                .catch(() => {});
            // Navigation timeouts are non-fatal (page is likely usable even if not fully
            // loaded) but reported as timed_out; any other goto error (DNS, connection
            // refused, ...) is a failure.
            let navError: string | null = null;
            let status: number | null = null;
            let timedOut = false;
            try {
                // Playwright returns a Response; ChromePageProxy returns void (no status).
                const resp = (await page.goto(input.url as string, { waitUntil: "domcontentloaded", timeout })) as {
                    status?: () => number;
                } | null;
                status = resp?.status?.() ?? null;
            } catch (err) {
                if ((err as Error).name === "TimeoutError") timedOut = true;
                else navError = (err as Error).message.split("\n")[0];
            }
            invalidateCache();

            // Smart wait for the page to stabilize
            mark("load");
            if (!navError) await waitForPageReady(page);
            mark("ready");
            // Clear HUD once page is ready
            await page.evaluate(`(${BHAI_HUD_JS})(${JSON.stringify({ label: "", done: true })})`).catch(() => {});

            if (!navError && page.url().startsWith("chrome-error://"))
                navError = "browser error page (site unreachable)";
            if (!navError && status !== null && BLOCKING_STATUSES.has(status)) navError = `HTTP ${status}`;
            if (navError) {
                return JSON.stringify({
                    error: `Navigation failed: ${navError}`,
                    url: page.url(),
                    ...(status !== null ? { status } : {}),
                    ...takePageEvents(),
                });
            }

            let waitForTimedOut = false;
            if (input.wait_for) {
                await page.waitForSelector(input.wait_for as string, { timeout: 10000 }).catch(() => {
                    waitForTimedOut = true;
                });
            }

            // Login/OTP wall: may import the user's Chrome session and reload — before the scan.
            // Not on a CAPTCHA page: the pipeline gets that one first, after this tool returns.
            const authFields = (await quickCaptchaCheck(page)) ? {} : await checkAuthWall(page);
            mark("checks");

            const title = await page.title();
            const url = page.url();
            const tabCount = context ? context.pages().length : (await (await getActiveBackend()).getAllTabs()).length;

            // Run a11y tree + DOM scan in parallel
            const [accessibilityTree, elementMap] = await Promise.all([
                getAccessibilityTree(page),
                getInteractiveElements(page),
            ]);
            setLastElementMap(elementMap);
            mark("scan");

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
                ...(status !== null ? { status } : {}),
                ...(timedOut
                    ? { timed_out: true, note: `Page did not finish loading within ${timeout}ms; it may be partial.` }
                    : {}),
                ...(waitForTimedOut ? { wait_for_timed_out: true } : {}),
                ...authFields,
                ...takePageEvents(),
                tip: "Read interactive_elements_text to find the label ID, then use browser_click_at with the label to click.",
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

            // The start of what the page says, so "when was it completed / what's the capital"
            // needs no selector: gpt-4.1-nano read Wikipedia with invalid or heading-only
            // selectors and never found the fact. Rendered text only (no hidden text).
            if (!isDesignTool) {
                const text = await page
                    .evaluate(
                        /* javascript-obfuscator:disable */ ({ max }: { max: number }) => {
                            // No named helpers in here: the bundler's __name() doesn't exist in the page.
                            const out: string[] = [];
                            let n = 0;
                            for (const p of Array.from(document.querySelectorAll("main p, article p, #content p, p"))) {
                                const t = (p as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "";
                                if (t.length < 60 || out.includes(t)) continue;
                                out.push(t);
                                n += t.length;
                                if (n > 1000) break;
                            }
                            // The page's first fact table (an infobox: Capital, Population, Born…).
                            const facts: string[] = [];
                            for (const tr of Array.from(document.querySelectorAll("table tr")).slice(0, 60)) {
                                const th = tr.querySelector("th");
                                const td = tr.querySelector("td");
                                if (!th || !td) continue;
                                const row = `${(th as HTMLElement).innerText} ${(td as HTMLElement).innerText}`.replace(/\s+/g, " ").trim();
                                if (row.length < 120) facts.push(row);
                                if (facts.join("; ").length > 500) break;
                            }
                            return `${out.join(" ").slice(0, max)}${facts.length ? `\nFacts: ${facts.join("; ")}` : ""}`;
                        },
                        /* javascript-obfuscator:enable */ { max: 1200 },
                    )
                    .catch(() => "");
                if (text.trim()) result.page_text = text;
                mark("text");
            }
            console.log(`  🌐 navigate ${navDomain}: ${lap.join(" · ")} (total ${Date.now() - t0}ms)`);

            result.interactive_elements_text = buildElementsText(); // last: status/tip fields come first
            addTreeWithinBudget(result, accessibilityTree, 4000);
            return JSON.stringify(result);
        } catch (err) {
            return JSON.stringify({ error: `Navigation failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: DOM Scanner (TEXT ONLY)
// ═══════════════════════════════════════════════

// browser_scan: the last scan (page + arguments) and how many times in a row it was asked again.
let lastScanKey = "";
let repeatScans = 0;

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
            // gpt-4.1-nano opened a URL with open_in_app (the user's own browser) and then scanned
            // Bhai's empty one eight times.
            if (/^(about:blank|chrome:\/\/newtab\/?)?$/.test(page.url())) {
                return JSON.stringify({
                    success: false,
                    error: "Bhai's browser has no page open. Open one with browser_navigate (url), then scan or extract it.",
                });
            }

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
                viewport: { width: 1280, height: 800 },
                tip: "Use interactive_elements_text to find the label ID, then click it using browser_click_at.",
            };

            if (isDesignApp) {
                result.design_tool = true;
                result.tip = `🎨 DESIGN APP (${url.split("/")[2]}). Canvas-based — very few DOM elements. ALWAYS click by exact x,y coordinates from the screenshot, NOT by label. Common shortcuts: v=select, r=rectangle, t=text, h=pan, Escape=deselect. browser_scan(visual:true) before every action.`;
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

            result.interactive_elements_text = buildElementsText(); // last: status/tip fields come first
            addTreeWithinBudget(result, accessibilityTree, 6000);
            // The same page, unchanged, scanned again and again (gpt-4.1-nano: eight full-page scans of
            // one Wikipedia list) gets a pointer instead of the same large result. Compared on the
            // result, so a scan after a click that changed the page always goes through.
            const scanKey = `${page.url()}|${String(result.interactive_elements_text)}`;
            repeatScans = scanKey === lastScanKey ? repeatScans + 1 : 0;
            lastScanKey = scanKey;
            if (repeatScans >= 2)
                return JSON.stringify({
                    success: true,
                    unchanged: true,
                    note: "The page is the same as in your last two scans. To find something on it, use browser_extract with a selector like \"tr:contains('Germany')\" or \"p:contains('population')\".",
                });
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
            invalidateCache();

            const title = await page.title();
            const url = page.url();

            const elementMap = await getInteractiveElements(page);
            setLastElementMap(elementMap);

            return JSON.stringify({ success: true, title, url, interactive_elements_text: buildElementsText() });
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
        (await getExtensionTabs()).map((t, index) => ({
            index,
            title: t.title,
            url: t.url,
            active: t.active,
            id: t.id,
        }));
    const view = (tabs: Awaited<ReturnType<typeof list>>) => tabs.map(({ id: _id, ...t }) => t);
    let tabs = await list();
    const at = (i: unknown) => (typeof i === "number" ? tabs[i] : undefined);
    if (typeof input.close_tab_index === "number" || input.close_active) {
        // "The active tab" is the focused window's: every window has an active tab, so
        // tabs.find(t => t.active) could close the owner's tab in another window.
        const current = input.close_active
            ? ((await sendBridgeCommand("get_active_tab", {}).catch(() => null)) as { id?: number } | null)
            : null;
        const target =
            typeof input.close_tab_index === "number"
                ? at(input.close_tab_index)
                : tabs.find((t) => t.id === current?.id);
        if (!target) return JSON.stringify({ error: "No such tab.", tabs: view(tabs) });
        // An index is a position in a list from an earlier call, across all of the owner's
        // windows: if their tabs moved since, it names another tab. Close only the tab
        // whose URL the caller saw there.
        const norm = (u: unknown) => String(u ?? "").replace(/#.*$/, "").replace(/\/+$/, "");
        if (typeof input.close_tab_index === "number" && norm(input.close_tab_url) !== norm(target.url)) {
            return JSON.stringify({
                error: input.close_tab_url
                    ? "The tabs changed: that index is a different tab now. Nothing was closed; pick again from this list."
                    : "Pass close_tab_url (the URL shown for that index) with close_tab_index. Nothing was closed.",
                tabs: view(tabs),
            });
        }
        await sendBridgeCommand("close_tab", { tabId: target.id });
        tabs = await list();
        return JSON.stringify({
            success: true,
            action: "closed",
            closed: { title: target.title, url: target.url },
            tabs: view(tabs),
        });
    }
    if (input.new_tab) {
        const bad = input.url ? unsafeBrowserUrl(input.url as string) : null;
        if (bad) return JSON.stringify({ error: bad });
        await sendBridgeCommand("navigate", { url: (input.url as string) || "about:blank", newTab: true });
        tabs = await list();
        return JSON.stringify({ success: true, action: "new_tab_opened", tabs: view(tabs) });
    }
    if (typeof input.tab_index === "number") {
        const target = at(input.tab_index);
        if (!target) return JSON.stringify({ error: "No such tab.", tabs: view(tabs) });
        // focus: a tab in another window must also bring that window forward, or the next
        // command (which acts on the focused window's tab) still hits the old one.
        await sendBridgeCommand("switch_tab", { tabId: target.id, focus: true });
        return JSON.stringify({
            success: true,
            action: "switched",
            title: target.title,
            url: target.url,
            active_tab: input.tab_index,
        });
    }
    return JSON.stringify({ success: true, tabs: view(tabs), open_tabs: tabs.length });
}

export const browserSwitchTab: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_switch_tab",
            description:
                "Switch to a different browser tab by index (0-based), open a new tab (with optional URL), or close a tab — close_active: true closes the tab you are on. This is how to close a browser tab: never a keyboard shortcut (Cmd+W hits whatever app is in front).",
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
                    close_tab_index: {
                        type: "number",
                        description: "Close the tab at this index (0-based, from the list). Needs close_tab_url.",
                    },
                    close_tab_url: {
                        type: "string",
                        description:
                            "The URL the list showed at close_tab_index. If the tabs changed since, nothing is closed and you get the new list.",
                    },
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
                const next = pickActivePage(newPages); // a followed tab's opener, else clamp
                const newIdx = newPages.indexOf(next);
                setActivePageIndex(newIdx);
                await next.bringToFront();
                return JSON.stringify({
                    success: true,
                    action: "closed_active",
                    active_tab: newIdx,
                    open_tabs: newPages.length,
                });
            }

            // Open new tab
            if (input.new_tab) {
                const bad = input.url ? unsafeBrowserUrl(input.url as string) : null;
                if (bad) return JSON.stringify({ error: bad });
                const newPage = await context.newPage();
                let navNote: string | null = null;
                if (input.url) {
                    await newPage
                        .goto(input.url as string, { waitUntil: "domcontentloaded", timeout: 30000 })
                        .catch((err: Error) => {
                            navNote = err.name === "TimeoutError" ? "timed_out" : err.message.split("\n")[0];
                        });
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

                return JSON.stringify({
                    success: true,
                    action: "new_tab_opened",
                    title,
                    url,
                    active_tab: newTabIdx,
                    open_tabs: newPages.length,
                    ...(navNote === "timed_out" ? { timed_out: true } : navNote ? { navigation_error: navNote } : {}),
                    interactive_elements_text: buildElementsText(),
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

                return JSON.stringify({
                    success: true,
                    action: "switched_tab",
                    title,
                    url,
                    active_tab: idx,
                    open_tabs: pages.length,
                    interactive_elements_text: buildElementsText(),
                });
            }

            // No action specified — list tabs. Resolve the active tab the way the next
            // action will (a closed followed popup → its opener), not the raw index.
            const activeIdx = pages.indexOf(pickActivePage(pages));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tabList = await Promise.all(
                pages.map(async (p: any, i: number) => ({
                    index: i,
                    title: await p.title(),
                    url: p.url(),
                    active: i === activeIdx,
                })),
            );

            return JSON.stringify({ tabs: tabList, active_tab: activeIdx, open_tabs: pages.length });
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
            description:
                "Close Bhai's browser (all its tabs; it restarts on next use). In the owner's own Chrome it closes only the tab Bhai is on, never their Chrome.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        try {
            // The owner's Chrome isn't Bhai's to close: there, "close the browser" closes
            // Bhai's tab. (getBrowser() here launched a separate Playwright browser just to
            // close it, or failed outright.)
            await getActiveBackend();
            if (getCurrentMode() === "chrome") return await switchTabInChrome({ close_active: true });
            const context = await getBrowser();
            await context.close();
            resetBrowserContext(); // null out the module-level ref so getBrowser() creates a fresh context
            return JSON.stringify({ success: true, message: "Browser closed. Will restart on next navigation." });
        } catch (err) {
            return JSON.stringify({ error: `Close failed: ${(err as Error).message}` });
        }
    },
};
