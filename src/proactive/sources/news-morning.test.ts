import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/news-fetch.js", () => ({
    fetchNews: vi.fn(async () => ({
        headlines: [
            { title: "AI breakthrough announced", score: 0.92, index: 0 },
            { title: "Markets open higher", score: 0.7, index: 1 },
        ],
    })),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { makeNewsMorningSource } from "./news-morning.js";

const mockLlm = {} as any;
const mockWebSearch = vi.fn(async () => "news result");

describe("news-morning source", () => {
    const source = makeNewsMorningSource({ llm: mockLlm, webSearch: mockWebSearch });

    beforeEach(() => vi.clearAllMocks());

    it("emits news_today intent when headlines available", async () => {
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("news_today");
        expect(intents[0].source).toBe("news_morning");
        expect(intents[0].urgency).toBe("ambient");
        expect((intents[0].payload.headlines as unknown[]).length).toBe(2);
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no headlines", async () => {
        const fetchMod = await import("./_shared/news-fetch.js");
        (fetchMod.fetchNews as any).mockResolvedValueOnce({ headlines: [] });
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
