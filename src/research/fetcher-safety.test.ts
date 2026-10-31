// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Fetcher must: cap the raw body (gzip/size-bomb OOM), not hang on quadratic
// HTML-strip regexes (ReDoS), and decode the declared charset (not force UTF-8).
import { describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_PER_PAGE } from "./profiles.js";
import { tagsToText as _tagsToText } from "./fetcher.js";

let nextResponse: () => Response;
vi.mock("../security/url-safety.js", () => ({
    isAlwaysBlockedUrl: () => false,
    isSafeUrl: async () => ({ safe: true }),
    fetchWithRedirectGuard: async () => ({ response: nextResponse() }),
}));

let pdfParses = 0;
vi.mock("../documents/ingest.js", () => ({ extractText: async () => { pdfParses++; return ""; } }));

const { fetchPages, fetchPageContent } = await import("./fetcher.js");

describe("fetcher response-body safety", () => {
    it("caps a huge body by cancelling the stream early (no OOM)", async () => {
        let pulled = 0;
        const chunk = new Uint8Array(64 * 1024).fill(0x61); // 64KB of 'a'
        nextResponse = () =>
            new Response(
                new ReadableStream({
                    pull(controller) {
                        if (pulled >= 100) {
                            controller.close();
                            return;
                        } // 6.4MB total
                        pulled++;
                        controller.enqueue(chunk.slice());
                    },
                }),
                { headers: { "content-type": "text/html" } },
            );

        const [page] = await fetchPages([{ url: "https://x.com/a", title: "A" }]);
        // We must stop long before draining all 100 chunks (cap ~2MB ≈ 32 chunks).
        expect(pulled).toBeLessThan(50);
        expect(page.content.length).toBeLessThanOrEqual(MAX_CONTENT_PER_PAGE);
    });

    it("does not hang on many unclosed <script> tags (ReDoS)", async () => {
        const body = "<p>Hello world real content here for the test padding</p>" + "<script ".repeat(300_000); // ~2.4MB, no closing tags
        nextResponse = () => new Response(body, { headers: { "content-type": "text/html" } });

        const start = Date.now();
        const [page] = await fetchPages([{ url: "https://x.com/b", title: "B" }]);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2000);
        expect(page.content).toContain("Hello world");
        expect(page.content).not.toContain("<script");
    });

    it("decodes the declared charset instead of assuming UTF-8", async () => {
        // Latin-1 bytes: 0xE9 = 'é'. As UTF-8 these are invalid → U+FFFD.
        const body = new Uint8Array([
            ...Buffer.from("<html><body><p>caf", "latin1"),
            0xe9,
            ...Buffer.from(" r", "latin1"),
            0xe9,
            ...Buffer.from("sum", "latin1"),
            0xe9,
            ...Buffer.from("</p></body></html>", "latin1"),
        ]);
        nextResponse = () => new Response(body, { headers: { "content-type": "text/html; charset=ISO-8859-1" } });

        const [page] = await fetchPages([{ url: "https://x.com/c", title: "C" }]);
        expect(page.content).toContain("café");
        expect(page.content).toContain("résumé");
        expect(page.content).not.toContain("�");
    });
});

describe("fetch retries", () => {
    const calls = async (status: number) => {
        let n = 0;
        nextResponse = () => {
            n++;
            return new Response("x", { status, headers: { "content-type": "text/html" } });
        };
        expect(await fetchPageContent("https://x.com/r")).toBe("");
        return n;
    };
    it("gives up at once on a 4xx but retries 5xx and 429", async () => {
        expect(await calls(404)).toBe(1);
        expect(await calls(503)).toBe(3);
        expect(await calls(429)).toBe(3);
    });

    it("downloads and parses a PDF that yields no text only once", async () => {
        let n = 0;
        nextResponse = () => {
            n++;
            return new Response("%PDF-1.4 scanned", { headers: { "content-type": "application/pdf" } });
        };
        pdfParses = 0;
        expect(await fetchPageContent("https://x.com/scan.pdf")).toBe("");
        expect([n, pdfParses]).toEqual([1, 1]);
    });
});

