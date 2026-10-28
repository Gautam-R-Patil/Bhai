// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { decodeBingUrl, mergeAndRank } from "./web-search.js";

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
