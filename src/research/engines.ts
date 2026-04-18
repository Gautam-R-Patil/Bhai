// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Search engines (Google, Brave, DDG, Bing, SearXNG, Mojeek, Semantic Scholar, arXiv)

import type { SearchResult } from "./types.js";
import { randomUA, sleep, ENGINE_COOLDOWN_MS, ENGINE_MAX_CONSECUTIVE_FAILURES, SEARCH_BROWSER_IDLE_MS } from "./profiles.js";
import { getSessionToken } from "../session.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";

// ── Headless Browser (for Google JS-rendered search) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _searchBrowser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _searchContext: any = null;
let _searchBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;

async function getSearchBrowser(): Promise<{ context: any; newPage: () => Promise<any> }> {
    if (_searchBrowserIdleTimer) clearTimeout(_searchBrowserIdleTimer);
    _searchBrowserIdleTimer = setTimeout(async () => {
        try {
            if (_searchContext) await _searchContext.close().catch(() => {});
            if (_searchBrowser) await _searchBrowser.close().catch(() => {});
        } catch {}
        _searchBrowser = null;
        _searchContext = null;
    }, SEARCH_BROWSER_IDLE_MS);

    if (_searchContext) return { context: _searchContext, newPage: () => _searchContext.newPage() };

    const pw = await import("playwright");
    _searchBrowser = await pw.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
    });
    _searchContext = await _searchBrowser.newContext({
        userAgent: randomUA(),
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
    });

    return { context: _searchContext, newPage: () => _searchContext.newPage() };
}

const _cleanupSearchBrowser = async () => {
    if (_searchBrowserIdleTimer) clearTimeout(_searchBrowserIdleTimer);
    try { if (_searchContext) await _searchContext.close().catch(() => {}); } catch {}
    try { if (_searchBrowser) await _searchBrowser.close().catch(() => {}); } catch {}
    _searchBrowser = null;
    _searchContext = null;
};
process.on("beforeExit", _cleanupSearchBrowser);
process.on("SIGTERM", () => { _cleanupSearchBrowser().then(() => process.exit(0)); });
process.on("SIGINT", () => { _cleanupSearchBrowser().then(() => process.exit(0)); });

// ── Engine Health Tracking ──────────────────

type EngineName = "google" | "brave" | "duckduckgo" | "bing" | "searxng" | "mojeek" | "tavily" | "exa" | "wikipedia" | "openalex" | "semantic_scholar" | "arxiv";

interface EngineHealth {
    consecutiveFailures: number;
    lastFailure: number;
    disabled: boolean;
}

const engineHealth = new Map<EngineName, EngineHealth>();

function markFailure(engine: EngineName): void {
    const h = engineHealth.get(engine) || { consecutiveFailures: 0, lastFailure: 0, disabled: false };
    h.consecutiveFailures++;
    h.lastFailure = Date.now();
    // Don't permanently disable — exponential backoff in isAvailable() handles throttling
    if (h.consecutiveFailures >= ENGINE_MAX_CONSECUTIVE_FAILURES) {
        console.log(`[RESEARCH] ⚠️ Engine "${engine}" backing off after ${h.consecutiveFailures} consecutive failures`);
    }
    engineHealth.set(engine, h);
}

function markSuccess(engine: EngineName): void {
    engineHealth.set(engine, { consecutiveFailures: 0, lastFailure: 0, disabled: false });
}

function isAvailable(engine: EngineName): boolean {
    const h = engineHealth.get(engine);
    if (!h) return true;
    if (h.consecutiveFailures === 0) return true;
    // Exponential backoff: 15s, 30s, 60s, 120s, 240s, capped at 5 minutes
    const backoffMs = Math.min(
        ENGINE_COOLDOWN_MS * Math.pow(2, h.consecutiveFailures - 1),
        300_000,
    );
    return Date.now() >= h.lastFailure + backoffMs;
}

/** Reset all engine health — call at the start of each new research session */
export function resetEngineHealth(): void {
    engineHealth.clear();
}

// ── Google Search (Playwright) ───────────────

