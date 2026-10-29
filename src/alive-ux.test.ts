// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { smartChunkMessage } from "./alive-ux.js";

describe("smartChunkMessage", () => {
    it("never leaves an unclosed code fence when a block straddles the boundary", () => {
        // A fully-closed block has an EVEN fence count; parity-only tracking
        // reported "not in a block" and split through it, emitting a chunk with
        // a dangling ```.
        const text = "short intro here ok\n```\nline1 of code here\nline2 code\n```\nbye";
        const chunks = smartChunkMessage(text, 50);
        for (const c of chunks) {
            expect((c.match(/```/g) || []).length % 2).toBe(0);
        }
        // Nothing is lost in the split.
        expect(chunks.join("")).toContain("line1 of code here");
    });
});
