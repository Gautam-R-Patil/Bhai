// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Page fetching with retry, citation extraction, domain scoring

import type { SearchResult } from "./types.js";
import { randomUA, sleep, MAX_CONTENT_PER_PAGE, CONCURRENT_FETCHES } from "./profiles.js";
import { isSafeUrl, isAlwaysBlockedUrl, fetchWithRedirectGuard } from "../security/url-safety.js";

// ── Domain Quality Scoring ───────────────────

// Academic / scientific authority
const HIGH_QUALITY_DOMAINS = new Set([
    "arxiv.org", "nature.com", "science.org", "ieee.org", "acm.org",
    "sciencedirect.com", "springer.com", "wiley.com", "pubmed.ncbi.nlm.nih.gov",
    "pnas.org", "cell.com", "bmj.com", "thelancet.com", "jamanetwork.com",
    "semanticscholar.org",
]);

// Authoritative financial / business / market data — boosted heavily for
// funding/investor/market queries. These are also acceptable for general use.
const FINANCIAL_AUTHORITY_DOMAINS = new Set([
    "pitchbook.com", "crunchbase.com", "cbinsights.com", "sec.gov",
    "bloomberg.com", "reuters.com", "ft.com", "wsj.com", "economist.com",
    "morningstar.com", "spglobal.com", "moodys.com", "fitchratings.com",
    "investor.gov", "edgar.sec.gov",
    // VC firm primary sources
    "a16z.com", "sequoiacap.com", "lightspeedvp.com", "kleinerperkins.com",
    "generalcatalyst.com", "accel.com", "benchmark.com", "founderscircle.com",
    "ycombinator.com", "techstars.com",
    // Trusted tech press for funding announcements
    "techcrunch.com", "theinformation.com", "axios.com", "theverge.com",
    "businesswire.com", "prnewswire.com",
]);

const GOOD_DOMAINS = new Set([
    "github.com", "stackoverflow.com", "docs.google.com", "developer.mozilla.org",
    "microsoft.com", "apple.com", "cloud.google.com", "aws.amazon.com",
]);
const MEDIUM_DOMAINS = new Set([
    "medium.com", "dev.to", "hackernews.com", "news.ycombinator.com",
    "towardsdatascience.com", "blog.google", "openai.com", "anthropic.com",
]);

// Aggregators, content farms, SEO listicles — penalized. Their content is
// usually a synthesis of other sources without primary verification, so any
// numbers or claims they produce should be treated with extreme skepticism.
const LOW_QUALITY_DOMAINS = new Set([
    "investopedia.com", "scribd.com", "slideshare.net", "academia.edu",
    "coursehero.com", "studocu.com", "researchgate.net",
    "answers.com", "quora.com", "reddit.com",
    // SEO content-farm signatures
    "ezinearticles.com", "wikihow.com", "ehow.com",
]);

// Topics where Wikipedia is a poor primary source. Wikipedia is acceptable for
// general definitions/history, but for time-sensitive financial data, current
// market figures, or contact information it should be deprioritized.
const FINANCE_TOPIC_HINTS = /\b(funding|investor|investors|angel|venture|vc|seed|series\s+[a-d]|valuation|raise|ipo|acquisition|m&a|cap table|portfolio|investment|fundraising|crunchbase|pitchbook|deal|round|investors?|investing)\b/i;

export function scoreDomainQuality(url: string, topic?: string): number {
    try {
        const hostname = new URL(url).hostname.replace("www.", "");
        const isFinanceTopic = topic ? FINANCE_TOPIC_HINTS.test(topic) : false;

        // .gov / .edu always max
        if (hostname.endsWith(".edu") || hostname.endsWith(".gov")) return 0.95;
        // Tier 1 — academic
        if (HIGH_QUALITY_DOMAINS.has(hostname) || [...HIGH_QUALITY_DOMAINS].some(d => hostname.endsWith(d))) return 0.9;
        // Tier 1 — financial/business authority (boosted further when topic is finance)
        if (FINANCIAL_AUTHORITY_DOMAINS.has(hostname) || [...FINANCIAL_AUTHORITY_DOMAINS].some(d => hostname.endsWith(d))) {
            return isFinanceTopic ? 0.95 : 0.85;
        }
        // Wikipedia — okay for general topics, deprioritized for finance.
        // Floored at 0.4 even on finance topics so it stays above unknown
        // (0.3) and well above content farms (0.15) — Wikipedia is still a
        // legitimate starting point for "history of venture capital" or
        // "what is an angel investor" definitional queries.
        if (hostname === "wikipedia.org" || hostname.endsWith(".wikipedia.org")) {
            return isFinanceTopic ? 0.4 : 0.6;
        }
        // Tier 2 — vendor/dev docs
        if (GOOD_DOMAINS.has(hostname) || [...GOOD_DOMAINS].some(d => hostname.endsWith(d))) return 0.7;
        // Tier 3 — blog-grade
        if (MEDIUM_DOMAINS.has(hostname) || [...MEDIUM_DOMAINS].some(d => hostname.endsWith(d))) return 0.5;
        // Tier 4 — aggregators/content farms
        if (LOW_QUALITY_DOMAINS.has(hostname) || [...LOW_QUALITY_DOMAINS].some(d => hostname.endsWith(d))) return 0.15;
        // Unknown
        return 0.3;
    } catch { return 0.2; }
}

