// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── OpenCLI-Inspired Browser Tools ────────────────────────────────────────────
// Advanced tools ported from OpenCLI's architecture:
// - browser_batch_fetch: N URLs in one evaluate() (fanout optimization)
// - browser_auto_scroll: scroll with MutationObserver settle detection
// - browser_network_requests: Performance API request inspection
// - browser_form_state: snapshot all form field values at once
// - browser_intercept: Fetch/XHR monkey-patch interceptor
// - browser_extract_article: Mozilla Readability + fallback chain
// - browser_connect_electron: Connect to Electron apps via CDP

import type { ToolDefinition } from "../get-current-time.js";
import {
    AUTO_SCROLL_JS,
    GET_FORM_STATE_JS,
    getActivePage,
    getBrowser,
    NETWORK_REQUESTS_JS,
    SCROLL_TO_ELEMENT_JS,
} from "./core.js";

// ═══════════════════════════════════════════════
// TOOL: Batch Fetch (OpenCLI fanout optimization)
// ═══════════════════════════════════════════════

export const browserBatchFetch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_batch_fetch",
            description:
                "Fetch multiple URLs concurrently in a single browser evaluate() call — massively faster than N individual fetch calls because all HTTP requests run inside the browser (with session cookies, auth headers) in one CDP round-trip. Returns array of { url, status, data, error }. Uses worker-pool concurrency (default 5). Ideal for bulk data extraction, API fan-out, parallel page fetching.",
            parameters: {
                type: "object",
                properties: {
                    urls: { type: "array", items: { type: "string" }, description: "URLs to fetch concurrently" },
                    method: { type: "string", description: "HTTP method (default: GET)" },
                    headers: { type: "object", description: "Request headers to send with every request" },
                    concurrency: {
                        type: "number",
                        description: "Max parallel fetches inside browser (default: 5, max: 20)",
                    },
                    response_type: { type: "string", description: "'json' (default), 'text', or 'auto'" },
                    timeout_ms: { type: "number", description: "Per-request timeout in ms (default: 15000)" },
                },
                required: ["urls"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const urls = input.urls as string[];
            const method = (input.method as string) || "GET";
            const headers = (input.headers as Record<string, string>) || {};
            const concurrency = Math.min((input.concurrency as number) || 5, 20);
            const responseType = (input.response_type as string) || "json";
            const timeoutMs = (input.timeout_ms as number) || 15000;

            if (!urls || urls.length === 0) return JSON.stringify({ error: "No URLs provided" });

            // Single evaluate() — all fetches run inside the browser context
            // with the browser's cookies, auth headers, and CORS credentials.
            // Worker-pool pattern: configurable concurrency to avoid overwhelming servers.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const results = await page.evaluate(
                async ([urlList, meth, hdrs, conc, resType, toutMs]: any[]) => {
                    const results: Array<{ url: string; status: number; data: unknown; error?: string; size: number }> =
                        new Array(urlList.length);
                    let idx = 0;

                    async function worker() {
                        while (idx < urlList.length) {
                            const i = idx++;
                            const url = urlList[i];
                            const ctrl = new AbortController();
                            const timer = setTimeout(() => ctrl.abort(), toutMs);
                            try {
                                const resp = await fetch(url, {
                                    method: meth,
                                    headers: hdrs,
                                    credentials: "include",
                                    signal: ctrl.signal,
                                });
                                clearTimeout(timer);
                                const text = await resp.text();
                                let data: unknown = text;
                                if (
                                    resType === "json" ||
                                    (resType === "auto" && resp.headers.get("content-type")?.includes("json"))
                                ) {
                                    try {
                                        data = JSON.parse(text);
                                    } catch {
                                        data = text;
                                    }
                                }
                                results[i] = { url, status: resp.status, data, size: text.length };
                            } catch (e) {
                                clearTimeout(timer);
                                results[i] = { url, status: 0, data: null, error: (e as Error).message, size: 0 };
                            }
                        }
                    }

                    const workers = Array.from({ length: Math.min(conc, urlList.length) }, () => worker());
                    await Promise.all(workers);
                    return results;
                },
                [urls, method, headers, concurrency, responseType, timeoutMs],
            );

            const successCount = (results as Array<{ error?: string }>).filter((r) => !r.error).length;
            return JSON.stringify({
                success: true,
                total: urls.length,
                succeeded: successCount,
                failed: urls.length - successCount,
                results,
            });
        } catch (err) {
            return JSON.stringify({ error: `batch_fetch failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Auto Scroll with settle detection
// ═══════════════════════════════════════════════

export const browserAutoScroll: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_auto_scroll",
            description:
                "Scroll the page N times with intelligent DOM mutation settle detection between each scroll. Uses MutationObserver to detect when lazy-loaded content finishes rendering before scrolling further. Perfect for infinite scroll pages, lazy-loading galleries, social feeds. More reliable than timed scrolls because it waits for actual content, not just fixed delays.",
            parameters: {
                type: "object",
                properties: {
                    times: { type: "number", description: "Number of scroll steps (default: 3)" },
                    scroll_delay_ms: {
                        type: "number",
                        description: "Max wait after each scroll for content to appear (default: 2000ms)",
                    },
                    settle_ms: {
                        type: "number",
                        description: "DOM quiet period to consider 'settled' (default: 600ms)",
                    },
                    direction: { type: "string", description: "'down' (default) or 'up'" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const times = (input.times as number) || 3;
            const delayMs = (input.scroll_delay_ms as number) || 2000;
            const settleMs = (input.settle_ms as number) || 600;
            const direction = (input.direction as string) || "down";

            const scrollScript =
                direction === "up"
                    ? AUTO_SCROLL_JS.replace("window.innerHeight * 0.85", "-(window.innerHeight * 0.85)")
                    : AUTO_SCROLL_JS;

            await page.evaluate(`(${scrollScript})(${times}, ${delayMs}, ${settleMs})`);
            const scrollY = await page.evaluate("window.scrollY").catch(() => 0);

            return JSON.stringify({ success: true, scrolled_steps: times, direction, current_scroll_y: scrollY });
        } catch (err) {
            return JSON.stringify({ error: `auto_scroll failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Network Requests via Performance API
// ═══════════════════════════════════════════════

export const browserNetworkRequests: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_network_requests",
            description:
                "Inspect all network requests made by the current page using the Performance Resource Timing API — works without CDP Network domain. Returns URL, type, duration, transfer size for all requests. Filter by type (fetch, xmlhttprequest, script, img) or pattern. Useful for discovering API endpoints, understanding page data sources, or debugging load performance.",
            parameters: {
                type: "object",
                properties: {
                    include_static: {
                        type: "boolean",
                        description: "Include images, CSS, fonts (default: false — excludes them)",
                    },
                    filter_type: {
                        type: "string",
                        description:
                            "Only return requests of this initiator type: 'fetch', 'xmlhttprequest', 'script', 'link', etc.",
                    },
                    filter_pattern: { type: "string", description: "Only return URLs containing this string" },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const includeStatic = !!(input.include_static as boolean);
            const filterType = (input.filter_type as string) || "";
            const filterPattern = (input.filter_pattern as string) || "";

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let requests = (await page.evaluate(`(${NETWORK_REQUESTS_JS})(${includeStatic})`)) as any[];

            if (filterType) requests = requests.filter((r: { type: string }) => r.type === filterType);
            if (filterPattern) requests = requests.filter((r: { url: string }) => r.url.includes(filterPattern));

            return JSON.stringify({
                success: true,
                count: requests.length,
                requests: requests.slice(0, 100), // cap at 100 to avoid token overflow
            });
        } catch (err) {
            return JSON.stringify({ error: `network_requests failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Form State Snapshot
// ═══════════════════════════════════════════════

export const browserFormState: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_form_state",
            description:
                "Snapshot all form field values (inputs, selects, textareas) in one call. Returns { field_id_or_name → value } map. Checkboxes return booleans, multi-selects return arrays. Call before and after form interactions to track state changes, or to verify form was filled correctly.",
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
            const state = await page.evaluate(GET_FORM_STATE_JS + "()");
            const count = Object.keys(state as object).length;
            return JSON.stringify({ success: true, field_count: count, fields: state });
        } catch (err) {
            return JSON.stringify({ error: `form_state failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Scroll to element
// ═══════════════════════════════════════════════

export const browserScrollToElement: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_scroll_to_element",
            description:
                "Scroll a specific element into view using its data-atlas-id or CSS selector. Uses instant scrollIntoView with block:center positioning. More reliable than coordinate-based scrolling for elements that are off-screen. Use before clicking elements that aren't visible in the current viewport.",
            parameters: {
                type: "object",
                properties: {
                    selector: {
                        type: "string",
                        description: "Element's data-atlas-id value (from browser_scan) or CSS selector",
                    },
                },
                required: ["selector"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const selector = input.selector as string;
            const found = await page.evaluate(`(${SCROLL_TO_ELEMENT_JS})(${JSON.stringify(selector)})`);
            return JSON.stringify({ success: !!found, selector, scrolled: !!found });
        } catch (err) {
            return JSON.stringify({ error: `scroll_to_element failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Fetch/XHR Interceptor (OpenCLI interceptor.ts)
// ═══════════════════════════════════════════════

const INTERCEPTOR_JS = `
(function(pattern) {
    if (window.__atlasInterceptorActive) return 'already_active';
    window.__atlasInterceptorActive = true;
    window.__atlasIntercepted = [];

    const _tryParse = (text) => { try { return JSON.parse(text); } catch { return text; } };
    const _matches = (url) => !pattern || url.includes(pattern);

    // Patch fetch
    const _origFetch = window.fetch;
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (_matches(url)) {
            return _origFetch.apply(this, args).then(resp => {
                resp.clone().text().then(body => {
                    window.__atlasIntercepted.push({
                        url, method: args[1]?.method || 'GET',
                        status: resp.status, type: 'fetch',
                        body: _tryParse(body), ts: Date.now()
                    });
                }).catch(() => {});
                return resp;
            });
        }
        return _origFetch.apply(this, args);
    };

    // Patch XHR
    const _origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__atlasUrl = url; this.__atlasMethod = method;
        return _origOpen.apply(this, [method, url, ...rest]);
    };
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
        const xhr = this;
        const _origOSC = this.onreadystatechange;
        this.onreadystatechange = function(...a) {
            if (xhr.readyState === 4 && _matches(xhr.__atlasUrl || '')) {
                window.__atlasIntercepted.push({
                    url: xhr.__atlasUrl, method: xhr.__atlasMethod || 'GET',
                    status: xhr.status, type: 'xhr',
                    body: _tryParse(xhr.responseText), ts: Date.now()
                });
            }
            if (_origOSC) return _origOSC.apply(this, a);
        };
        return _origSend.apply(this, args);
    };
    return 'installed';
})
`;

export const browserInterceptStart: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_intercept_start",
            description:
                "Install a Fetch/XHR interceptor that captures API responses from the browser's own network calls. Unlike CDP Network domain (which requires a new browser session), this monkey-patches fetch() and XMLHttpRequest in-page and works immediately. Use for extracting private API data from SPAs (Twitter, LinkedIn, etc.) without screen-scraping. Follow with an action that triggers the request, then call browser_intercept_read.",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description:
                            "Only capture requests whose URL contains this string (e.g. 'api', 'graphql', 'timeline'). Empty = capture all.",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const pattern = (input.pattern as string) || "";
            const result = await page.evaluate(`(${INTERCEPTOR_JS})(${JSON.stringify(pattern)})`);
            return JSON.stringify({ success: true, status: result, pattern: input.pattern || "(all)" });
        } catch (err) {
            return JSON.stringify({ error: `intercept_start failed: ${(err as Error).message}` });
        }
    },
};

export const browserInterceptRead: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_intercept_read",
            description:
                "Read all captured API responses collected since browser_intercept_start. Returns array of { url, method, status, type, body } objects. Call after triggering the action that makes the network request.",
            parameters: {
                type: "object",
                properties: {
                    clear: { type: "boolean", description: "Clear the capture buffer after reading (default: true)" },
                    wait_ms: {
                        type: "number",
                        description:
                            "Wait this many ms before reading (default: 500) to allow in-flight requests to complete",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const waitMs = (input.wait_ms as number) ?? 500;
            const clear = (input.clear as boolean) ?? true;
            if (waitMs > 0) await page.waitForTimeout(waitMs);

            const captured = await page.evaluate(`(function() {
                const items = window.__atlasIntercepted || [];
                ${clear ? "window.__atlasIntercepted = [];" : ""}
                return items;
            })()`);

            return JSON.stringify({
                success: true,
                count: (captured as unknown[]).length,
                captured,
            });
        } catch (err) {
            return JSON.stringify({ error: `intercept_read failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Article Extract (OpenCLI article-extract.ts)
// ═══════════════════════════════════════════════

export const browserExtractArticle: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_extract_article",
            description:
                "Extract the main article content from the current page using Mozilla Readability (run in-page) with a CSS selector fallback chain. Returns clean title, author, publish date, and markdown-ready HTML body. Strips ads, navigation, comments, cookie banners. Much better than browser_extract for article/blog/news pages.",
            parameters: {
                type: "object",
                properties: {
                    format: {
                        type: "string",
                        description:
                            "'text' (default, plain text), 'html' (raw HTML), 'summary' (first 500 chars of text)",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const format = (input.format as string) || "text";

            // In-page Readability execution (needs browser DOM APIs)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await page.evaluate(async (fmt: string) => {
                // Single <pre> shortcut (GitHub file views, raw text)
                if (document.body.children.length === 1 && document.body.children[0].tagName === "PRE") {
                    const text = (document.body.children[0] as HTMLElement).innerText || "";
                    return { source: "pre", title: document.title, text, html: `<pre>${text}</pre>` };
                }

                // Denoise clone
                const clone = document.cloneNode(true) as Document;
                const noisy = [
                    "script",
                    "style",
                    "nav",
                    "footer",
                    "aside",
                    '[aria-hidden="true"]',
                    '[role="navigation"]',
                    ".cookie-banner",
                    ".ad-banner",
                    ".advertisement",
                    "#comments",
                    ".sidebar",
                ];
                noisy.forEach((sel) => {
                    try {
                        clone.querySelectorAll(sel).forEach((e) => e.remove());
                    } catch {}
                });

                // Try Readability if available (may be loaded by the page)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const Readability = (window as any).Readability;
                if (Readability) {
                    try {
                        const article = new Readability(clone).parse();
                        if (article && article.textContent?.length > 100) {
                            return {
                                source: "readability",
                                title: article.title,
                                byline: article.byline,
                                publishedTime: article.publishedTime,
                                siteName: article.siteName,
                                text: article.textContent?.trim(),
                                html: article.content,
                            };
                        }
                    } catch {}
                }

                // CSS fallback chain (OpenCLI's 8-selector fallback)
                const selectors = [
                    "main",
                    '[role="main"]',
                    "#main-content",
                    "#main",
                    "#content",
                    ".content",
                    ".post-content",
                    "article",
                    "body",
                ];
                for (const sel of selectors) {
                    const el = clone.querySelector(sel);
                    if (el) {
                        const text = (el as HTMLElement).innerText?.trim() || "";
                        if (text.length > 80) {
                            return { source: "fallback_" + sel, title: document.title, text, html: el.innerHTML };
                        }
                    }
                }
                return {
                    source: "none",
                    title: document.title,
                    text: document.body.innerText?.substring(0, 5000) || "",
                    html: "",
                };
            }, format);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const r = result as any;
            const output =
                format === "html" ? r.html : format === "summary" ? (r.text || "").substring(0, 500) : r.text || "";

            return JSON.stringify({
                success: true,
                source: r.source,
                title: r.title,
                byline: r.byline,
                published_time: r.publishedTime,
                site_name: r.siteName,
                content: output?.substring(0, 8000),
                content_length: (output || "").length,
            });
        } catch (err) {
            return JSON.stringify({ error: `extract_article failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: Electron App Control (OpenCLI electron-apps.ts)
// ═══════════════════════════════════════════════

// Known Electron apps with their CDP debug ports (OpenCLI's built-in registry)
const ELECTRON_APPS: Record<string, { port: number; names: string[] }> = {
    cursor: { port: 9222, names: ["Cursor", "cursor"] },
    codex: { port: 9223, names: ["Codex"] },
    chatwise: { port: 9224, names: ["ChatWise", "chatwise"] },
    notion: { port: 9225, names: ["Notion", "notion"] },
    discord: { port: 9226, names: ["Discord", "discord"] },
    doubao: { port: 9228, names: ["Doubao"] },
    chatgpt: { port: 9236, names: ["ChatGPT", "chatgpt"] },
    vscode: { port: 9229, names: ["Visual Studio Code", "Code", "code"] },
};

export const browserConnectElectron: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_connect_electron",
            description:
                "Connect to an Electron desktop app (Cursor, Notion, Discord, ChatGPT Desktop, VS Code) via Chrome DevTools Protocol. Lists available targets in the app. Once connected, use browser_navigate/scan/click as normal — the agent controls the Electron app's UI directly. App must be running with --remote-debugging-port (auto-detected for known apps).",
            parameters: {
                type: "object",
                properties: {
                    app: {
                        type: "string",
                        description:
                            "App name: 'cursor', 'notion', 'discord', 'chatgpt', 'vscode', 'codex', 'chatwise', 'doubao'",
                    },
                    port: { type: "number", description: "Custom CDP debug port (if app not in built-in registry)" },
                    action: {
                        type: "string",
                        description:
                            "'probe' (check if running), 'list' (list targets), 'info' (version info). Default: 'probe'",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const appName = ((input.app as string) || "").toLowerCase();
            const customPort = input.port as number | undefined;
            const action = (input.action as string) || "probe";

            // Resolve port
            let port = customPort;
            let appInfo = null;
            if (!port && appName) {
                appInfo = ELECTRON_APPS[appName];
                if (appInfo) port = appInfo.port;
            }
            if (!port) {
                const available = Object.entries(ELECTRON_APPS)
                    .map(([k, v]) => `${k} (port ${v.port})`)
                    .join(", ");
                return JSON.stringify({ error: `Unknown app '${appName}'. Known: ${available}` });
            }

            // Probe CDP endpoint
            const endpoint = `http://127.0.0.1:${port}`;
            const probe = async (path: string) => {
                const resp = await fetch(`${endpoint}${path}`, {
                    signal: AbortSignal.timeout(3000),
                }).catch(() => null);
                return resp;
            };

            if (action === "probe") {
                const resp = await probe("/json/version");
                if (!resp || !resp.ok) {
                    return JSON.stringify({
                        success: false,
                        running: false,
                        app: appName,
                        port,
                        hint: `${appName || "App"} is not running with CDP enabled on port ${port}. Start it with --remote-debugging-port=${port}`,
                    });
                }
                const version = await resp.json();
                return JSON.stringify({ success: true, running: true, app: appName, port, version });
            }

            if (action === "list") {
                const resp = await probe("/json");
                if (!resp || !resp.ok) return JSON.stringify({ error: `App not running on port ${port}` });
                const targets = (await resp.json()) as Array<{ title: string; url: string; type: string; id: string }>;
                const filtered = targets.filter((t) => !t.url?.includes("devtools://") && t.type !== "worker");
                return JSON.stringify({
                    success: true,
                    app: appName,
                    port,
                    targets: filtered.map((t) => ({
                        id: t.id,
                        title: t.title,
                        url: t.url,
                        type: t.type,
                    })),
                    hint: "Use browser_set_mode with mode:'playwright' and connect to this CDP endpoint for automation.",
                });
            }

            if (action === "info") {
                const resp = await probe("/json/version");
                if (!resp || !resp.ok) return JSON.stringify({ error: `App not running on port ${port}` });
                return JSON.stringify({ success: true, app: appName, port, info: await resp.json() });
            }

            return JSON.stringify({ error: `Unknown action: ${action}. Use: probe, list, info` });
        } catch (err) {
            return JSON.stringify({ error: `connect_electron failed: ${(err as Error).message}` });
        }
    },
};

// ═══════════════════════════════════════════════
// TOOL: WaitForSelector with MutationObserver
// ═══════════════════════════════════════════════
// Replaces polling-based wait with event-driven MutationObserver.
// Fires immediately if selector already exists; installs observer otherwise.
// Dramatically reduces wait time on fast pages vs polling every 500ms.

export const browserWaitForSelector: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_wait_for_selector",
            description:
                "Wait for a CSS selector to appear in the DOM using MutationObserver (fires immediately when the element appears, no polling lag). More efficient than browser_wait with type:'selector'. Also supports waiting for the selector to DISAPPEAR (e.g. wait for loading spinner to go away).",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector to wait for" },
                    state: { type: "string", description: "'visible' (appear, default) or 'hidden' (disappear)" },
                    timeout_ms: { type: "number", description: "Max wait in ms (default: 10000)" },
                },
                required: ["selector"],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const selector = input.selector as string;
            const state = (input.state as string) || "visible";
            const timeoutMs = (input.timeout_ms as number) || 10000;

            // MutationObserver-based wait (OpenCLI waitForSelectorJs)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await page.evaluate(
                async ([sel, st, tout]: any[]) => {
                    return new Promise((resolve, reject) => {
                        const checkFn = () => !!document.querySelector(sel);
                        const satisfied = st === "hidden" ? !checkFn() : checkFn();
                        if (satisfied) {
                            resolve("immediate");
                            return;
                        }

                        const cap = setTimeout(() => {
                            obs.disconnect();
                            reject(new Error(`Timeout: "${sel}" not ${st} after ${tout}ms`));
                        }, tout);
                        const obs = new MutationObserver(() => {
                            const now = st === "hidden" ? !checkFn() : checkFn();
                            if (now) {
                                clearTimeout(cap);
                                obs.disconnect();
                                resolve("observed");
                            }
                        });
                        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                    });
                },
                [selector, state, timeoutMs],
            );

            return JSON.stringify({ success: true, selector, state, resolved: result });
        } catch (err) {
            return JSON.stringify({ error: `wait_for_selector failed: ${(err as Error).message}`, timeout: true });
        }
    },
};

// ═══════════════════════════════════════════════
// All new tools for registration
// ═══════════════════════════════════════════════

export const openCliTools = [
    browserBatchFetch,
    browserAutoScroll,
    browserNetworkRequests,
    browserFormState,
    browserScrollToElement,
    browserInterceptStart,
    browserInterceptRead,
    browserExtractArticle,
    browserConnectElectron,
    browserWaitForSelector,
];
