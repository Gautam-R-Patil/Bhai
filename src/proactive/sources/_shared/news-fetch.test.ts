// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../location/index.js", () => ({
    getLocation: vi.fn(() => ({ city: "Bangalore", region: "Karnataka", country: "IN" })),
}));

vi.mock("./interest-vector.js", () => ({
    getInterestVector: vi.fn(async () => ({
        vector: [0.1, 0.2, 0.3, 0.4],
        keywords: ["typescript", "machine-learning"],
        builtAt: Date.now(),
    })),
}));

vi.mock("../../../memory/embeddings.js", () => ({
    embedText: vi.fn(async (_text: string) => {
        const arr = new Float32Array(4);
        arr[0] = 0.1; arr[1] = 0.2; arr[2] = 0.3; arr[3] = 0.4;
        return arr;
    }),
}));

vi.mock("../../../../native/index.js", () => ({
    newsScoreHeadlines: vi.fn((headlines: string[], _interest: number[], _embeddings: number[][]) =>
        headlines.map((title, index) => ({ title, score: 1 - index * 0.1, index }))
    ),
}));

import { fetchNews, _resetNewsCache, type NewsFetchDeps } from "./news-fetch.js";
import { getLocation } from "../../../location/index.js";
import { getInterestVector } from "./interest-vector.js";
import * as native from "../../../../native/index.js";

function makeMockLlm(headlines: string[]) {
    return {
        chat: vi.fn(async () => ({
            choices: [{ message: { content: JSON.stringify({ headlines }) } }],
        })),
        config: {},
    } as any;
}

describe("news-fetch", () => {
    beforeEach(() => {
        _resetNewsCache();
        vi.mocked(getLocation).mockReturnValue({ city: "Bangalore", region: "Karnataka", country: "IN" } as any);
        vi.mocked(getInterestVector).mockResolvedValue({
            vector: [0.1, 0.2, 0.3, 0.4],
            keywords: ["typescript", "machine-learning"],
            builtAt: Date.now(),
        });
        vi.mocked(native.newsScoreHeadlines).mockClear();
        vi.mocked(native.newsScoreHeadlines).mockImplementation(
            (headlines: string[], _: number[], __: number[][]) =>
                headlines.map((title, index) => ({ title, score: 1 - index * 0.1, index }))
        );
    });

    it("returns empty when llm is null", async () => {
        const result = await fetchNews({ llm: null, webSearch: vi.fn(async () => "") });
        expect(result.headlines).toHaveLength(0);
    });

    it("returns scored headlines from LLM extraction", async () => {
        const deps: NewsFetchDeps = {
            llm: makeMockLlm(["TypeScript 6 released", "AI beats chess champion", "Bangalore rain forecast"]),
            webSearch: vi.fn(async () => "search results"),
        };
        const result = await fetchNews(deps);
        expect(result.headlines.length).toBeLessThanOrEqual(3);
        expect(result.headlines[0]).toHaveProperty("title");
        expect(result.headlines[0]).toHaveProperty("score");
        expect(result.headlines[0]).toHaveProperty("index");
    });

    it("caches within TTL for same location+interest key", async () => {
        const llm = makeMockLlm(["Headline 1", "Headline 2"]);
        const deps: NewsFetchDeps = {
            llm,
            webSearch: vi.fn(async () => "search results"),
        };
        await fetchNews(deps);
        await fetchNews(deps);
        expect(llm.chat).toHaveBeenCalledTimes(1);
    });

    it("calls two webSearch queries (interest-based + local)", async () => {
        const webSearch = vi.fn(async () => "search results");
        const deps: NewsFetchDeps = {
            llm: makeMockLlm(["Headline 1"]),
            webSearch,
        };
        await fetchNews(deps);
        expect(webSearch).toHaveBeenCalledTimes(2);
        const calls = (webSearch.mock.calls as unknown as Array<[string]>).map(c => c[0]);
        expect(calls.some(q => q.includes("typescript") || q.includes("machine-learning"))).toBe(true);
        expect(calls.some(q => q.includes("Bangalore") || q.includes("today"))).toBe(true);
    });

    it("handles webSearch failures gracefully", async () => {
        const deps: NewsFetchDeps = {
            llm: makeMockLlm(["Fallback headline"]),
            webSearch: vi.fn(async () => { throw new Error("network"); }),
        };
        const result = await fetchNews(deps);
        // Should proceed with empty combined text → LLM extracts nothing or returns result
        // Either way, no crash
        expect(Array.isArray(result.headlines)).toBe(true);
    });

    it("passes interest vector and headline embeddings to native scorer", async () => {
        const deps: NewsFetchDeps = {
            llm: makeMockLlm(["TypeScript news"]),
            webSearch: vi.fn(async () => "news data"),
        };
        await fetchNews(deps);
        expect(native.newsScoreHeadlines).toHaveBeenCalledTimes(1);
        expect(native.newsScoreHeadlines).toHaveBeenCalledWith(
            ["TypeScript news"],
            expect.arrayContaining([expect.any(Number)]),
            expect.arrayContaining([expect.arrayContaining([expect.any(Number)])]),
        );
    });

    it("ATLAS_PROACTIVE_NEWS_QUERY overrides interest-derived query", async () => {
        process.env.ATLAS_PROACTIVE_NEWS_QUERY = "AI funding news";
        try {
            const webSearch = vi.fn(async () => "search results");
            const deps: NewsFetchDeps = {
                llm: makeMockLlm(["AI startup raises $100M"]),
                webSearch,
            };
            await fetchNews(deps);
            const calls = (webSearch.mock.calls as unknown as Array<[string]>).map(c => c[0]);
            expect(calls[0]).toBe("AI funding news");
            expect(calls[0]).not.toContain("typescript");
            expect(calls[0]).not.toContain("machine-learning");
        } finally {
            delete process.env.ATLAS_PROACTIVE_NEWS_QUERY;
        }
    });
});
