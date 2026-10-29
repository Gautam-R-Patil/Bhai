// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { buildDynamicContextBlock } from "./llm.js";

// Regression guard for the prompt-cache prefix fix: the client-side dynamic
// system block rides ahead of the server-side Anthropic history cache
// breakpoint, so it MUST be byte-stable within a session. A to-the-second
// clock previously busted the cache on every request.
describe("buildDynamicContextBlock — prompt-cache stability", () => {
    it("is byte-identical for two calls within the same hour", () => {
        const t1 = new Date(2026, 5, 3, 14, 5, 1);
        const t2 = new Date(2026, 5, 3, 14, 58, 59);
        expect(buildDynamicContextBlock("", t1)).toBe(buildDynamicContextBlock("", t2));
    });

    it("differs across hour boundaries (still conveys temporal context)", () => {
        const t1 = new Date(2026, 5, 3, 14, 30, 0);
        const t2 = new Date(2026, 5, 3, 15, 30, 0);
        expect(buildDynamicContextBlock("", t1)).not.toBe(buildDynamicContextBlock("", t2));
    });

    it("contains the clock but no overlay widget markup", () => {
        const out = buildDynamicContextBlock("", new Date(2026, 5, 3, 14, 0, 0));
        expect(out).toContain("[SYSTEM CLOCK:");
        expect(out).not.toContain("WIDGET");
    });

    it("appends a language instruction only when provided, stably", () => {
        const t = new Date(2026, 5, 3, 14, 0, 0);
        const withLang = buildDynamicContextBlock("Respond in Spanish", t);
        expect(withLang).toContain("Respond in Spanish");
        expect(buildDynamicContextBlock("", t)).not.toContain("Respond in Spanish");
        // same inputs → identical output (no hidden volatility)
        expect(buildDynamicContextBlock("Respond in Spanish", t)).toBe(withLang);
    });
});
