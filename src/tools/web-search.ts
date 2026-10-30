// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";
import { getSessionToken } from "../session.js";
import { getLocation } from "../location/index.js";
import type { ToolDefinition } from "./get-current-time.js";
import { baseUrlHostMatches } from "../utils/atomic-io.js";

// One log line per engine and failure kind — a silent `return []` hid that
// Tavily/Exa had no API key, so every search quietly ran on Bing scraping.
const reportedFailures = new Set<string>();
// Engines the server says aren't configured (no API key there): every search used to ask
// again and get the same 500. Skip them for an hour.
const unconfiguredUntil = new Map<string, number>();
const engineOff = (engine: string) => (unconfiguredUntil.get(engine) ?? 0) > Date.now();

function engineFailed(engine: string, why: string): void {
    if (/not configured/i.test(why)) unconfiguredUntil.set(engine, Date.now() + 60 * 60_000);
    const key = `${engine}:${why.slice(0, 60)}`;
    if (reportedFailures.has(key)) return;
    reportedFailures.add(key);
    console.warn(`  [web_search] ${engine} unavailable: ${why.slice(0, 200)}`);
}

/** Where the user is, for local results ("under 5k" means rupees in India). */
function searchLocale(): { country?: string; city?: string; timezone?: string } {
    const loc = getLocation();
    const country = loc?.country && /^[A-Za-z]{2}$/.test(loc.country) ? loc.country.toUpperCase() : undefined;
    return { country, city: loc?.city, timezone: loc?.timezone };
}

// ── Claude web search (proxied via Convex; needs no third-party search key) ──

async function searchClaudeLite(query: string): Promise<SearchResult[]> {
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) {
            engineFailed("claude", "no session");
            return [];
        }
        const response = await encryptedFetch(`${getConvexSiteUrl()}/api/search/claude`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ query, ...searchLocale() }),
            signal: AbortSignal.timeout(12000), // settles well inside the 20s tool cap, so the other engines' results survive
        });
        if (!response.ok) {
            engineFailed("claude", `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`);
            return [];
        }
        const data = (await response.json()) as {
            results?: Array<{ url: string; title: string; snippet?: string; page_age?: string | null }>;
        };
        return (data.results || [])
            .filter((r) => r.url && r.title)
            .map((r) => ({
                url: r.url,
                title: r.title,
                snippet: (r.snippet || "").substring(0, 300),
                ...(r.page_age ? { age: r.page_age } : {}),
            }));
    } catch (err) {
        engineFailed("claude", (err as Error).message);
        return [];
    }
}

// ── Parallel Search (proxied via Convex; the key never leaves the server) ──

