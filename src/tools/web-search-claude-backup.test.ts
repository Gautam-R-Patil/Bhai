// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Claude's search is paid per call: it runs only when the free engines had no good answer.
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const calls: string[] = [];
let parallelResults: Array<{ url: string; title: string; snippet: string }> = [];
vi.mock("../crypto-transport.js", () => ({
    encryptedFetch: async (url: string) => {
        calls.push(url);
        const engine = url.split("/").pop() ?? "";
        if (engine === "parallel") return new Response(JSON.stringify({ results: parallelResults }), { status: 200 });
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
const claudeCalls = () => calls.filter((u) => u.endsWith("/api/search/claude")).length;

beforeEach(() => {
    calls.length = 0;
});

it("a good free answer means no paid Claude search", async () => {
    parallelResults = [1, 2, 3].map((i) => ({
        url: `https://f1.example/${i}`,
        title: `Formula 1 race winner ${i}`,
        snippet: "latest formula race winner",
    }));
    const out = JSON.parse(await webSearch.handler({ query: "latest formula 1 race winner" }));
    expect(out.results.length).toBe(3);
    expect(claudeCalls()).toBe(0);
    expect(out.engines_without_results ?? []).not.toContain("claude"); // skipped, not empty
});

it("no good free answer: Claude is the backup", async () => {
    parallelResults = [];
    await webSearch.handler({ query: "latest formula 1 race winner" });
    expect(claudeCalls()).toBe(1);
});
