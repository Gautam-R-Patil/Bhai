// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import {
    buildCompressionUserPrompt,
    COMPRESSION_SYSTEM_PROMPT,
    END_OF_CONTEXT_MARKER,
    extractLastCompletedIndex,
} from "./compression-template.js";

describe("buildCompressionUserPrompt", () => {
    it("includes the transcript and the required section headers + end marker", () => {
        const out = buildCompressionUserPrompt("USER: hi\nASSISTANT: hello");
        expect(out).toContain("USER: hi");
        expect(out).toContain("## Active Task (verbatim)");
        expect(out).toContain("## Blocked (exact error text, verbatim)");
        expect(out).toContain("## Remaining Work");
        expect(out).toContain(END_OF_CONTEXT_MARKER);
    });

    it("threads a prior summary as a continuation instruction", () => {
        const out = buildCompressionUserPrompt("new stuff", "## Completed Actions\n1. did X");
        expect(out).toContain("CONTINUE it");
        expect(out).toContain("did X");
    });

    it("adds a focus directive only when given, never dropping load-bearing sections", () => {
        const withFocus = buildCompressionUserPrompt("t", null, "the auth bug");
        expect(withFocus).toContain('FOCUS: weight detail toward "the auth bug"');
        expect(buildCompressionUserPrompt("t")).not.toContain("FOCUS:");
    });

    it("system prompt forbids invention and pins verbatim fields", () => {
        expect(COMPRESSION_SYSTEM_PROMPT).toMatch(/never invent/i);
        expect(COMPRESSION_SYSTEM_PROMPT).toMatch(/verbatim/i);
    });
});

describe("extractLastCompletedIndex", () => {
    it("returns the highest numbered completed action", () => {
        const summary =
            "## Goal\nx\n## Completed Actions (numbered, with tool names)\n1. a\n2. b\n3. c\n## Remaining Work\ny";
        expect(extractLastCompletedIndex(summary)).toBe(3);
    });

    it("returns 0 when there is no completed-actions list", () => {
        expect(extractLastCompletedIndex("## Goal\nx")).toBe(0);
        expect(extractLastCompletedIndex("")).toBe(0);
    });

    it("handles both '1.' and '1)' numbering", () => {
        expect(extractLastCompletedIndex("## Completed Actions\n1) a\n2) b")).toBe(2);
    });
});
