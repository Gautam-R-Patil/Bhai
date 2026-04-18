// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getSFX, listSFX } from "../sfx-pack.js";

describe("listSFX", () => {
    it("returns at least 20 entries", () => {
        expect(listSFX().length).toBeGreaterThanOrEqual(20);
    });

    it("every entry has name, category, path, duration, license", () => {
        for (const entry of listSFX()) {
            expect(typeof entry.name).toBe("string");
            expect(entry.name.length).toBeGreaterThan(0);
            expect(typeof entry.category).toBe("string");
            expect(typeof entry.path).toBe("string");
            expect(entry.path).toContain("sfx/");
            expect(entry.path).toContain(`${entry.name}.mp3`);
            expect(typeof entry.duration).toBe("number");
            expect(entry.duration).toBeGreaterThan(0);
            expect(entry.license).toBe("CC0");
        }
    });

    it("includes category diversity (at least 6 categories)", () => {
        const categories = new Set(listSFX().map((e) => e.category));
        expect(categories.size).toBeGreaterThanOrEqual(6);
    });
});

describe("getSFX", () => {
    it("returns absolute path for a known name", () => {
        const p = getSFX("whoosh_fast");
        expect(p).toContain("whoosh_fast.mp3");
    });

    it("throws on unknown name with 'Available:' hint", () => {
        expect(() => getSFX("does_not_exist")).toThrow(/Available:/);
    });

    it("throws on empty string name", () => {
        expect(() => getSFX("")).toThrow(/non-empty string/);
    });
});