async function searchParallelLite(query: string): Promise<SearchResult[]> {
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) {
            engineFailed("parallel", "no session");
            return [];
        }
        const response = await encryptedFetch(`${getConvexSiteUrl()}/api/search/parallel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ query, maxResults: 8, country: searchLocale().country }),
            signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
            engineFailed("parallel", `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`);
            return [];
        }
        const data = (await response.json()) as {
            results?: Array<{ url: string; title: string; snippet?: string; page_age?: string | null }>;
        };
        return (data.results || [])
            .filter((r) => r.url && r.title)
            .map((r) => ({
                url: r.url,
                title: r.title,
                snippet: htmlText(r.snippet || "").substring(0, 300),
                ...(r.page_age ? { age: r.page_age } : {}),
            }));
    } catch (err) {
        engineFailed("parallel", (err as Error).message);
        return [];
    }
}

// ── Web Search Tool ───────────────────────────
// Lightweight, fetch-only search. NO Playwright, NO headless browser.
// Uses DuckDuckGo Lite + Brave as fast fallbacks via plain HTTP.
// This is completely independent from deep-research.ts.

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    /** How old the page is, when the engine says (Claude search). */
    age?: string;
}

const USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

function randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Scraped HTML → plain text: tags dropped, entities ("Tom &amp; Jerry", "&#39;") decoded, spaces collapsed. */
export function htmlText(html: string): string {
    return html
        .replace(/<\/?(?:b|strong|em|i|span|mark)\b[^>]*>/gi, "") // engines bold query words mid-word: <b>iPhone</b>s
        .replace(/<[^>]+>/g, " ")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
            if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
            const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        })
        .replace(/\s+/g, " ")
        .trim();
}

// ── DuckDuckGo Lite (fastest, lightest) ───────

async function searchDDGLite(query: string): Promise<SearchResult[]> {
    try {
        const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
            headers: { "User-Agent": randomUA() },
            redirect: "follow",
            // Covers the body read too: a cleared timer let one stalled engine hang the whole search.
            signal: AbortSignal.timeout(8000),
        });

        const html = await response.text();

        if (response.status === 202 || html.includes("Refresh this page")) {
            return [];
        }

        const results: SearchResult[] = [];

        // DDG Lite structure: <a class='result-link'> for titles, <td class='result-snippet'> for snippets
        const snippetPattern = /<td\s+class='result-snippet'>([\s\S]*?)<\/td>/gi;
        const linkPattern = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

        const snippets: string[] = [];
        let match;
        while ((match = snippetPattern.exec(html)) !== null) {
            snippets.push(htmlText(match[1]));
        }

        let i = 0;
        while ((match = linkPattern.exec(html)) !== null && results.length < 15) {
            let resultUrl = match[1];
            const title = htmlText(match[2]);

            // Decode DDG redirect URL
            if (resultUrl.includes("uddg=")) {
                try {
                    resultUrl = decodeURIComponent(resultUrl.split("uddg=")[1].split("&")[0]);
                } catch {}
            }

            if (title.length > 3 && resultUrl.startsWith("http")) {
                results.push({
                    url: resultUrl,
                    title,
                    snippet: snippets[i] || "",
                });
            }
            i++;
        }

        // Fallback: try result-url class links if result-link didn't match
        if (results.length === 0) {
            const fallbackLink = /<a[^>]*class="result-url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            i = 0;
            while ((match = fallbackLink.exec(html)) !== null && results.length < 15) {
                let resultUrl = match[1];
                const title = htmlText(match[2]);
                if (resultUrl.includes("uddg=")) {
                    try {
                        resultUrl = decodeURIComponent(resultUrl.split("uddg=")[1].split("&")[0]);
                    } catch {}
                }
                if (title.length > 3 && resultUrl.startsWith("http")) {
                    results.push({ url: resultUrl, title, snippet: snippets[i] || "" });
                }
                i++;
            }
        }

        return results;
    } catch {
        return [];
    }
}

// ── Brave Search (fetch-only fallback) ────────

async function searchBraveLite(query: string): Promise<SearchResult[]> {
    try {
        const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": randomUA(),
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            // Covers the body read too: a cleared timer let one stalled engine hang the whole search.
            signal: AbortSignal.timeout(8000),
        });

        if (response.status !== 200) return [];

        // No "page mentions captcha" check: Brave's normal results page carries the string
        // "Switch to traditional captcha", so that check dropped every Brave result. A real
        // challenge page has no external result links, and parses to nothing anyway.
        return parseBraveHtml(await response.text());
    } catch {
        return [];
    }
}

/** Results from a Brave Search results page (web results; Brave's own links skipped). */
export function parseBraveHtml(html: string): SearchResult[] {
    const snippetPattern = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    let match;
    while ((match = snippetPattern.exec(html)) !== null && results.length < 15) {
        const url = match[1];
        const content = match[2];

        const titleMatch = content.match(/<div[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const title = htmlText(titleMatch ? titleMatch[1] : content);

        if (url.startsWith("http") && !baseUrlHostMatches(url, "brave.com") && title.length > 5 && !seenUrls.has(url)) {
            seenUrls.add(url);

            const afterLink = html.substring(match.index + match[0].length, match.index + match[0].length + 1500);
            const snippetMatch = afterLink.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            const snippet = snippetMatch ? htmlText(snippetMatch[1]) : "";

            if (snippet.length > 10) {
                results.push({ url, title, snippet: snippet.substring(0, 300) });
            }
        }
    }

    return results;
}

// ── Tavily Search (proxied via Convex) ──────

async function searchTavilyLite(query: string): Promise<SearchResult[]> {
    if (engineOff("tavily")) return [];
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) return [];
        const response = await encryptedFetch(`${getConvexSiteUrl()}/api/search/tavily`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ query, search_depth: "basic", max_results: 10 }),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            engineFailed("tavily", `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`);
            return [];
        }
        const data = (await response.json()) as any;
        return (data.results || [])
            .map((r: any) => ({
                url: r.url,
                title: r.title || "",
                snippet: (r.content || "").substring(0, 300),
            }))
            .filter((r: SearchResult) => r.url && r.title);
    } catch {
        return [];
    }
}

// ── Exa Search (proxied via Convex) ─────────

async function searchExaLite(query: string): Promise<SearchResult[]> {
    if (engineOff("exa")) return [];
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) return [];
        const response = await encryptedFetch(`${getConvexSiteUrl()}/api/search/exa`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({
                query,
                type: "auto",
                numResults: 10,
                contents: { highlights: { maxCharacters: 200 } },
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            engineFailed("exa", `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 120)}`);
            return [];
        }
        const data = (await response.json()) as any;
        return (data.results || [])
            .map((r: any) => ({
                url: r.url,
                title: r.title || "",
                snippet: (r.highlights?.[0] || "").substring(0, 300),
            }))
            .filter((r: SearchResult) => r.url && r.title);
    } catch {
        return [];
    }
}

// ── Bing Search (fetch-only) ────────────────

async function searchBingLite(query: string): Promise<SearchResult[]> {
    try {
        const cc = searchLocale().country;
        const region = cc ? `&cc=${cc}&mkt=en-${cc}&setlang=en` : "";
        const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10${region}`, {
            headers: {
                "User-Agent": randomUA(),
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(8000),
        });
        if (response.status !== 200) return [];
        const html = await response.text();

        const results: SearchResult[] = [];
        const seenUrls = new Set<string>();
        const blockPattern = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
        let match;
        while ((match = blockPattern.exec(html)) !== null && results.length < 10) {
            const block = match[1];
            // Bing uses h2 > a for result links
            const h2LinkM = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            if (!h2LinkM) continue;
            const title = htmlText(h2LinkM[2]);
            if (title.length < 3) continue;

            // The h2 link is a bing.com/ck/a redirect; the real URL is in its `u`
            // param ("a1" + base64url). The <cite> text is display-only and
            // often just the domain, so it is not used.
            const url = decodeBingUrl(h2LinkM[1].replace(/&amp;/g, "&"));
            if (baseUrlHostMatches(url, "bing.com") || seenUrls.has(url)) continue;
            seenUrls.add(url);

            const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
            const snippet = snippetM ? htmlText(snippetM[1]) : "";
            results.push({ url, title, snippet: snippet.substring(0, 300) });
        }
        return results;
    } catch {
        return [];
    }
}