async function searchGoogle(query: string): Promise<SearchResult[]> {
    if (!isAvailable("google")) return [];
    let page: any = null;
    try {
        const { newPage, context } = await getSearchBrowser();

        // Bypass consent dialog
        await context.addCookies([
            { name: "CONSENT", value: "YES+cb.20240101-00-p0.en+FX+999", domain: ".google.com", path: "/" },
        ]);

        page = await newPage();

        // Anti-detection stealth
        await page.evaluate(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => false });
        });

        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=15&hl=en`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

        // Wait for results to load
        await page.waitForFunction(() => document.querySelectorAll("h3").length > 0, { timeout: 10000 }).catch(() => {});
        await sleep(800);

        const results: SearchResult[] = await page.evaluate(() => {
            const items: Array<{ url: string; title: string; snippet: string }> = [];
            const seen = new Set<string>();

            // Primary: structured result blocks
            document.querySelectorAll("div.g, div[data-hveid]").forEach((block: Element) => {
                const linkEl = block.querySelector("a[href^='http']") as HTMLAnchorElement | null;
                const h3El = block.querySelector("h3");
                const snippetEl = block.querySelector("div[data-sncf], div.VwiC3b, span.aCOpRe, div[style*='line-clamp']");
                if (linkEl && h3El && linkEl.href && !linkEl.href.includes("google.com")) {
                    if (seen.has(linkEl.href)) return;
                    seen.add(linkEl.href);
                    items.push({ url: linkEl.href, title: h3El.textContent?.trim() || "", snippet: snippetEl?.textContent?.trim() || "" });
                }
            });

            // Fallback: any a > h3
            if (items.length === 0) {
                document.querySelectorAll("a").forEach((a: HTMLAnchorElement) => {
                    const h3 = a.querySelector("h3");
                    if (h3 && a.href && a.href.startsWith("http") && !a.href.includes("google.com") && !seen.has(a.href)) {
                        seen.add(a.href);
                        items.push({ url: a.href, title: h3.textContent?.trim() || "", snippet: "" });
                    }
                });
            }
            return items.slice(0, 15);
        });

        // Fallback: parse raw HTML if evaluate found nothing (e.g. Google changed DOM)
        if (results.length === 0) {
            const html = await page.content();
            const fallbackResults = parseGoogleHTML(html);
            if (fallbackResults.length > 0) {
                markSuccess("google");
                return fallbackResults;
            }
        }

        if (results.length > 0) markSuccess("google");
        else markFailure("google");
        return results.map(r => ({ ...r, source: "google" }));
    } catch {
        markFailure("google");
        return [];
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/** Fallback: regex-parse raw Google HTML when page.evaluate finds nothing */
function parseGoogleHTML(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    // Match /url?q=... links with h3 content
    const pattern = /<a[^>]*href="\/url\?q=(https?:\/\/[^&"]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null && results.length < 15) {
        const url = decodeURIComponent(match[1]);
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        if (!seen.has(url) && !url.includes("google.com") && title.length > 3) {
            seen.add(url);
            results.push({ url, title, snippet: "", source: "google" });
        }
    }
    return results;
}

// ── Brave Search ─────────────────────────────

async function searchBrave(query: string): Promise<SearchResult[]> {
    if (!isAvailable("brave")) return [];
    try {
        const response = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
            headers: { "User-Agent": randomUA(), "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
            redirect: "follow",
            signal: AbortSignal.timeout(15000),
        });
        if (response.status !== 200) { markFailure("brave"); return []; }
        const html = await response.text();
        if (html.includes("captcha") || html.includes("rate limit")) { markFailure("brave"); return []; }

        const results: SearchResult[] = [];
        const seenUrls = new Set<string>();

        // Primary: structured snippet blocks
        const snippetBlockPattern = /<div[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
        const snippetBlocks: string[] = [];
        let sm;
        while ((sm = snippetBlockPattern.exec(html)) !== null) {
            snippetBlocks.push(sm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        }

        // Extract links from result blocks
        const linkPattern = /href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let linkIdx = 0;
        let m;
        while ((m = linkPattern.exec(html)) !== null && results.length < 15) {
            if (m[1].includes("brave.com")) continue;
            const rawTitle = m[2].replace(/<[^>]+>/g, "").trim();
            if (rawTitle.length > 5 && rawTitle.length < 200 && !seenUrls.has(m[1])) {
                const snippet = snippetBlocks[linkIdx] || "";
                if (snippet.length > 15 || rawTitle.length > 20) {
                    seenUrls.add(m[1]);
                    results.push({ url: m[1], title: rawTitle, snippet: snippet.substring(0, 300), source: "brave" });
                    linkIdx++;
                }
            }
        }

        // Fallback: broader regex parsing
        if (results.length === 0) {
            const blocks = html.split("<div").slice(1).map(b => "<div" + b);
            for (const block of blocks) {
                const lm = /href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
                if (lm && !lm[1].includes("brave.com")) {
                    const title = lm[2].replace(/<[^>]+>/g, "").trim();
                    if (title.length > 5 && title.length < 200 && !seenUrls.has(lm[1])) {
                        const fullText = block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                        const snippet = fullText.replace(title, "").replace(/.*- Brave Search/, "").replace(/^[^\w]+/, "").trim();
                        if (snippet.length > 20) {
                            seenUrls.add(lm[1]);
                            results.push({ url: lm[1], title, snippet: snippet.substring(0, 300), source: "brave" });
                        }
                    }
                }
                if (results.length >= 15) break;
            }
        }

        if (results.length > 0) markSuccess("brave");
        else markFailure("brave");
        return results;
    } catch { markFailure("brave"); return []; }
}

// ── DuckDuckGo HTML ─────────────────────────

async function searchDDG(query: string): Promise<SearchResult[]> {
    if (!isAvailable("duckduckgo")) return [];

    // Try html.duckduckgo.com first (more reliable than lite)
    const ddgResult = await _searchDDGOnce(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    if (ddgResult.length > 0) { markSuccess("duckduckgo"); return ddgResult; }

    // Fallback: lite version
    const liteResult = await _searchDDGOnce(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
    if (liteResult.length > 0) { markSuccess("duckduckgo"); return liteResult; }

    // Retry once after a short delay (DDG sometimes returns 202 then works)
    await sleep(2000);
    const retryResult = await _searchDDGOnce(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    if (retryResult.length > 0) { markSuccess("duckduckgo"); return retryResult; }

    markFailure("duckduckgo");
    return [];
}

async function _searchDDGOnce(url: string): Promise<SearchResult[]> {
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": randomUA(), "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
        });
        const html = await response.text();
        if (response.status === 202 || html.includes("Refresh this page")) return [];

        const results: SearchResult[] = [];

        // html.duckduckgo.com uses class="result__a" for links and class="result__snippet" for snippets
        const snippetPattern = /<(?:td|a)[^>]*class="?result[_-]?(?:snippet|__snippet)"?[^>]*>([\s\S]*?)<\/(?:td|a)>/gi;
        const linkPattern = /<a[^>]*class="?result[_-]?(?:link|__a|url|__url)"?[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

        const snippets: string[] = [];
        let m;
        while ((m = snippetPattern.exec(html)) !== null) {
            snippets.push(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        }

        let i = 0;
        while ((m = linkPattern.exec(html)) !== null && results.length < 15) {
            let resultUrl = m[1];
            const title = m[2].replace(/<[^>]+>/g, "").trim();
            if (resultUrl.includes("uddg=")) {
                try { resultUrl = decodeURIComponent(resultUrl.split("uddg=")[1].split("&")[0]); } catch {}
            }
            if (title.length > 3 && resultUrl.startsWith("http") && !resultUrl.includes("duckduckgo.com/y.js") && !resultUrl.includes("duckduckgo.com/l/")) {
                results.push({ url: resultUrl, title, snippet: snippets[i] || "", source: "duckduckgo" });
            }
            i++;
        }

        // Broad fallback: any link with a nearby text block
        if (results.length === 0) {
            const broadLink = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            const seen = new Set<string>();
            while ((m = broadLink.exec(html)) !== null && results.length < 15) {
                let href = m[1];
                if (href.includes("duckduckgo.com")) continue;
                if (href.includes("uddg=")) {
                    try { href = decodeURIComponent(href.split("uddg=")[1].split("&")[0]); } catch {}
                }
                const title = m[2].replace(/<[^>]+>/g, "").trim();
                if (title.length > 5 && href.startsWith("http") && !seen.has(href)) {
                    seen.add(href);
                    results.push({ url: href, title, snippet: "", source: "duckduckgo" });
                }
            }
        }

        return results;
    } catch { return []; }
}

// ── Bing Search ─────────────────────────────

async function searchBing(query: string): Promise<SearchResult[]> {
    if (!isAvailable("bing")) return [];
    try {
        const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=15&setlang=en&cc=US&mkt=en-US`, {
            headers: {
                "User-Agent": randomUA(),
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(12000),
        });
        if (response.status !== 200) { markFailure("bing"); return []; }
        const html = await response.text();
        if (html.includes("captcha") || html.includes("blocked")) { markFailure("bing"); return []; }

        const results: SearchResult[] = [];
        const seenUrls = new Set<string>();

        // Bing wraps results in <li class="b_algo" ...> with <h2><a href="...">title</a></h2>
        // URLs are bing.com/ck/a redirect URLs — extract the actual URL from cite tag or data attribute
        const blockPattern = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
        let match;
        while ((match = blockPattern.exec(html)) !== null && results.length < 15) {
            const block = match[1];

            // Extract title from h2 > a
            const h2LinkM = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            if (!h2LinkM) continue;

            const title = h2LinkM[2].replace(/<[^>]+>/g, "").trim();
            if (title.length < 3) continue;

            // Get actual URL: prefer <cite> tag (has real URL), fall back to href
            let url = h2LinkM[1];
            const citeM = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
            if (citeM) {
                let citeUrl = citeM[1].replace(/<[^>]+>/g, "").trim();
                if (!citeUrl.startsWith("http")) citeUrl = "https://" + citeUrl;
                // Clean up: remove trailing "› ..." path segments Bing adds
                citeUrl = citeUrl.split(" ")[0].replace(/›/g, "/").replace(/\/+/g, "/").replace(/:\//g, "://");
                if (citeUrl.startsWith("http")) url = citeUrl;
            }

            // If still a bing redirect, try to decode
            if (url.includes("bing.com/ck/a")) {
                const pMatch = url.match(/[?&]u=a1(https?%3[Aa][^&]+)/);
                if (pMatch) { try { url = decodeURIComponent(pMatch[1]); } catch {} }
            }

            // Skip bing/microsoft internal pages
            if (url.includes("bing.com") || url.includes("microsoft.com/bing")) continue;
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);

            // Extract snippet
            const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
                || block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").trim() : "";

            results.push({ url, title, snippet: snippet.substring(0, 300), source: "bing" });
        }

        if (results.length > 0) markSuccess("bing");
        else markFailure("bing");
        return results;
    } catch { markFailure("bing"); return []; }
}

