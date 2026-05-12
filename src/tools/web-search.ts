// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";
import { getSessionToken } from "../session.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Web Search Tool ───────────────────────────
// Lightweight, fetch-only search. NO Playwright, NO headless browser.
// Uses DuckDuckGo Lite + Brave as fast fallbacks via plain HTTP.
// This is completely independent from deep-research.ts.

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

const USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

function randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── DuckDuckGo Lite (fastest, lightest) ───────

async function searchDDGLite(query: string): Promise<SearchResult[]> {
    try {
        const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
            headers: { "User-Agent": randomUA() },
            redirect: "follow",
            signal: controller.signal,
        });
        clearTimeout(timeout);

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
            snippets.push(
                match[1]
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim(),
            );
        }

        let i = 0;
        while ((match = linkPattern.exec(html)) !== null && results.length < 15) {
            let resultUrl = match[1];
            const title = match[2].replace(/<[^>]+>/g, "").trim();

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
                const title = match[2].replace(/<[^>]+>/g, "").trim();
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
            headers: {
                "User-Agent": randomUA(),
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.status !== 200) return [];

        const html = await response.text();
        if (html.includes("captcha") || html.includes("rate limit")) return [];

        const snippetPattern = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const results: SearchResult[] = [];
        const seenUrls = new Set<string>();

        let match;
        while ((match = snippetPattern.exec(html)) !== null && results.length < 15) {
            const url = match[1];
            const content = match[2];

            const titleMatch = content.match(/<div[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            const title = titleMatch
                ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
                : content.replace(/<[^>]+>/g, "").trim();

            if (url.startsWith("http") && !url.includes("brave.com") && title.length > 5 && !seenUrls.has(url)) {
                seenUrls.add(url);

                const afterLink = html.substring(match.index + match[0].length, match.index + match[0].length + 1500);
                const snippetMatch = afterLink.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                const snippet = snippetMatch
                    ? snippetMatch[1]
                          .replace(/<[^>]+>/g, "")
                          .replace(/\s+/g, " ")
                          .trim()
                    : "";

                if (snippet.length > 10) {
                    results.push({ url, title, snippet: snippet.substring(0, 300) });
                }
            }
        }

        return results;
    } catch {
        return [];
    }
}

// ── Google via fetch (no JS rendering, works for simple queries) ──

async function searchGoogleLite(query: string): Promise<SearchResult[]> {
    try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
            headers: {
                "User-Agent": randomUA(),
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.status !== 200) return [];

        const html = await response.text();
        if (html.includes("detected unusual traffic") || html.includes("sorry/index")) return [];

        const results: SearchResult[] = [];
        const seenUrls = new Set<string>();

        // Match Google result links with h3 titles
        const resultPattern = /<a\s+href="\/url\?q=(https?:\/\/[^&"]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
        let match;
        while ((match = resultPattern.exec(html)) !== null && results.length < 15) {
            const resultUrl = decodeURIComponent(match[1]);
            const title = match[2].replace(/<[^>]+>/g, "").trim();
            if (!seenUrls.has(resultUrl) && !resultUrl.includes("google.com")) {
                seenUrls.add(resultUrl);
                results.push({ url: resultUrl, title, snippet: "" });
            }
        }

        return results;
    } catch {
        return [];
    }
}

// ── Tavily Search (proxied via Convex) ──────

async function searchTavilyLite(query: string): Promise<SearchResult[]> {
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) return [];
        const response = await encryptedFetch(`${getConvexSiteUrl()}/api/search/tavily`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ query, search_depth: "basic", max_results: 10 }),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return [];
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
        if (!response.ok) return [];
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
        const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`, {
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
            const title = h2LinkM[2].replace(/<[^>]+>/g, "").trim();
            if (title.length < 3) continue;

            // Get real URL from cite tag (Bing uses redirect URLs)
            let url = h2LinkM[1];
            const citeM = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
            if (citeM) {
                let citeUrl = citeM[1].replace(/<[^>]+>/g, "").trim();
                if (!citeUrl.startsWith("http")) citeUrl = "https://" + citeUrl;
                citeUrl = citeUrl.split(" ")[0].replace(/›/g, "/").replace(/\/+/g, "/").replace(/:\//g, "://");
                if (citeUrl.startsWith("http")) url = citeUrl;
            }
            if (url.includes("bing.com") || seenUrls.has(url)) continue;
            seenUrls.add(url);

            const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
            const snippet = snippetM
                ? snippetM[1]
                      .replace(/<[^>]+>/g, "")
                      .replace(/&nbsp;/g, " ")
                      .trim()
                : "";
            results.push({ url, title, snippet: snippet.substring(0, 300) });
        }
        return results;
    } catch {
        return [];
    }
}

// ── Lightweight multi-engine (fetch-only, parallel) ───────────

async function lightweightSearch(query: string): Promise<{ results: SearchResult[]; engine: string }> {
    // Fire all lightweight engines in parallel
    const [tavilyResults, exaResults, bingResults, ddgResults, braveResults, googleResults] = await Promise.all([
        searchTavilyLite(query),
        searchExaLite(query),
        searchBingLite(query),
        searchDDGLite(query),
        searchBraveLite(query),
        searchGoogleLite(query),
    ]);

    // Merge and deduplicate, prioritizing AI-optimized engines
    const seenUrls = new Set<string>();
    const merged: SearchResult[] = [];
    const enginesUsed: string[] = [];

    const addResults = (results: SearchResult[], engineName: string) => {
        if (results.length > 0) enginesUsed.push(engineName);
        for (const r of results) {
            if (!seenUrls.has(r.url)) {
                seenUrls.add(r.url);
                merged.push(r);
            }
        }
    };

    addResults(tavilyResults, "tavily");
    addResults(exaResults, "exa");
    addResults(bingResults, "bing");
    addResults(ddgResults, "duckduckgo");
    addResults(braveResults, "brave");
    addResults(googleResults, "google");

    return {
        results: merged,
        engine: enginesUsed[0] || "none",
    };
}

// ── Tool Definition ───────────────────────────

export const webSearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "web_search",
            description:
                "Search the web for information. Uses multiple search engines (Google, Brave, DuckDuckGo) with automatic fallback. Returns top results with titles, snippets, and URLs. This is a FAST, lightweight search — no browser is launched.",
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
            const { results, engine } = await lightweightSearch(query);
            const capped = results.slice(0, numResults);

            return JSON.stringify({
                success: true,
                query,
                engine_used: engine,
                results: capped,
                count: capped.length,
            });
        } catch (err) {
            return JSON.stringify({ error: `Search failed: ${(err as Error).message}` });
        }
    },
};
