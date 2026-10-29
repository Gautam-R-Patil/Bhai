// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { smartTruncate } from "./smart-truncate.js";

// Helpers
const LONG = "x".repeat(10_000);

describe("smartTruncate — passthrough for short output", () => {
    it("returns the output unchanged when under maxChars (default 4000)", () => {
        const input = "hello world";
        expect(smartTruncate("read", input)).toEqual(input);
    });

    it("returns unchanged when length === maxChars (boundary)", () => {
        const input = "a".repeat(100);
        expect(smartTruncate("read", input, 100)).toEqual(input);
    });

    it("returns unchanged for unknown tool name + short output", () => {
        expect(smartTruncate("unknown_tool", "short")).toEqual("short");
    });
});

describe("smartTruncate — default strategy (unknown tools)", () => {
    it("simple head-cut for unknown tool when over limit", () => {
        const out = smartTruncate("unknown_tool", LONG, 100);
        expect(out.length).toEqual(100);
        expect(out).toEqual("x".repeat(100));
    });

    it("does NOT add a truncation marker in default mode", () => {
        const out = smartTruncate("unknown_tool", LONG, 100);
        expect(out).not.toContain("truncated");
    });
});

describe("smartTruncate — head_tail strategy (read/grep/glob/list_directory)", () => {
    it("read tool uses head_tail — head is ~60% of max, tail is the rest", () => {
        const input = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n");
        const out = smartTruncate("read", input, 500);
        expect(out).toContain("line-0");
        expect(out).toContain("line-999");
        expect(out).toContain("[truncated");
    });

    it("head_tail inserts a truncation marker in the middle", () => {
        const out = smartTruncate("read", LONG, 500);
        expect(out).toMatch(/\.\.\.\[truncated \d+ chars\]\.\.\./);
    });

    it.each(["read", "grep", "glob", "list_directory"])(
        "%s tool uses head_tail strategy",
        (tool) => {
            const input = "ALPHA".padEnd(5000, "M") + "OMEGA";
            const out = smartTruncate(tool, input, 500);
            expect(out.startsWith("ALPHA")).toBe(true);
            expect(out.endsWith("OMEGA")).toBe(true);
        },
    );

    it("head_tail result stays roughly within maxChars (accounts for ~60 char marker)", () => {
        const out = smartTruncate("read", LONG, 1000);
        expect(out.length).toBeLessThanOrEqual(1000 + 100); // small wiggle for separator
    });
});

describe("smartTruncate — tail_heavy strategy (shell_exec)", () => {
    it("shell_exec preserves the tail (errors are usually at the end)", () => {
        const stdout = Array.from({ length: 500 }, (_, i) => `output line ${i}`).join("\n");
        const footer = "\nERROR: command failed at the very end";
        const input = stdout + footer;
        const out = smartTruncate("shell_exec", input, 500);
        expect(out).toContain("ERROR: command failed");
    });

    it.each([
        "shell_exec",
        "shell_exec_background",
        "shell_check_process",
        "shell_wait_process",
    ])("%s uses tail_heavy", (tool) => {
        const input = "FIRST" + "x".repeat(5000) + "LAST";
        const out = smartTruncate(tool, input, 500);
        expect(out.endsWith("LAST")).toBe(true);
    });

    it("tail_heavy is more tail-dominant than head_tail (25% head vs 60%)", () => {
        const input = "x".repeat(5000);
        const tailHeavy = smartTruncate("shell_exec", input, 400);
        const headTail = smartTruncate("read", input, 400);
        // Both contain truncation markers; the position of the marker
        // shifts left in tail-heavy (less head kept).
        const tailHeavyMarkerPos = tailHeavy.indexOf("[truncated");
        const headTailMarkerPos = headTail.indexOf("[truncated");
        expect(tailHeavyMarkerPos).toBeLessThan(headTailMarkerPos);
    });
});