// ── SearXNG (JSON API — public instances) ───

const SEARXNG_INSTANCES = [
    "https://searx.be",
    "https://search.bus-hit.me",
    "https://searx.tiekoetter.com",
    "https://search.ononoki.org",
    "https://searx.work",
    "https://search.sapti.me",
];

async function searchSearXNG(query: string): Promise<SearchResult[]> {
    if (!isAvailable("searxng")) return [];

    for (const instance of SEARXNG_INSTANCES) {
        try {
            const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=en`;
            const response = await fetch(url, {
                headers: { "User-Agent": randomUA(), "Accept": "application/json" },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) continue;
            const data = await response.json() as any;
            const results: SearchResult[] = (data.results || [])
                .slice(0, 15)
                .filter((r: any) => r.url && r.title)
                .map((r: any) => ({
                    url: r.url,
                    title: r.title || "",
                    snippet: (r.content || "").substring(0, 300),
                    source: "searxng",
                }));
            if (results.length > 0) {
                markSuccess("searxng");
                return results;
            }
        } catch { continue; }
    }
    markFailure("searxng");
    return [];
}

// ── Mojeek Search ───────────────────────────

async function searchMojeek(query: string): Promise<SearchResult[]> {
    if (!isAvailable("mojeek")) return [];
    try {
        const response = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}&fmt=json`, {
            headers: { "User-Agent": randomUA(), "Accept": "application/json,text/html" },
            signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
            // Fallback to HTML parsing if JSON not available
            if (response.headers.get("content-type")?.includes("text/html")) {
                return _searchMojeekHTML(query);
            }
            markFailure("mojeek");
            return [];
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            const data = await response.json() as any;
            const results = (data.response?.results || []).slice(0, 15).map((r: any) => ({
                url: r.url, title: r.title || "", snippet: (r.desc || "").substring(0, 300), source: "mojeek",
            })).filter((r: SearchResult) => r.url && r.title);
            if (results.length > 0) { markSuccess("mojeek"); return results; }
        }

        // If JSON didn't work, try HTML
        return _searchMojeekHTML(query);
    } catch { markFailure("mojeek"); return []; }
}

async function _searchMojeekHTML(query: string): Promise<SearchResult[]> {
    try {
        const response = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": randomUA(), "Accept": "text/html" },
            signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) { markFailure("mojeek"); return []; }
        const html = await response.text();

        const results: SearchResult[] = [];
        const seenUrls = new Set<string>();

        // Mojeek uses <li class="results-standard"> blocks
        const blockPattern = /<li[^>]*class="[^"]*results-standard[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
        let match;
        while ((match = blockPattern.exec(html)) !== null && results.length < 15) {
            const block = match[1];
            const linkM = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            if (!linkM || seenUrls.has(linkM[1])) continue;
            const title = linkM[2].replace(/<[^>]+>/g, "").trim();
            const snippetM = block.match(/<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
            const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, "").trim() : "";
            if (title.length > 3) {
                seenUrls.add(linkM[1]);
                results.push({ url: linkM[1], title, snippet: snippet.substring(0, 300), source: "mojeek" });
            }
        }

        if (results.length > 0) markSuccess("mojeek");
        else markFailure("mojeek");
        return results;
    } catch { markFailure("mojeek"); return []; }
}

