// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Semantic Scholar and arXiv must back off on timeout/network error/non-ok like
// every other engine — otherwise a dead endpoint is re-queried (and blocks each
// academic round on its 12s timeout) forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../session.js", () => ({ getSessionToken: async () => "tok" }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://convex.test" }));
vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async () => new Response("Parallel not configured", { status: 500 }),
}));

import { __isEngineAvailable, multiEngineSearch, resetEngineHealth, searchArxiv, searchSemanticScholar } from "./engines.js";

beforeEach(() => resetEngineHealth());
afterEach(() => vi.unstubAllGlobals());

describe("academic engine backoff", () => {
    it("semantic_scholar backs off after a network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
        expect(__isEngineAvailable("semantic_scholar")).toBe(true);
        await searchSemanticScholar("q");
        expect(__isEngineAvailable("semantic_scholar")).toBe(false);
    });

    it("semantic_scholar backs off on a non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
        await searchSemanticScholar("q");
        expect(__isEngineAvailable("semantic_scholar")).toBe(false);
    });

    it("arxiv backs off after a network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
        await searchArxiv("q");
        expect(__isEngineAvailable("arxiv")).toBe(false);
    });

    it("arxiv backs off on a non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
        await searchArxiv("q");
        expect(__isEngineAvailable("arxiv")).toBe(false);
    });

    it("stops re-fetching once backing off", async () => {
        const f = vi.fn().mockRejectedValue(new Error("fetch failed"));
        vi.stubGlobal("fetch", f);
        await searchSemanticScholar("q");
        await searchSemanticScholar("q"); // should short-circuit via isAvailable()
        expect(f).toHaveBeenCalledTimes(1);
    });
});

describe("parallel (primary engine)", () => {
    it("stops asking once the server says it isn't configured", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
        await multiEngineSearch("q");
        resetEngineHealth(); // a new research run: still not configured
        expect(__isEngineAvailable("parallel")).toBe(false);
    });
});

describe("brave (scraper tier)", () => {
    it("keeps results from a normal page that mentions captcha in its toggle", async () => {
        const html = `<button>Switch to traditional captcha</button>
            <div class="snippet"><a href="https://real.example/article">A Real Result Title Here</a>
                <p>Snippet describing the real result in some detail.</p></div>`;
        vi.stubGlobal("fetch", vi.fn(async (url: string) =>
            String(url).startsWith("https://search.brave.com/") ? new Response(html, { status: 200 }) : Promise.reject(new Error("fetch failed"))));
        const { results } = await multiEngineSearch("q");
        expect(results.map((r) => r.url)).toContain("https://real.example/article");
        expect(__isEngineAvailable("brave")).toBe(true);
    });
});
