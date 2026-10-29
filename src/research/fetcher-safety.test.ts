// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Fetcher must: cap the raw body (gzip/size-bomb OOM), not hang on quadratic
// HTML-strip regexes (ReDoS), and decode the declared charset (not force UTF-8).
import { describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_PER_PAGE } from "./profiles.js";

let nextResponse: () => Response;
vi.mock("../security/url-safety.js", () => ({
    isAlwaysBlockedUrl: () => false,
    isSafeUrl: async () => ({ safe: true }),
    fetchWithRedirectGuard: async () => ({ response: nextResponse() }),
}));

const { fetchPages } = await import("./fetcher.js");

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
