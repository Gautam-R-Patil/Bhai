// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./keys.js", () => ({ getConvexSiteUrl: () => "https://x.convex.site" }));
vi.mock("../session.js", () => ({
    getSessionToken: vi.fn(async () => "tok"),
    handleAuthError: vi.fn(async () => "tok"),
}));
vi.mock("../crypto-transport.js", () => ({ encryptedFetch: vi.fn() }));

import { encryptedFetch } from "../crypto-transport.js";
import { fetchSystemPrompt, invalidateSystemPromptCache } from "./system-prompts.js";

const mockFetch = encryptedFetch as unknown as ReturnType<typeof vi.fn>;
const resp = (content: string) => ({ ok: true, status: 200, json: async () => ({ slug: "x", content, version: 1 }) });

describe("fetchSystemPrompt — TTL + stale fallback", () => {
    beforeEach(() => {
        invalidateSystemPromptCache();
        mockFetch.mockReset();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    it("serves from cache within the TTL, then re-fetches a re-seeded prompt after it", async () => {
        mockFetch.mockResolvedValueOnce(resp("v1"));
        expect(await fetchSystemPrompt("x")).toBe("v1");
        expect(await fetchSystemPrompt("x")).toBe("v1"); // within TTL → cached
        expect(mockFetch).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-01-01T02:00:00Z")); // past the 60-min TTL
        mockFetch.mockResolvedValueOnce(resp("v2"));
        expect(await fetchSystemPrompt("x")).toBe("v2"); // picks up the re-seed, no restart
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("keeps the stale copy when a post-TTL re-fetch fails — never drops to empty mid-session", async () => {
        mockFetch.mockResolvedValueOnce(resp("v1"));
        expect(await fetchSystemPrompt("x")).toBe("v1");

        vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
        mockFetch.mockRejectedValueOnce(new Error("network down"));
        expect(await fetchSystemPrompt("x")).toBe("v1"); // stale, not ""
    });

    it("a 503 after the TTL also keeps the stale copy", async () => {
        mockFetch.mockResolvedValueOnce(resp("v1"));
        await fetchSystemPrompt("x");
        vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
        expect(await fetchSystemPrompt("x")).toBe("v1");
    });
});
