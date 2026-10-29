// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./action-cache.js";

describe("action-cache normalizeUrl — the replay key", () => {
    it("maps www and bare host to the same key so the sequence replays on both", () => {
        expect(normalizeUrl("https://www.zomato.com/login")).toBe(normalizeUrl("https://zomato.com/login"));
        expect(normalizeUrl("https://www.zomato.com/login")).toBe("zomato.com/login");
    });
    it("ignores query params, hash and a trailing slash (same page structure)", () => {
        const base = normalizeUrl("https://site.com/cart");
        expect(normalizeUrl("https://site.com/cart?ref=abc")).toBe(base);
        expect(normalizeUrl("https://site.com/cart#top")).toBe(base);
        expect(normalizeUrl("https://site.com/cart/")).toBe(base);
    });
    it("keeps distinct pages distinct and preserves root", () => {
        expect(normalizeUrl("https://site.com/a")).not.toBe(normalizeUrl("https://site.com/b"));
        expect(normalizeUrl("https://site.com/")).toBe("site.com/");
    });
    it("falls back to the raw string for a non-URL", () => {
        expect(normalizeUrl("not a url")).toBe("not a url");
    });
});
