// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { canonicalUrl, decodeBingUrl, htmlText, mergeAndRank } from "./web-search.js";

const r = (title: string, url: string, snippet = "") => ({ title, url, snippet });

describe("web search ranking", () => {
    it("real results beat the dictionary and fashion pages that matched one word (the earphones query)", () => {
        const bing = [
            r("BEST Definition & Meaning - Merriam-Webster", "https://www.merriam-webster.com/dictionary/best"),
            r("BEST | English meaning - Cambridge Dictionary", "https://dictionary.cambridge.org/dictionary/english/best"),
            r("Tops for Women - Buy Tops Online - Myntra", "https://www.myntra.com/tops"),
            r("Best Earphones Under 5000 in India (2026)", "https://www.smartprix.com/bytes/best-earphones-under-5000", "Top wireless earbuds under ₹5,000"),
        ];
        const ddg = [
            r("10 Best TWS Earbuds Under Rs 5000", "https://www.91mobiles.com/list/best-earbuds-under-5000", "earbuds with ANC under 5000 in India"),
            r("Nothing Ear (a) review", "https://www.gsmarena.com/nothing_ear_a-review.php", "earbuds review"),
        ];
        const out = mergeAndRank("best earphones under ₹5000 India", [[], bing, ddg]).map((x) => x.url);
        expect(out[0]).toContain("smartprix");
        expect(out).not.toContain("https://www.merriam-webster.com/dictionary/best");
        expect(out).not.toContain("https://www.myntra.com/tops");
    });

    it("interleaves engines instead of letting the first one take every slot", () => {
        const a = [r("alpha one", "https://a.com/1"), r("alpha two", "https://a.com/2")];
        const b = [r("alpha three", "https://b.com/1")];
        expect(mergeAndRank("alpha", [a, b]).map((x) => x.url)).toEqual(["https://a.com/1", "https://b.com/1", "https://a.com/2"]);
    });

    it("never returns nothing just because no result shares a word", () => {
        expect(mergeAndRank("zzzz qqqq", [[r("x", "https://x.com")]])).toHaveLength(1);
    });

    it("decodes the real URL out of a Bing redirect link", () => {
        const target = "https://www.smartprix.com/bytes/best-earphones-under-5000";
        const enc = Buffer.from(target).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        expect(decodeBingUrl(`https://www.bing.com/ck/a?!&&p=abc&u=a1${enc}&ntb=1`)).toBe(target);
        expect(decodeBingUrl("https://example.com/page")).toBe("https://example.com/page");
    });
});

describe("canonicalUrl — dedup key", () => {
    it("treats http/https, www., a trailing slash and a #fragment as the same page", () => {
        const k = canonicalUrl("https://www.example.com/page/");
        expect(canonicalUrl("http://example.com/page")).toBe(k);
        expect(canonicalUrl("https://example.com/page#section")).toBe(k);
        expect(canonicalUrl("https://www.example.com/page")).toBe(k);
    });
    it("drops tracking params but keeps and sorts meaningful ones", () => {
        expect(canonicalUrl("https://x.com/p?utm_source=ig&fbclid=abc")).toBe(canonicalUrl("https://x.com/p"));
        expect(canonicalUrl("https://x.com/p?b=2&a=1")).toBe(canonicalUrl("https://x.com/p?a=1&b=2"));
        // a genuinely different page (different id) stays different
        expect(canonicalUrl("https://x.com/p?id=5")).not.toBe(canonicalUrl("https://x.com/p?id=6"));
    });
    it("falls back to the raw string for a non-URL", () => {
        expect(canonicalUrl("not a url")).toBe("not a url");
    });
});

describe("web search dedup across engines", () => {
    const r = (title: string, url: string, snippet = "") => ({ title, url, snippet });
    it("collapses the same page arriving from two engines with different URL forms", () => {
        const a = [r("GSMArena review", "https://www.gsmarena.com/nothing_ear_a-review.php?utm_source=ig")];
        const b = [r("GSMArena review", "http://gsmarena.com/nothing_ear_a-review.php/")];
        const out = mergeAndRank("nothing ear review", [a, b]);
        expect(out).toHaveLength(1);
        // the first (higher-ranked engine's) URL is the one kept and shown
        expect(out[0].url).toBe("https://www.gsmarena.com/nothing_ear_a-review.php?utm_source=ig");
    });
});

describe("htmlText", () => {
    it("decodes entities and drops tags from scraped titles and snippets", () => {
        expect(htmlText("Tom &amp; Jerry &#8211; it&#39;s &quot;back&quot;&nbsp;now")).toBe(
            'Tom & Jerry – it\'s "back" now',
        );
        expect(htmlText("caf&#xE9; &lt;3")).toBe("café <3");
        expect(htmlText("<div>Best</div><div>phones</div>")).toBe("Best phones");
    });
    it("keeps a bolded word whole and leaves unknown entities alone", () => {
        expect(htmlText("Apple <b>iPhone</b>s compared")).toBe("Apple iPhones compared");
        expect(htmlText("a &bogus; b &#0; c")).toBe("a &bogus; b &#0; c");
    });
});