// ── Tavily Search API (proxied via Convex) ──

async function searchTavily(query: string): Promise<SearchResult[]> {
    if (!isAvailable("tavily")) return [];
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) return [];

        const proxyUrl = `${getConvexSiteUrl()}/api/search/tavily`;
        const response = await encryptedFetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ query, search_depth: "advanced", max_results: 15 }),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            if (response.status === 429) markFailure("tavily");
            return [];
        }
        const data = await response.json() as any;
        const results: SearchResult[] = (data.results || []).map((r: any) => ({
            url: r.url,
            title: r.title || "",
            snippet: (r.content || "").substring(0, 400),
            source: "tavily",
        })).filter((r: SearchResult) => r.url && r.title);
        if (results.length > 0) markSuccess("tavily");
        else markFailure("tavily");
        return results;
    } catch { markFailure("tavily"); return []; }
}

// ── Exa Search API (proxied via Convex) ─────

async function searchExa(query: string): Promise<SearchResult[]> {
    if (!isAvailable("exa")) return [];
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) return [];

        const proxyUrl = `${getConvexSiteUrl()}/api/search/exa`;
        const response = await encryptedFetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
                query,
                type: "auto",
                numResults: 15,
                contents: { highlights: { maxCharacters: 300 } },
            }),
            signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
            if (response.status === 429) markFailure("exa");
            return [];
        }
        const data = await response.json() as any;
        const results: SearchResult[] = (data.results || []).map((r: any) => ({
            url: r.url,
            title: r.title || "",
            snippet: (r.highlights?.[0] || r.text?.substring(0, 300) || "").substring(0, 400),
            source: "exa",
        })).filter((r: SearchResult) => r.url && r.title);
        if (results.length > 0) markSuccess("exa");
        else markFailure("exa");
        return results;
    } catch { markFailure("exa"); return []; }
}