/** Real target of a Bing result link (bing.com/ck/a?…&u=a1<base64url>). */
export function decodeBingUrl(href: string): string {
    try {
        const u = new URL(href, "https://www.bing.com");
        const enc = u.searchParams.get("u");
        if (baseUrlHostMatches(u.href, "bing.com") && enc?.startsWith("a1")) {
            const decoded = Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
            if (/^https?:\/\//.test(decoded)) return decoded;
        }
        return href;
    } catch {
        return href;
    }
}

// Words that say nothing about WHAT is searched for: "best earphones" matched a
// dictionary page for "best" when every word counted.
const STOP = new Set(
    "a an and are as at be best buy by can cheap cheapest compare find for from get good great how i in is it latest me my near new of on or price rs the to top under vs what where which who why with you your".split(
        " ",
    ),
);
const terms = (t: string): string[] =>
    (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));

/**
 * Interleave engines (best first) instead of concatenating them, then rank by
 * how many of the query's meaningful words a result mentions. Results that
 * mention none are dropped once at least two relevant ones remain.
 */
// Tracking params that never change which page a URL points at — stripped so
// the same result from two engines doesn't survive dedup as two rows.
const TRACKING_PARAM = /^(?:utm_|ga_|mc_|_hs|pk_|piwik_)|^(?:fbclid|gclid|dclid|msclkid|yclid|igshid|mkt_tok|ref|ref_src|ref_url|source|spm|_ga)$/i;