export function getDomain(url: string): string {
    try { return new URL(url).hostname.replace("www.", ""); } catch { return "unknown"; }
}

// ── Page Content Extraction ──────────────────

// Outbound links from each page's RAW html (the returned content has every tag
// stripped, so no href survives): fetchPages hands them to the citation chain.
const linksByUrl = new Map<string, string[]>();

// Hard cap on raw bytes read per page. Bounds memory against gzip/br "size
// bombs" (undici auto-decompresses, so the 15s abort bounds download time, not
// decompression ratio) and bounds the HTML-strip input. Generous enough to
// still yield the MAX_CONTENT_PER_PAGE of final text.
const MAX_FETCH_BYTES = MAX_CONTENT_PER_PAGE * 40; // ~2MB

// Decode respecting the page's declared charset (response.text() always assumes
// UTF-8, mojibaking Shift_JIS/GB2312/EUC-KR/ISO-8859-1 pages). Falls back to a
// <meta charset> sniff, then UTF-8.
function detectCharset(contentType: string, head: Uint8Array): string {
    const m = contentType.match(/charset=\s*"?([\w:.+-]+)"?/i);
    if (m) return m[1];
    const probe = new TextDecoder("latin1").decode(head.subarray(0, 2048));
    const meta = probe.match(/<meta[^>]+charset=["']?\s*([\w:.+-]+)/i)
        || probe.match(/charset=["']?\s*([\w:.+-]+)/i);
    return meta ? meta[1] : "utf-8";
}

function decodeHtml(buf: Uint8Array, contentType: string): string {
    const charset = detectCharset(contentType, buf);
    try {
        return new TextDecoder(charset, { fatal: false }).decode(buf);
    } catch {
        return new TextDecoder("utf-8", { fatal: false }).decode(buf);
    }
}

// Stream the body and stop (cancelling the reader so undici stops decompressing)
// once we have MAX_FETCH_BYTES. Replaces `await response.text()`, which buffers
// the entire decompressed body before returning.
async function readBodyCapped(response: Response, cap: number): Promise<Uint8Array> {
    const body = response.body;
    if (!body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        return buf.length > cap ? buf.subarray(0, cap) : buf;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < cap) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.length) { chunks.push(value); total += value.length; }
        }
    } finally {
        reader.cancel().catch(() => {}); // stop undici decompressing the rest
    }
    if (chunks.length === 1 && total <= cap) return chunks[0];
    const out = new Uint8Array(Math.min(total, cap));
    let off = 0;
    for (const c of chunks) {
        if (off >= cap) break;
        const n = Math.min(c.length, cap - off);
        out.set(c.subarray(0, n), off);
        off += n;
    }
    return out;
}

// Remove <tag …>…</tag> blocks in a single linear pass per tag (unclosed tags
// are dropped to end-of-string). Native indexOf is O(n); this avoids the O(n²)
// backtracking of a lazy /<tag[\s\S]*?<\/tag>/ regex on a page with many
// unclosed openers (e.g. '<script '.repeat(2e6)), which froze the event loop.
function stripTagBlocks(html: string, tags: string[]): string {
    for (const tag of tags) {
        const lower = html.toLowerCase();
        const openTok = `<${tag}`;
        const closeTok = `</${tag}>`;
        let out = "";
        let i = 0;
        for (;;) {
            const open = lower.indexOf(openTok, i);
            if (open === -1) { out += html.slice(i); break; }
            const nextCh = lower[open + openTok.length] ?? "";
            if (nextCh && !" \t\r\n>/".includes(nextCh)) {
                // Not a real tag boundary (e.g. <scripting>) — keep it, advance.
                out += html.slice(i, open + openTok.length);
                i = open + openTok.length;
                continue;
            }
            out += html.slice(i, open);
            const close = lower.indexOf(closeTok, open + openTok.length);
            if (close === -1) { i = html.length; break; } // unclosed → drop remainder
            i = close + closeTok.length;
        }
        html = out;
    }
    return html;
}

async function fetchPageContentOnce(url: string): Promise<string> {
    // SSRF guard. Attacker-supplied URLs (search results, outbound links) must
    // not reach private/loopback/metadata targets. Fail-open: research continues.
    if (isAlwaysBlockedUrl(url) || !(await isSafeUrl(url)).safe) return "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const guarded = await fetchWithRedirectGuard(
            url,
            {
                headers: {
                    "User-Agent": randomUA(),
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
                signal: controller.signal,
            },
        );
        if ("error" in guarded) { clearTimeout(timeout); return ""; }
        const response = guarded.response;

        // Don't clear the timeout yet — it should also cover response.text()
        if (!response.ok) { clearTimeout(timeout); return ""; }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
            clearTimeout(timeout);
            return `[Non-text content: ${contentType}]`;
        }

        // Byte-capped streaming read + charset-aware decode. Bounds memory
        // (gzip bomb) and truncates BEFORE the strip chain runs.
        const buf = await readBodyCapped(response, MAX_FETCH_BYTES);
        clearTimeout(timeout);
        const html = decodeHtml(buf, contentType);
        linksByUrl.set(url, extractOutboundLinks(html, url));

        const text = stripTagBlocks(html, ["script", "style", "nav", "footer", "header"])
            .replace(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi, "\n## $1\n")
            .replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, "\n### $1\n")
            .replace(/<p[^>]*>/gi, "\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<li[^>]*>/gi, "\n- ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

        return text.substring(0, MAX_CONTENT_PER_PAGE);
    } catch {
        clearTimeout(timeout);
        return "";
    }
}

