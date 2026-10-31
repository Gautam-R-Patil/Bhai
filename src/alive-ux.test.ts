// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetPhraseHistory, categorizeError, pickPhrase, smartChunkMessage } from "./alive-ux.js";

describe("pickPhrase — never repeats a phrase back-to-back", () => {
    afterEach(() => {
        _resetPhraseHistory();
        vi.restoreAllMocks();
    });

    it("does not re-pick the last phrase once a small category fills the history window", () => {
        // Adversarial RNG: always take pool[0]. A 3-phrase category fills the
        // 3-slot history, after which the buggy version fell back to ALL options
        // and re-picked the just-used phrase; the fix excludes the last one.
        vi.spyOn(Math, "random").mockReturnValue(0);
        const opts = ["one", "two", "three"];
        const seen: string[] = [];
        for (let i = 0; i < 8; i++) seen.push(pickPhrase("t", opts));
        for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    });

    it("still returns the only phrase for a single-option category (unavoidable)", () => {
        expect(pickPhrase("solo", ["only"])).toBe("only");
        expect(pickPhrase("solo", ["only"])).toBe("only");
    });
});

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

describe("categorizeError", () => {
    it("names the real cause instead of credits or a missing file", () => {
        expect(categorizeError("Maximum call stack size exceeded")).toBe("unknown");
        expect(categorizeError("Max iterations exceeded")).toBe("unknown");
        expect(categorizeError("404 model not found")).not.toBe("file_not_found");
        expect(categorizeError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("network_timeout");
        expect(categorizeError("EACCES: open '/x'")).toBe("permission_denied");
        expect(categorizeError("ENOENT: open '/x'")).toBe("file_not_found");
        expect(categorizeError("Insufficient credits")).toBe("out_of_credits");
        expect(categorizeError("quota exceeded")).toBe("out_of_credits");
    });
});