/**
 * A dedup key that treats the same page the same across engines: http/https,
 * a leading www., a trailing slash and a #fragment don't matter, and tracking
 * query params are dropped while meaningful ones (?id=5) are kept and sorted.
 * The displayed URL is untouched — only the key is canonical.
 */
export function canonicalUrl(raw: string): string {
    try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase().replace(/^www\./, "");
        const path = u.pathname.replace(/\/+$/, "") || "/";
        const params = [...u.searchParams.entries()]
            .filter(([k]) => !TRACKING_PARAM.test(k))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const search = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
        return `${host}${path}${search}`;
    } catch {
        return raw.trim().toLowerCase();
    }
}

/**
 * Share of the query's meaningful words the best result mentions (1 when the query has none).
 * Scraped engines throttling a script answer only part of a query ("best laptop for
 * programming" → pages about "best"): low coverage says the results are off-topic.
 */
export function bestCoverage(query: string, results: SearchResult[]): number {
    const q = [...new Set(terms(query))];
    if (!q.length || !results.length) return results.length ? 1 : 0;
    const covered = (r: SearchResult) => {
        const hay = terms(`${r.title} ${r.snippet} ${r.url}`);
        return q.filter((t) => hay.some((h) => h === t || (h.length > 3 && t.length > 3 && (h.startsWith(t) || t.startsWith(h)))))
            .length;
    };
    return Math.max(...results.map(covered)) / q.length;
}

export function mergeAndRank(query: string, lists: SearchResult[][]): SearchResult[] {
    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
        for (const l of lists) {
            const r = l[i];
            if (!r) continue;
            const key = canonicalUrl(r.url);
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(r);
            }
        }
    }
    const q = [...new Set(terms(query))];
    if (!q.length) return merged;
    const scored = merged.map((r, i) => {
        const hay = terms(`${r.title} ${r.snippet} ${r.url}`);
        const hits = q.filter((t) =>
            hay.some((h) => h === t || (h.length > 3 && t.length > 3 && (h.startsWith(t) || t.startsWith(h)))),
        ).length;
        return { r, i, hits };
    });
    const relevant = scored.filter((x) => x.hits > 0);
    const pool = relevant.length >= 2 ? relevant : scored;
    return pool.sort((a, b) => b.hits - a.hits || a.i - b.i).map((x) => x.r);
}

// ── Lightweight multi-engine (fetch-only, parallel) ───────────

/**
 * Wait for every engine, but not for the slowest once one has a good answer: after the
 * first list `isGood` accepts, the rest get `graceMs` more. Engines still out then count
 * as having nothing (and are reported as slow, not empty). A failing engine is empty.
 */
