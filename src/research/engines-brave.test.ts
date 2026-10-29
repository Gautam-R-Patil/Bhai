// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Each Brave result's snippet must come from its OWN result block. The old code
// scanned snippet blocks and links as two independent arrays and paired them by
// index, so a non-result link before the results shifted every snippet.
import { describe, expect, it } from "vitest";
import { parseBraveResults } from "./engines.js";

describe("parseBraveResults", () => {
    it("pairs each snippet with its own link (not misaligned by a leading nav link)", () => {
        const html = `
            <nav><a href="https://nav.example.com/login">Sign in to your account here</a></nav>
            <div class="snippet"><a href="https://first.example/page">First Result Title Here</a>
                <p>Snippet describing the ALPHA first result in detail.</p></div>
            <div class="snippet"><a href="https://second.example/page">Second Result Title Here</a>
                <p>Snippet describing the BETA second result in detail.</p></div>`;

        const results = parseBraveResults(html);
        const first = results.find((r) => r.url === "https://first.example/page");
        const second = results.find((r) => r.url === "https://second.example/page");

        expect(first?.snippet).toContain("ALPHA");
        expect(second?.snippet).toContain("BETA");
        // The nav link is not a snippet block, so it is not emitted as a result.
        expect(results.some((r) => r.url === "https://nav.example.com/login")).toBe(false);
    });

    it("drops Brave's own links by hostname, not by substring", () => {
        const html = `
            <div class="snippet"><a href="https://search.brave.com/settings">Brave Search Settings Page</a>
                <p>Internal Brave page that must not be emitted.</p></div>
            <div class="snippet"><a href="https://example.com/?ref=brave.com">External Result Title Here</a>
                <p>An external page that merely mentions brave.com in its query.</p></div>`;

        expect(parseBraveResults(html).map((r) => r.url)).toEqual(["https://example.com/?ref=brave.com"]);
    });
});
