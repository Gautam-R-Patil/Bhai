// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Dedup must keep ONE representative per cluster — including for exact-duplicate
// texts. The old executor re-filtered originals by `dedupedTexts.includes(text)`,
// which re-admitted every copy of a surviving text (no-op for exact dupes).
import { describe, expect, it } from "vitest";
import { dedupeByText, deduplicateFindings, normalizeUrl, UrlSet } from "./scoring.js";

describe("dedupeByText", () => {
    it("collapses exact-duplicate texts to a single object", () => {
        const findings = [
            { text: "X raised $5M in seed funding", url: "a" },
            { text: "X raised $5M in seed funding", url: "b" }, // exact dup
            { text: "Totally unrelated fact about something else", url: "c" },
        ];
        const kept = dedupeByText(findings, (f) => f.text);
        expect(kept).toHaveLength(2);
        // exactly one of the two duplicate rows survives
        expect(kept.filter((f) => f.text === "X raised $5M in seed funding")).toHaveLength(1);

        // The old value-filter approach would have re-admitted both copies:
        const dedupedTexts = deduplicateFindings(findings.map((f) => f.text));
        const oldBehavior = findings.filter((f) => dedupedTexts.includes(f.text));
        expect(oldBehavior).toHaveLength(3); // the bug
    });

    it("still drops near-duplicates, keeping the longer one", () => {
        const items = [
            { text: "The market grew by twenty percent" },
            { text: "The market grew by twenty percent last year" },
        ];
        const kept = dedupeByText(items, (i) => i.text);
        expect(kept).toHaveLength(1);
        expect(kept[0].text).toContain("last year");
    });
});

describe("non-Latin findings and URL identity", () => {
    it("keeps distinct Hindi and Japanese findings, still collapses true duplicates", () => {
        const items = [
            "भारत में 2025 में इलेक्ट्रिक वाहनों की बिक्री दोगुनी हुई",
            "दिल्ली में मेट्रो का नया रूट अगले साल खुलेगा",
            "東京の人口は二〇二五年に減少した",
            "भारत में 2025 में इलेक्ट्रिक वाहनों की बिक्री दोगुनी हुई",
        ];
        expect(dedupeByText(items, (t) => t)).toHaveLength(3);
    });

    it("one key per page across scheme, www, slash, fragment and tracking params", () => {
        const same = [
            "https://www.example.com/report/?utm_source=x#top",
            "http://example.com/report",
            "https://EXAMPLE.com/report?fbclid=abc",
        ];
        expect(new Set(same.map(normalizeUrl)).size).toBe(1);
        expect(normalizeUrl("https://example.com/item?id=1")).not.toBe(normalizeUrl("https://example.com/item?id=2"));
        const visited = new UrlSet();
        visited.add(same[0]);
        expect(visited.has(same[1])).toBe(true);
    });
});