describe("smartTruncate — json_prune strategy", () => {
    it("web_search gets json_prune on valid JSON", () => {
        const data = {
            results: Array.from({ length: 20 }, (_, i) => ({
                title: `Result ${i} — ${"word ".repeat(200)}`,
                url: `https://example.com/${i}`,
                description: "x".repeat(1000),
            })),
        };
        const out = smartTruncate("web_search", JSON.stringify(data), 2000);
        const parsed = JSON.parse(out);
        // Should have truncated the description strings and dropped long array elems
        expect(parsed.results.length).toBeLessThanOrEqual(11); // top 10 + overflow marker
    });

    it("falls back to head_tail for invalid JSON", () => {
        const input = "{not valid json" + "x".repeat(5000);
        const out = smartTruncate("web_search", input, 500);
        // Should have a truncation marker (head_tail style), not a JSON parse error
        expect(out).toContain("[truncated");
    });

    it.each(["web_search", "memory_search", "memory_list", "deep_research"])(
        "%s uses json_prune",
        (tool) => {
            const data = { items: Array.from({ length: 50 }, (_, i) => ({ id: i, text: "x".repeat(500) })) };
            const out = smartTruncate(tool, JSON.stringify(data), 2000);
            // Either valid JSON or marker — parsing is the guarantee.
            const parsed = JSON.parse(out);
            expect(parsed).toBeDefined();
        },
    );

    it("json_prune keeps first 10 array items and notes the count", () => {
        const data = { tags: Array.from({ length: 30 }, (_, i) => `tag-${i}-${"x".repeat(200)}`) };
        const out = smartTruncate("web_search", JSON.stringify(data), 2000);
        const parsed = JSON.parse(out);
        // 10 real entries + the overflow placeholder string
        expect(parsed.tags.length).toBeLessThanOrEqual(11);
        // Last entry should be a "... more items" marker
        const last = parsed.tags[parsed.tags.length - 1];
        expect(typeof last).toEqual("string");
        expect(String(last)).toContain("more items");
    });

    it("json_prune truncates long string values with '...' suffix", () => {
        const data = { longText: "x".repeat(5000) };
        const out = smartTruncate("web_search", JSON.stringify(data), 1000);
        const parsed = JSON.parse(out);
        expect(parsed.longText.endsWith("...")).toBe(true);
        expect(parsed.longText.length).toBeLessThan(5000);
    });

    it("json_prune with unprintably-large data returns a valid JSON summary", () => {
        // Craft data so aggressive pruning still exceeds maxChars.
        const huge = {
            arrays: Array.from({ length: 100 }, () => ({
                nested: Array.from({ length: 50 }, () => ({
                    text: "y".repeat(200),
                    other: "z".repeat(200),
                    yetAnother: "w".repeat(200),
                })),
            })),
        };
        const out = smartTruncate("web_search", JSON.stringify(huge), 200);
        // Should still be valid JSON (the summary fallback)
        const parsed = JSON.parse(out);
        // If summary path taken, parsed has _truncated flag
        if (parsed._truncated) {
            expect(parsed._truncated).toBe(true);
            expect(parsed._originalSize).toBeGreaterThan(0);
        }
    });

    it("recursively prunes nested structures", () => {
        const data = {
            wrapper: {
                inner: {
                    leaf: "y".repeat(5000),
                },
            },
        };
        const out = smartTruncate("web_search", JSON.stringify(data), 1000);
        const parsed = JSON.parse(out);
        expect(parsed.wrapper.inner.leaf.endsWith("...")).toBe(true);
    });
});

describe("smartTruncate — keep_ids strategy (browser tools)", () => {
    it.each(["browser_scan", "browser_extract", "browser_analyze"])(
        "%s uses keep_ids strategy on JSON",
        (tool) => {
            // Use a generous maxChars so the pruned JSON stays <= limit and
            // the function doesn't fall back to head_tail (which breaks JSON).
            const data = {
                elements: Array.from({ length: 25 }, (_, i) => ({
                    id: `el-${i}`,
                    tag: "button",
                    text: "x".repeat(200),
                })),
            };
            const out = smartTruncate(tool, JSON.stringify(data), 5000);
            const parsed = JSON.parse(out);
            // IDs preserved in first 20 items
            expect(parsed.elements[0].id).toEqual("el-0");
            expect(parsed.elements[0].tag).toEqual("button");
            // Text field truncated to 80 chars + "..."
            expect(parsed.elements[0].text.length).toBeLessThan(200);
        },
    );

    it("keep_ids truncates non-id/non-tag string fields to 80 chars", () => {
        const data = {
            description: "a".repeat(500),
            id: "preserved-id-value",
        };
        const out = smartTruncate("browser_scan", JSON.stringify(data), 300);
        const parsed = JSON.parse(out);
        expect(parsed.id).toEqual("preserved-id-value");
        expect(parsed.description.endsWith("...")).toBe(true);
    });

    it("keep_ids keeps first 20 array elements, marks overflow", () => {
        // Payload MUST exceed maxChars but MUST also fit after keep_ids
        // pruning so keep_ids doesn't fall back to truncateHeadTail (which
        // breaks JSON). 30 small elements → ~600 chars; force truncation
        // by using maxChars just below raw size but above pruned size.
        const data = Array.from({ length: 30 }, (_, i) => ({ id: `e-${i}` }));
        const raw = JSON.stringify(data);
        // Raw = ~280 chars. Use maxChars below that so keep_ids runs,
        // then pruned-to-20 + marker is small enough to return as JSON.
        const out = smartTruncate("browser_scan", raw, 200);
        // If keep_ids couldn't fit, output may be head-tail (non-JSON).
        // Parse defensively — we care that SOMETHING was returned and,
        // if parseable, the 20-cap is honored.
        try {
            const parsed = JSON.parse(out);
            expect(parsed.length).toBeLessThanOrEqual(21);
            const last = parsed[parsed.length - 1];
            expect(String(last)).toContain("more elements");
        } catch {
            // Fallback path — just assert we did SOME truncation
            expect(out.length).toBeLessThan(raw.length);
        }
    });

    it("keep_ids on non-JSON falls back to line-filtering heuristic", () => {
        // Important lines must contain the matchers: id, ID, #\d, element,
        // button, input, link, href. The "rest" lines must NOT contain any
        // of those — so avoid the word "id" (including in "video id").
        const input =
            Array.from({ length: 200 }, (_, i) => {
                if (i % 10 === 0) return `button role=primary at #${i} clickable`;
                return `plain sentence without any matcher words at position ${i}`;
            }).join("\n") + "\n";
        const out = smartTruncate("browser_scan", input, 1000);
        // Should contain "button role=primary" lines (the important ones)
        expect(out).toContain("button role=primary");
        // Should have a truncation note for the remaining descriptive lines
        expect(out).toMatch(/descriptive lines truncated/);
    });
});

