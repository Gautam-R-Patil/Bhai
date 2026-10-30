// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// An engine the server says isn't configured is skipped, not asked again on every search.
import { afterAll, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async (url: string) => {
        calls.push(url);
        const engine = url.split("/").pop() ?? "";
        if (engine === "tavily" || engine === "exa")
            return new Response(JSON.stringify({ error: `${engine} not configured` }), { status: 500 });
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
}));
vi.mock("../session.js", () => ({ getSessionToken: async () => "token" }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://backend.example" }));
vi.mock("../location/index.js", () => ({ getLocation: () => null }));
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch; // scrapers: no network
afterAll(() => {
    globalThis.fetch = realFetch;
});

const { webSearch } = await import("./web-search.js");

it("asks an unconfigured engine once, then skips it", async () => {
    await webSearch.handler({ query: "first query" });
    await webSearch.handler({ query: "second query" });
    expect(calls.filter((u) => u.endsWith("/api/search/tavily"))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith("/api/search/exa"))).toHaveLength(1);
});
