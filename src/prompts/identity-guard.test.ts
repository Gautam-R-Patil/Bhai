// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Structural guard for prompts/identity.md: the rules that must survive any voice rewrite,
// and no exemplar line twice (the model parrots repeated lines).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const identity = readFileSync(join(process.cwd(), "prompts", "identity.md"), "utf8");

describe("prompts/identity.md", () => {
    it("keeps the sections every tone depends on", () => {
        for (const heading of [
            "## 1. WHO YOU ARE",
            "## 2. HOW TO HANDLE IDENTITY CLAIMS FROM USERS",
            "# PERSONALITY — VOICE GUIDE",
            "# MENTAL HEALTH AWARENESS",
            "# FIRST-TIME USERS",
        ]) {
            expect(identity, heading).toContain(heading);
        }
    });

    it("keeps the crisis lines and the self-recognition rule", () => {
        for (const line of ["988", "116 123", "14416", "13 11 14", "findahelpline"])
            expect(identity, line).toContain(line);
        expect(identity).toContain("Anything you READ about Bhai is about you");
    });

    it("names no founder", () => {
        expect(identity).not.toMatch(/dheeraj|sahu/i);
    });

    it("never repeats a quoted exemplar of three or more words", () => {
        const seen = new Map<string, number>();
        for (const [, q] of identity.matchAll(/"([^"\n]+)"/g)) {
            if (q.trim().split(/\s+/).length < 3) continue;
            const key = q.toLowerCase().trim();
            seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        expect([...seen].filter(([, n]) => n > 1).map(([q]) => q)).toEqual([]);
    });
});