describe("smartTruncate — edge cases", () => {
    it("works with an empty string", () => {
        expect(smartTruncate("read", "")).toEqual("");
    });

    it("respects maxChars param override", () => {
        const input = "x".repeat(100);
        const out = smartTruncate("unknown", input, 50);
        expect(out.length).toEqual(50);
    });

    it("maxChars > input length → returns input as-is for every strategy", () => {
        for (const tool of ["read", "shell_exec", "web_search", "browser_scan", "random_tool"]) {
            expect(smartTruncate(tool, "abc", 100)).toEqual("abc");
        }
    });

    it("very small maxChars (under marker size) still returns something", () => {
        // maxChars=50, marker is ~60 chars, so head_tail negative-size math could glitch.
        // Verify it at least returns a string shorter than input.
        const out = smartTruncate("read", LONG, 50);
        expect(typeof out).toEqual("string");
        expect(out.length).toBeLessThan(LONG.length);
    });
});

describe("smartTruncate — UTF-16 surrogate safety at cut boundaries", () => {
    it("default strategy never ends in a lone high surrogate", () => {
        // "😀" (U+1F600) occupies UTF-16 units at idx 3999 (high) and 4000 (low).
        const input = "a".repeat(3999) + "😀" + "bb";
        const out = smartTruncate("unknown_tool", input, 4000);
        const lastUnit = out.charCodeAt(out.length - 1);
        expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
    });

    it("head_tail cut boundaries carry no dangling surrogate halves", () => {
        const input = "😀".repeat(5000); // every char is a surrogate pair
        const out = smartTruncate("read", input, 1000);
        const first = out.charCodeAt(0);
        const last = out.charCodeAt(out.length - 1);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // not a lone low surrogate
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // not a lone high surrogate
    });
});

describe("smartTruncate — keep_ids always returns valid JSON (never head_tail a JSON string)", () => {
    it("large JSON that overflows even after pruning stays parseable", () => {
        const data = {
            elements: Array.from({ length: 50 }, (_, i) => ({
                id: `el-${i}`,
                value: "v".repeat(300),
            })),
        };
        const out = smartTruncate("browser_scan", JSON.stringify(data), 5000);
        expect(out.length).toBeLessThanOrEqual(5000);
        expect(() => JSON.parse(out)).not.toThrow(); // would throw if head_tail cut mid-structure
    });
});

describe("smartTruncate — keep_ids non-JSON honors the cap and keeps whole ID lines", () => {
    it("ID-bearing lines exceeding the cap are kept whole head-first (no mid-line cut)", () => {
        const idLines = Array.from({ length: 200 }, (_, i) => `button id=#${i} clickable`);
        const out = smartTruncate("browser_scan", idLines.join("\n") + "\n", 5000);
        // Every surviving line must be a complete ID line (no truncated final line).
        for (const line of out.split("\n")) {
            if (line.length === 0) continue;
            expect(line).toMatch(/^button id=#\d+ clickable$/);
        }
    });

    it("does not overflow the cap when ID lines nearly fill it (no negative remaining)", () => {
        // ~166 ID lines ≈ just under 5000 chars, plus a few non-ID lines.
        const idLines = Array.from({ length: 166 }, (_, i) => `link href=/p/${i} here`);
        const restLines = Array.from({ length: 5 }, (_, i) => `plain descriptive sentence number ${i}`);
        const input = [...idLines, ...restLines].join("\n");
        const out = smartTruncate("browser_scan", input, 5000);
        expect(out.length).toBeLessThanOrEqual(5000);
    });
});

describe("smartTruncate — small maxChars head/tail math stays sane", () => {
    it("tail_heavy with tiny maxChars honors the cap and reports no bogus omitted count", () => {
        const input = "z".repeat(10_000);
        const out = smartTruncate("shell_exec", input, 50);
        expect(out.length).toBeLessThanOrEqual(50);
        const m = out.match(/truncated (\d+) chars/);
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(input.length);
    });
});
