// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { buildToolSignature } from "./llm-cache.js";

describe("buildToolSignature — cache-key discriminator", () => {
    it("returns empty string for empty or missing tools", () => {
        expect(buildToolSignature()).toBe("");
        expect(buildToolSignature([])).toBe("");
    });

    it("builds sorted, comma-joined signature from OpenAI-style tools", () => {
        const sig = buildToolSignature([
            { function: { name: "zeta" } },
            { function: { name: "alpha" } },
            { function: { name: "mike" } },
        ]);
        expect(sig).toBe("alpha,mike,zeta");
    });

    it("supports bare { name } shape", () => {
        expect(buildToolSignature([{ name: "foo" }, { name: "bar" }])).toBe("bar,foo");
    });

    it("produces stable signatures regardless of input order", () => {
        const sigA = buildToolSignature([{ name: "a" }, { name: "b" }, { name: "c" }]);
        const sigB = buildToolSignature([{ name: "c" }, { name: "a" }, { name: "b" }]);
        expect(sigA).toBe(sigB);
    });

    it("ignores entries without a usable name", () => {
        expect(buildToolSignature([{ name: "x" }, {} as any, { function: {} } as any, { name: "y" }])).toBe("x,y");
    });
});
