// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import {
    containsCjk,
    sanitizeFts5Query,
    tokensForTrigram,
} from "./fts5-query.js";

describe("sanitizeFts5Query", () => {
    it("returns empty string for empty / whitespace-only input", () => {
        expect(sanitizeFts5Query("")).toBe("");
        expect(sanitizeFts5Query("   ")).toBe("");
    });

    it("strips FTS5 operator characters that aren't part of quoted phrases", () => {
        // No stripped chars should remain
        const out = sanitizeFts5Query("foo ^ bar ~ baz * qux");
        expect(out).not.toMatch(/[*^~]/);
        expect(out).toContain("foo");
        expect(out).toContain("bar");
    });

    it("preserves a balanced quoted phrase verbatim", () => {
        const out = sanitizeFts5Query('"exact phrase here"');
        expect(out).toBe('"exact phrase here"');
    });

    it("preserves multiple balanced quoted phrases", () => {
        const out = sanitizeFts5Query('"one phrase" and "another phrase"');
        expect(out).toContain('"one phrase"');
        expect(out).toContain('"another phrase"');
    });

    it("strips an unbalanced trailing quote", () => {
        // No danger of an unterminated phrase breaking the FTS5 parser
        const out = sanitizeFts5Query('foo "bar baz');
        expect(out).not.toContain('"');
        expect(out).toContain("foo");
        expect(out).toContain("bar");
        expect(out).toContain("baz");
    });

    it("quotes hyphenated terms so FTS5 does not tokenize on `-`", () => {
        const out = sanitizeFts5Query("my-app works");
        expect(out).toContain('"my-app"');
        expect(out).toContain("works");
    });

    it("quotes dotted filenames so FTS5 does not tokenize on `.`", () => {
        const out = sanitizeFts5Query("src/memory/sqlite.ts failed");
        // The dotted path is kept as a single quoted phrase (FTS5's tokenizer
        // will split internally on `/`, but the phrase boundary prevents the
        // tokens from reordering or being matched individually).
        expect(out).toContain('"src/memory/sqlite.ts"');
        expect(out).toContain("failed");
    });

    it("quotes terms containing both dots and hyphens", () => {
        const out = sanitizeFts5Query("my-app.config.ts bug");
        expect(out).toContain('"my-app.config.ts"');
    });

    it("does not re-quote terms that are already inside a quoted phrase", () => {
        const out = sanitizeFts5Query('"my-app.config.ts is broken"');
        // The outer quote must match exactly once around the single phrase
        expect(out).toBe('"my-app.config.ts is broken"');
    });

    it("removes stray parentheses/brackets but keeps words intact", () => {
        const out = sanitizeFts5Query("foo(bar)[baz]{qux}");
        expect(out).not.toMatch(/[()[\]{}]/);
        for (const w of ["foo", "bar", "baz", "qux"]) {
            expect(out).toContain(w);
        }
    });

    it("is idempotent — re-sanitizing yields the same string", () => {
        const first = sanitizeFts5Query("foo-bar.baz");
        const second = sanitizeFts5Query(first);
        expect(second).toBe(first);
    });

    it("trims trailing whitespace", () => {
        expect(sanitizeFts5Query("foo   ").endsWith(" ")).toBe(false);
    });
});

describe("containsCjk", () => {
    it("returns false for empty / null", () => {
        expect(containsCjk("")).toBe(false);
        expect(containsCjk(null as unknown as string)).toBe(false);
    });

    it("returns false for plain ASCII", () => {
        expect(containsCjk("hello world")).toBe(false);
    });

    it("returns true for Chinese chars (Han ideographs)", () => {
        expect(containsCjk("大别山项目")).toBe(true);
    });

    it("returns true for Japanese Hiragana/Katakana", () => {
        expect(containsCjk("こんにちは")).toBe(true);
        expect(containsCjk("コンピュータ")).toBe(true);
    });

    it("returns true for Korean Hangul", () => {
        expect(containsCjk("안녕하세요")).toBe(true);
    });

    it("returns true for a mixed English+CJK query", () => {
        expect(containsCjk("fix 大别山 bug")).toBe(true);
    });
});

describe("tokensForTrigram", () => {
    it("returns empty for empty input", () => {
        expect(tokensForTrigram("")).toEqual([]);
    });

    it("splits on whitespace", () => {
        expect(tokensForTrigram("大别山 项目")).toEqual(["大别山", "项目"]);
    });

    it("quotes each token for safe AND-chaining", () => {
        // tokensForTrigram only returns the tokens; a caller builds the query
        // string. Verify tokens are trimmed.
        expect(tokensForTrigram("  大别山   项目  ")).toEqual([
            "大别山",
            "项目",
        ]);
    });

    it("drops tokens that are all FTS5 operators", () => {
        expect(tokensForTrigram("* ~ ^")).toEqual([]);
    });

    it("skips very short tokens (len < 2) to avoid zero-length trigram matches", () => {
        expect(tokensForTrigram("a 大 别 山字")).toEqual(["山字"]);
    });
});
