// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Semantic Scholar and arXiv must back off on timeout/network error/non-ok like
// every other engine — otherwise a dead endpoint is re-queried (and blocks each
// academic round on its 12s timeout) forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __isEngineAvailable, resetEngineHealth, searchArxiv, searchSemanticScholar } from "./engines.js";

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