// ── Wikipedia Search API (free, no key) ─────

async function searchWikipedia(query: string): Promise<SearchResult[]> {
    if (!isAvailable("wikipedia")) return [];
    try {
        const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=10&srprop=snippet|titlesnippet&format=json&origin=*`;
        const response = await fetch(url, {
            headers: { "User-Agent": `ATLAS-Research/2.0 (${randomUA()})` },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) { markFailure("wikipedia"); return []; }
        const data = await response.json() as any;
        const results: SearchResult[] = (data.query?.search || []).map((r: any) => ({
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
            title: r.title || "",
            snippet: (r.snippet || "").replace(/<[^>]+>/g, "").substring(0, 300),
            source: "wikipedia",
        })).filter((r: SearchResult) => r.title);
        if (results.length > 0) markSuccess("wikipedia");
        return results;
    } catch { markFailure("wikipedia"); return []; }
}

// ── OpenAlex API (academic, free, no key) ───

async function searchOpenAlex(query: string): Promise<SearchResult[]> {
    if (!isAvailable("openalex")) return [];
    try {
        const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=15&select=id,title,doi,abstract_inverted_index,cited_by_count,publication_year&mailto=atlas@codingdesk.info`;
        const response = await fetch(url, {
            headers: { "User-Agent": "ATLAS-Research/2.0" },
            signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) { markFailure("openalex"); return []; }
        const data = await response.json() as any;
        const results: SearchResult[] = (data.results || []).map((work: any) => {
            // Reconstruct abstract from inverted index
            let abstract = "";
            if (work.abstract_inverted_index) {
                const words: Array<[string, number]> = [];
                for (const [word, positions] of Object.entries(work.abstract_inverted_index as Record<string, number[]>)) {
                    for (const pos of positions) words.push([word, pos]);
                }
                words.sort((a, b) => a[1] - b[1]);
                abstract = words.map(w => w[0]).join(" ").substring(0, 400);
            }

            const articleUrl = work.doi
                ? `https://doi.org/${work.doi.replace("https://doi.org/", "")}`
                : work.id?.replace("https://openalex.org/", "https://openalex.org/works/") || "";

            return {
                url: articleUrl,
                title: work.title || "",
                snippet: abstract,
                source: "openalex",
                citationCount: work.cited_by_count || 0,
            };
        }).filter((r: SearchResult) => r.title && r.url);
        if (results.length > 0) markSuccess("openalex");
        return results;
    } catch { markFailure("openalex"); return []; }
}

// ── Semantic Scholar API ─────────────────────

async function searchSemanticScholar(query: string): Promise<SearchResult[]> {
    if (!isAvailable("semantic_scholar")) return [];
    try {
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=20&fields=title,url,abstract,citationCount,year,authors`;
        const response = await fetch(url, { headers: { "User-Agent": randomUA() }, signal: AbortSignal.timeout(12000) });
        if (!response.ok) { if (response.status === 429) markFailure("semantic_scholar"); return []; }
        const data = await response.json() as any;
        const results = (data.data || []).map((p: any) => ({
            title: p.title || "",
            url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
            snippet: (p.abstract || "").substring(0, 400),
            source: "semantic_scholar",
            citationCount: p.citationCount || 0,
        })).filter((r: SearchResult) => r.title && r.url);
        if (results.length > 0) markSuccess("semantic_scholar");
        return results;
    } catch { return []; }
}

// ── arXiv API ────────────────────────────────

async function searchArxiv(query: string): Promise<SearchResult[]> {
    if (!isAvailable("arxiv")) return [];
    try {
        const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=15`;
        const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) return [];
        const xml = await response.text();
        const results: SearchResult[] = [];
        const entries = xml.split("<entry>").slice(1);
        for (const entry of entries) {
            const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() || "";
            const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || "";
            const summary = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, " ").trim() || "";
            if (title && id) results.push({ title, url: id, snippet: summary.substring(0, 400), source: "arxiv" });
        }
        if (results.length > 0) markSuccess("arxiv");
        return results;
    } catch { return []; }
}

