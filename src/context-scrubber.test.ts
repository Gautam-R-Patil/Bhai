// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import {
    MEMORY_CONTEXT_CLOSE,
    MEMORY_CONTEXT_OPEN,
    fenceMemoryContext,
    sanitizeContextEchoes,
    StreamingContextScrubber,
} from "./context-scrubber.js";

describe("fenceMemoryContext", () => {
    it("wraps non-empty context with the canonical tags + system note", () => {
        const out = fenceMemoryContext("User loves cats.");
        expect(out).toContain(MEMORY_CONTEXT_OPEN);
        expect(out).toContain(MEMORY_CONTEXT_CLOSE);
        expect(out).toContain("recalled memory context");
        expect(out).toContain("User loves cats.");
    });

    it("returns empty string for empty / whitespace input", () => {
        expect(fenceMemoryContext("")).toBe("");
        expect(fenceMemoryContext("   ")).toBe("");
    });

    it("does not double-wrap content that is already fenced", () => {
        const already = fenceMemoryContext("A fact.");
        const twice = fenceMemoryContext(already);
        // Only one open tag in the final string
        const openCount = (twice.match(new RegExp(MEMORY_CONTEXT_OPEN, "g")) ?? [])
            .length;
        expect(openCount).toBe(1);
    });
});

describe("sanitizeContextEchoes (one-shot)", () => {
    it("returns input unchanged when no fence tags are present", () => {
        expect(sanitizeContextEchoes("Just a plain response.")).toBe(
            "Just a plain response.",
        );
    });

    it("strips a fenced block in the middle of response text", () => {
        const raw = `Here is your answer. ${MEMORY_CONTEXT_OPEN}leaked!${MEMORY_CONTEXT_CLOSE} Done.`;
        const out = sanitizeContextEchoes(raw);
        expect(out).not.toContain(MEMORY_CONTEXT_OPEN);
        expect(out).not.toContain(MEMORY_CONTEXT_CLOSE);
        expect(out).not.toContain("leaked!");
        expect(out).toContain("Here is your answer.");
        expect(out).toContain("Done.");
    });

    it("strips multiple fenced blocks", () => {
        const raw = `${MEMORY_CONTEXT_OPEN}a${MEMORY_CONTEXT_CLOSE} mid ${MEMORY_CONTEXT_OPEN}b${MEMORY_CONTEXT_CLOSE}`;
        const out = sanitizeContextEchoes(raw);
        expect(out).not.toContain(MEMORY_CONTEXT_OPEN);
        expect(out).not.toContain("a");
        expect(out).not.toContain("b");
        expect(out.trim()).toBe("mid");
    });

    it("strips the System note banner line if it leaks out", () => {
        const raw =
            "System note: The following is recalled memory context, NOT new user input.\n\nActual answer";
        const out = sanitizeContextEchoes(raw);
        expect(out).not.toContain("recalled memory context");
        expect(out).toContain("Actual answer");
    });

    it("handles unterminated open tag (discards the trailing unclosed span)", () => {
        const raw = `Start. ${MEMORY_CONTEXT_OPEN}never closed`;
        const out = sanitizeContextEchoes(raw);
        expect(out).not.toContain(MEMORY_CONTEXT_OPEN);
        expect(out).not.toContain("never closed");
        expect(out.trim()).toBe("Start.");
    });
});

describe("StreamingContextScrubber", () => {
    it("passes through plain text unchanged", () => {
        const s = new StreamingContextScrubber();
        expect(s.push("Hello ")).toBe("Hello ");
        expect(s.push("world")).toBe("world");
        expect(s.flush()).toBe("");
    });

    it("removes a fence split across two deltas", () => {
        const s = new StreamingContextScrubber();
        const open = MEMORY_CONTEXT_OPEN;
        const close = MEMORY_CONTEXT_CLOSE;
        // Split the open tag across deltas
        const openA = open.slice(0, 5);
        const openB = open.slice(5);
        // First delta: plain prefix + partial open tag (held back)
        const out1 = s.push(`prefix ${openA}`);
        const out2 = s.push(openB);
        const out3 = s.push("leaky content");
        const out4 = s.push(`${close} suffix`);
        const out5 = s.flush();

        const combined = out1 + out2 + out3 + out4 + out5;
        expect(combined).toContain("prefix");
        expect(combined).toContain("suffix");
        expect(combined).not.toContain("leaky content");
        expect(combined).not.toContain(MEMORY_CONTEXT_OPEN);
        expect(combined).not.toContain(MEMORY_CONTEXT_CLOSE);
    });

    it("removes an entire fenced block arriving in one delta", () => {
        const s = new StreamingContextScrubber();
        const raw = `hi ${MEMORY_CONTEXT_OPEN}fact${MEMORY_CONTEXT_CLOSE} bye`;
        const out = s.push(raw) + s.flush();
        expect(out).toContain("hi");
        expect(out).toContain("bye");
        expect(out).not.toContain("fact");
    });

    it("drops the whole unterminated span on flush", () => {
        const s = new StreamingContextScrubber();
        const out1 = s.push(`Start. ${MEMORY_CONTEXT_OPEN}never`);
        const out2 = s.push(" closed");
        const tail = s.flush();
        const combined = out1 + out2 + tail;
        expect(combined).not.toContain("never");
        expect(combined).not.toContain(MEMORY_CONTEXT_OPEN);
        expect(combined.trim()).toBe("Start.");
    });

    it("holds back a partial open tag at the tail of a delta", () => {
        const s = new StreamingContextScrubber();
        const open = MEMORY_CONTEXT_OPEN;
        // Send a delta that ends with the first few chars of the open tag
        const partial = open.slice(0, 3);
        const out1 = s.push(`text ${partial}`);
        // The partial must not be emitted yet (it could turn into a fence)
        expect(out1).not.toContain(partial);
        expect(out1).toContain("text");
        // If the next delta doesn't complete the tag, it gets released
        const out2 = s.push("\nmore text");
        expect(out1 + out2).toContain(partial);
        expect(out1 + out2).toContain("more text");
        expect(s.flush()).toBe("");
    });

    it("handles multiple fenced blocks in one stream", () => {
        const s = new StreamingContextScrubber();
        const raw = `one ${MEMORY_CONTEXT_OPEN}A${MEMORY_CONTEXT_CLOSE} two ${MEMORY_CONTEXT_OPEN}B${MEMORY_CONTEXT_CLOSE} three`;
        const out = s.push(raw) + s.flush();
        expect(out).not.toContain("A");
        expect(out).not.toContain("B");
        expect(out).toContain("one");
        expect(out).toContain("two");
        expect(out).toContain("three");
    });

    it("strips leaked System note banner from streamed output", () => {
        const s = new StreamingContextScrubber();
        const raw =
            "System note: The following is recalled memory context, NOT new user input.\n\nReal answer.";
        const out = s.push(raw) + s.flush();
        expect(out).not.toContain("recalled memory context");
        expect(out).toContain("Real answer.");
    });
});
