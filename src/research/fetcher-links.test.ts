// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Deep research follows citation chains from each page's outbound links. They
// must come from the raw HTML: the page content handed back has its tags stripped.
import { describe, expect, it, vi } from "vitest";

const html = `<html><body><p>See <a href="https://www.nature.com/articles/x1">Nature</a> and
  <a href="https://arxiv.org/abs/2401.00001">arXiv</a>, <a href="https://who.int/report.pdf">a report</a>, plus <a href="https://blog.example.com/about">about</a>.</p>
  ${"<p>filler text for length</p>".repeat(20)}</body></html>`;

vi.mock("../security/url-safety.js", () => ({
    isAlwaysBlockedUrl: () => false,
    isSafeUrl: async () => ({ safe: true }),
    fetchWithRedirectGuard: async () => ({ response: new Response(html, { headers: { "content-type": "text/html" } }) }),
}));

const { fetchPages } = await import("./fetcher.js");

describe("citation links", () => {
    it("fetchPages returns outbound links from the raw HTML", async () => {
        const [page] = await fetchPages([{ url: "https://blog.example.com/post", title: "Post" }]);
        expect(page.content).not.toContain("href");
        expect(page.links).toEqual(["https://www.nature.com/articles/x1", "https://arxiv.org/abs/2401.00001", "https://who.int/report.pdf"]);
    });
});