// ── Unified Multi-Engine Search ──────────────

export async function multiEngineSearch(
    query: string,
    useAcademic = false,
): Promise<{ results: SearchResult[]; engines: string[] }> {
    console.log(`[RESEARCH] 🔎 Searching: "${query.substring(0, 60)}..."`);

    const searches: Promise<SearchResult[]>[] = [
        searchTavily(query),     // AI-optimized, most reliable
        searchExa(query),        // AI-optimized deep search with content
        searchBing(query),       // Large index, fetch-only
        searchSearXNG(query),    // Meta-search JSON API
        searchBrave(query),      // Independent index
        searchDDG(query),        // Privacy-friendly
        searchWikipedia(query),  // Free, reliable, structured
        searchGoogle(query),     // Playwright-based (slower, may get blocked)
        searchMojeek(query),     // Independent crawler
    ];

    if (useAcademic) {
        searches.push(searchSemanticScholar(query));
        searches.push(searchArxiv(query));
        searches.push(searchOpenAlex(query));  // Free academic API, no key needed
    }

    const settled = await Promise.allSettled(searches);

    const seenUrls = new Set<string>();
    const merged: SearchResult[] = [];
    const enginesUsed: string[] = [];

    for (const outcome of settled) {
        if (outcome.status === "fulfilled" && outcome.value.length > 0) {
            const source = outcome.value[0]?.source || "unknown";
            if (!enginesUsed.includes(source)) enginesUsed.push(source);
            for (const r of outcome.value) {
                if (!seenUrls.has(r.url)) {
                    seenUrls.add(r.url);
                    merged.push(r);
                }
            }
        }
    }

    if (merged.length === 0) {
        console.warn(`[RESEARCH]   ⚠️ 0 results — all search engines returned empty for: "${query.substring(0, 60)}..."`);
    } else {
        console.log(`[RESEARCH]   ✅ ${merged.length} unique results from [${enginesUsed.join(", ")}]`);
    }
    return { results: merged, engines: enginesUsed };
}
