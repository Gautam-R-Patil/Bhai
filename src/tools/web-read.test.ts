// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// web_read gives the model a page's text instead of curl + grep over raw HTML.
import { describe, expect, it, vi } from "vitest";

const fetchPageContent = vi.fn();
vi.mock("../research/fetcher.js", () => ({ fetchPageContent }));

const { webRead } = await import("./web-search.js");
const run = async (input: Record<string, unknown>) => JSON.parse(await webRead.handler(input) as string);

describe("web_read", () => {
    it("returns the page text, capped", async () => {
        fetchPageContent.mockResolvedValueOnce("x".repeat(20_000));
        const r = await run({ url: "https://nodejs.org/en/about/previous-releases" });
        expect(r).toMatchObject({ success: true, truncated: true, total_chars: 20_000 });
        expect(r.text).toHaveLength(12_000);
    });

    it("refuses non-http URLs before fetching", async () => {
        fetchPageContent.mockClear();
        expect((await run({ url: "file:///etc/passwd" })).error).toMatch(/http/);
        expect(fetchPageContent).not.toHaveBeenCalled();
    });

    it("an unreadable page says to use the browser", async () => {
        fetchPageContent.mockResolvedValueOnce("");
        const r = await run({ url: "http://169.254.169.254/latest/meta-data" });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/browser_navigate/);
    });

    it("an image or archive is a failure, not page text", async () => {
        fetchPageContent.mockResolvedValueOnce("[Non-text content: image/png]");
        const r = await run({ url: "https://example.com/logo.png" });
        expect(r).toMatchObject({ success: false });
        expect(r.error).toMatch(/image\/png/);
    });
});