/** Fetch with 3 retries + exponential backoff */
export async function fetchPageContent(url: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const content = await fetchPageContentOnce(url);
        if (content) return content;
        if (attempt < 2) await sleep(200 * Math.pow(2, attempt)); // 200ms, 400ms
    }
    return "";
}

// ── Extract Outbound Links ───────────────────

export function extractOutboundLinks(html: string, baseUrl: string): string[] {
    const links: string[] = [];
    const seen = new Set<string>();
    const pattern = /href="(https?:\/\/[^"]+)"/gi;
    let match;

    let baseDomain: string;
    try { baseDomain = new URL(baseUrl).hostname; } catch { return []; }

    while ((match = pattern.exec(html)) !== null) {
        const url = match[1].split("#")[0].split("?")[0]; // Strip fragments and query params
        // Normalize for dedup: lowercase hostname, strip trailing slash, strip www.
        let normalized: string;
        try {
            const parsed = new URL(url);
            parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
            normalized = parsed.toString().replace(/\/$/, "");
        } catch { continue; }
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        try {
            const linkDomain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
            // Skip same-domain navigation, javascript, mailto
            if (linkDomain === baseDomain.toLowerCase().replace(/^www\./, "")) continue;
            if (url.includes("javascript:") || url.includes("mailto:")) continue;
            // Skip obvious non-content URLs
            if (url.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|ttf|pdf)$/i)) continue;

            links.push(url);
        } catch { /* invalid URL */ }
    }

    return links;
}

/** Score and rank outbound links, return top N unvisited */
export function rankOutboundLinks(
    links: string[],
    visitedUrls: Set<string>,
    maxLinks: number,
    topic?: string,
): string[] {
    return links
        .filter(url => !visitedUrls.has(url))
        .map(url => ({ url, score: scoreDomainQuality(url, topic) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxLinks)
        .map(l => l.url);
}

// ── Batch Fetch Pages ────────────────────────

export async function fetchPages(
    urls: Array<{ url: string; title: string }>,
): Promise<Array<{ url: string; title: string; content: string; links: string[] }>> {
    const results: Array<{ url: string; title: string; content: string; links: string[] }> = [];

    for (let i = 0; i < urls.length; i += CONCURRENT_FETCHES) {
        const batch = urls.slice(i, i + CONCURRENT_FETCHES);
        const batchResults = await Promise.all(
            batch.map(async (item) => {
                const content = await fetchPageContent(item.url);
                const links = linksByUrl.get(item.url) ?? [];
                linksByUrl.delete(item.url);
                return { url: item.url, title: item.title, content, links };
            })
        );
        results.push(...batchResults);
        if (i + CONCURRENT_FETCHES < urls.length) await sleep(400);
    }

    return results;
}