export async function gatherWithGrace<T>(
    jobs: Promise<T[]>[],
    isGood: (list: T[]) => boolean,
    graceMs: number,
): Promise<{ lists: T[][]; finished: boolean[] }> {
    const lists: T[][] = jobs.map(() => []);
    const finished = jobs.map(() => false);
    await new Promise<void>((resolve) => {
        let left = jobs.length;
        let grace: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
            clearTimeout(grace);
            resolve();
        };
        if (left === 0) return done();
        jobs.forEach((job, i) => {
            job.then(
                (r) => {
                    lists[i] = Array.isArray(r) ? r : [];
                },
                () => {},
            ).finally(() => {
                finished[i] = true;
                if (--left === 0) return done();
                if (!grace && isGood(lists[i])) grace = setTimeout(done, graceMs);
            });
        });
    });
    // Copies: an engine finishing after the deadline mustn't change what was returned.
    return { lists: lists.map((l, i) => (finished[i] ? l : [])), finished: [...finished] };
}

const SLOW_ENGINE_GRACE_MS = 2500;
const CLAUDE_DELAY_MS = 1500;

async function lightweightSearch(query: string): Promise<{ results: SearchResult[]; engine: string; empty: string[] }> {
    // No Google scraper: google.com/search now serves a JavaScript-only page, so it never
    // returned a result — it only sent Google a scraping request from the owner's IP.
    const names = ["parallel", "claude", "tavily", "exa", "brave", "duckduckgo", "bing"];
    // A good on-topic list from one engine means the slow ones (Claude's route can take 12s)
    // get a short grace, not the whole wait.
    const isGood = (list: SearchResult[]) => list.length >= 3 && bestCoverage(query, list) >= 0.5;
    let answered = false;
    const noting = (p: Promise<SearchResult[]>) =>
        p.then((r) => {
            if (isGood(r)) answered = true;
            return r;
        });
    // Claude's search is paid (a Haiku call per search) and slow: it starts only when no
    // engine has a good answer by then (Parallel usually has one in ~1s).
    let claudeSkipped = false;
    const claudeLater = new Promise<void>((r) => setTimeout(r, CLAUDE_DELAY_MS)).then(() => {
        if (!answered) return searchClaudeLite(query);
        claudeSkipped = true;
        return [] as SearchResult[];
    });
    const { lists, finished } = await gatherWithGrace(
        [
            noting(searchParallelLite(query)),
            claudeLater,
            noting(searchTavilyLite(query)),
            noting(searchExaLite(query)),
            noting(searchBraveLite(query)),
            noting(searchDDGLite(query)),
            noting(searchBingLite(query)),
        ],
        isGood,
        SLOW_ENGINE_GRACE_MS,
    );
    const used = names.filter((_, i) => lists[i].length > 0);
    return {
        results: mergeAndRank(query, lists),
        engine: used.join(",") || "none",
        empty: names.filter((n, i) => finished[i] && lists[i].length === 0 && !(n === "claude" && claudeSkipped)),
    };
}

// ── Tool Definition ───────────────────────────

export const webSearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "web_search",
            description:
                "Search the web for information. Uses multiple search engines with automatic fallback. Returns top results with titles, snippets, and URLs. This is a FAST, lightweight search — no browser is launched.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    num_results: { type: "number", description: "Number of results (default 5, max 15)" },
                },
                required: ["query"],
            },
        },
    },

    async handler(input) {
        const query = input.query as string;
        const numResults = Math.min((input.num_results as number) || 5, 15);

        try {
            const { results, engine, empty } = await lightweightSearch(query);
            const capped = results.slice(0, numResults);
            const offTopic = capped.length > 0 && terms(query).length >= 2 && bestCoverage(query, capped) < 0.5;

            return JSON.stringify({
                success: true,
                query,
                engine_used: engine,
                ...(empty.length ? { engines_without_results: empty } : {}),
                ...(offTopic
                    ? {
                          note: "These results barely match the query (search engines may be limiting automated requests). Don't rely on them: try a more specific query, or search in the browser.",
                      }
                    : {}),
                results: capped,
                count: capped.length,
            });
        } catch (err) {
            return JSON.stringify({ error: `Search failed: ${(err as Error).message}` });
        }
    },
};