describe("tagsToText — linear, ReDoS-proof HTML→text", () => {
    it("converts normal HTML to markdownish text", () => {
        const html = "<h1>Title</h1><p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul><h4>Sub</h4>line<br>next";
        const t = _tagsToText(html).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        expect(t).toContain("## Title");
        expect(t).toContain("Hello world");
        expect(t).toContain("- one");
        expect(t).toContain("- two");
        expect(t).toContain("### Sub");
        expect(t).toContain("next");
    });
    it("does not catastrophically backtrack on unclosed-tag spam", () => {
        const bomb = "<h1 ".repeat(500000); // 2MB of '<h1 ' with no '>'
        const t0 = Date.now();
        const out = _tagsToText(bomb);
        expect(Date.now() - t0).toBeLessThan(1000); // was minutes with the old regex chain
        expect(out).not.toContain("<h1");
    });
    it("drops the remainder after an unclosed '<' like the block stripper", () => {
        expect(_tagsToText("before<h1 no close here")).toBe("before");
    });
});

describe("fetched page text", () => {
    const page = async (body: string, type: string) => {
        nextResponse = () => new Response(body, { headers: { "content-type": type } });
        return (await fetchPages([{ url: `https://x.com/${Math.random()}`, title: "T" }]))[0].content;
    };

    it("keeps offsets right after characters that lowercase longer (İ)", async () => {
        const text = await page(`<p>${"İstanbul ".repeat(5)}</p><script>var secret = 1;</script><p>after the script</p>`, "text/html");
        expect(text).toContain("after the script");
        expect(text).not.toContain("secret");
    });

    it("leaves plain text alone and accepts Text/HTML and XHTML", async () => {
        expect(await page("x < 10 and y > 5", "text/plain; charset=utf-8")).toBe("x < 10 and y > 5");
        expect(await page("<p>Hello upper</p>", "Text/HTML")).toContain("Hello upper");
        expect(await page("<p>Hello xhtml</p>", "application/xhtml+xml")).toContain("Hello xhtml");
    });

    it("reads JSON, feeds, CSV and Markdown as text; names a missing content type", async () => {
        expect(await page('{"tag_name":"v1.2.0"}', "application/json; charset=utf-8")).toBe('{"tag_name":"v1.2.0"}');
        expect(await page("<rss><item>news</item></rss>", "application/rss+xml")).toContain("<item>news</item>");
        expect(await page("a,b\n1,2", "text/csv")).toBe("a,b\n1,2");
        expect(await page("# Title", "text/markdown")).toBe("# Title");
        expect(await page("<svg/>", "image/svg+xml")).toBe("[Non-text content: image/svg+xml]");
        expect(await page("??", "")).toBe("[Non-text content: unknown type]");
    });

    it("drops whole comments and decodes numeric entities", async () => {
        const text = await page("<p>kept</p><!-- <div>old > markup</div> --><p>it&#8217;s &mdash; &#x1F600;</p>", "text/html");
        expect(text).not.toContain("markup");
        expect(text).toContain("it’s — 😀");
    });
});

describe("web_asset_download body cap", () => {
    it("stops reading a body without Content-Length once it passes max_bytes", async () => {
        const { webAssetDownload } = await import("../tools/coding/web-asset-download.js");
        let pulled = 0;
        nextResponse = () =>
            new Response(
                new ReadableStream({
                    pull(c) {
                        pulled++;
                        c.enqueue(new Uint8Array(512)); // never closes
                    },
                }),
                { headers: { "content-type": "image/png" } },
            );
        const os = await import("node:os");
        const out = JSON.parse(
            await webAssetDownload.handler({
                url: "https://x.com/a.png",
                dest_path: `${os.tmpdir()}/bhai-cap-${Date.now()}.png`,
                max_bytes: 1024,
            }),
        );
        expect(out.error).toMatch(/too large/);
        expect(pulled).toBeLessThan(10);
    });
});
