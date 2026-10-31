// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { normalizeForEcho, tokenOverlap, looksLikeMidSentence } from "./session.js";

describe("normalizeForEcho", () => {
    it("lowercases + strips punctuation + collapses whitespace", () => {
        expect(normalizeForEcho("Yeah, opening WhatsApp now.")).toBe("yeah opening whatsapp now");
        expect(normalizeForEcho("  Hello!  How are you?  ")).toBe("hello how are you");
    });

    it("preserves Devanagari including combining marks (matras)", () => {
        // Devanagari vowel signs (matras) are in \p{M}. The normalizer keeps
        // them so "अभी" stays whole instead of collapsing to "अभ".
        expect(normalizeForEcho("अभी सुबह के")).toBe("अभी सुबह के");
    });

    it("empty input stays empty", () => {
        expect(normalizeForEcho("")).toBe("");
        expect(normalizeForEcho("   ")).toBe("");
    });
});

describe("tokenOverlap — echo detection", () => {
    it("perfect echo = 1.0", () => {
        expect(tokenOverlap("opening whatsapp now", "opening whatsapp now")).toBe(1);
    });

    it("reordered tokens still match", () => {
        expect(tokenOverlap("whatsapp now opening", "opening whatsapp now")).toBe(1);
    });

    it("partial overlap returns fractional score", () => {
        // 2 of 4 tokens match
        expect(tokenOverlap("opening whatsapp store now", "opening store")).toBeCloseTo(0.5, 2);
    });

    it("genuine new user speech has low overlap (< threshold)", () => {
        // Bhai said: "It's 26 degrees and partly cloudy"
        // User follow-up: "what about tomorrow"
        expect(tokenOverlap("what about tomorrow", "its 26 degrees and partly cloudy")).toBeLessThan(0.3);
    });

    it("the bug case: user says 'Yeah' + Bhai saying 'opening WhatsApp now' echoes", () => {
        // The log showed pending = "Yeah, opening WhatsApp now." (28 chars)
        // Bhai just said: "Yeah, opening WhatsApp now." (27 chars, identical)
        // Token overlap is 100%; echo filter catches it.
        const bhaiSaid = normalizeForEcho("Yeah, opening WhatsApp now.");
        const userHeard = normalizeForEcho("Yeah, opening WhatsApp now.");
        expect(tokenOverlap(userHeard, bhaiSaid)).toBe(1);
    });

    it("single-word candidates can't trigger (≥2 chars required)", () => {
        // "hi" vs "hi everyone" — single token "hi" survives the >= 2 filter
        expect(tokenOverlap("hi", "hi everyone")).toBe(1);
    });

    it("very short candidate (<2 chars each) returns 0", () => {
        expect(tokenOverlap("a b", "nothing at all")).toBe(0);
    });

    it("empty inputs return 0 safely", () => {
        expect(tokenOverlap("", "reference text")).toBe(0);
        expect(tokenOverlap("candidate", "")).toBe(0);
    });
});

describe("looksLikeMidSentence — debounce extender", () => {
    it("returns true for pending text ending in connective/function words", () => {
        // The prod bug cases from the log
        expect(looksLikeMidSentence("Can you find")).toBe(true);
        expect(looksLikeMidSentence("me a power bank under")).toBe(true);
        expect(looksLikeMidSentence("which is of")).toBe(true);
        // Common ones
        expect(looksLikeMidSentence("tell me about the")).toBe(true);
        expect(looksLikeMidSentence("what is")).toBe(true);
        expect(looksLikeMidSentence("send it to")).toBe(true);
    });

    it("returns false for pending text ending in a content word or pronoun", () => {
        expect(looksLikeMidSentence("what time is it")).toBe(false);  // "it" is not in tail set
        expect(looksLikeMidSentence("check the weather")).toBe(false);
        expect(looksLikeMidSentence("open WhatsApp")).toBe(false);
        expect(looksLikeMidSentence("okay")).toBe(false);
        expect(looksLikeMidSentence("yes please")).toBe(false);
        expect(looksLikeMidSentence("cool thanks")).toBe(false);
    });

    it("handles trailing punctuation gracefully", () => {
        expect(looksLikeMidSentence("which is of")).toBe(true);      // "of" still triggers after strip
        expect(looksLikeMidSentence("find it.")).toBe(false);         // "it" is the last word, not in tail
        expect(looksLikeMidSentence("what about me?")).toBe(false);   // "me" is pronoun, not in tail set
    });

    it("handles empty / whitespace", () => {
        expect(looksLikeMidSentence("")).toBe(false);
        expect(looksLikeMidSentence("   ")).toBe(false);
    });

    it("tolerates Devanagari (no last-word match in tail set → proceed)", () => {
        // Tail set is English-only; Hindi sentences always proceed on standard
        // 700ms window. Acceptable for now (English is the bulk of the issue).
        expect(looksLikeMidSentence("क्या है")).toBe(false);
    });
});
