// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// A scraped engine that refuses us (Brave 429, DuckDuckGo's 202 bot check) is skipped, not asked on every search.
import { afterAll, expect, it, vi } from "vitest";

vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
}));
vi.mock("../session.js", () => ({ getSessionToken: async () => "token" }));
vi.mock("../config/keys.js", () => ({ getConvexSiteUrl: () => "https://backend.example" }));
vi.mock("../location/index.js", () => ({ getLocation: () => null }));
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("search.brave.com")) return new Response("Too many requests", { status: 429 });
    if (url.includes("duckduckgo.com")) return new Response("", { status: 202 });
    return new Response("", { status: 200 });
}) as typeof fetch;
afterAll(() => {
    globalThis.fetch = realFetch;
});

const { webSearch } = await import("./web-search.js");

it("asks a refusing engine once, then skips it", async () => {
    await webSearch.handler({ query: "first query" });
    await webSearch.handler({ query: "second query" });
    expect(calls.filter((u) => u.includes("search.brave.com"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("duckduckgo.com"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("bing.com")).length).toBeGreaterThanOrEqual(2); // others still asked
});
