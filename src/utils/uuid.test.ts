// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { generateUUID } from "./uuid.js";

describe("generateUUID", () => {
    it("returns a 36-char string", () => {
        expect(generateUUID()).toHaveLength(36);
    });

    it("matches the UUID v4 format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx", () => {
        const uuid = generateUUID();
        // Standard RFC 4122 v4 regex: version nibble must be 4, variant nibble must be 8/9/a/b
        expect(uuid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
    });

    it("version nibble (13th char) is always '4'", () => {
        for (let i = 0; i < 100; i++) {
            expect(generateUUID()[14]).toEqual("4");
        }
    });

    it("variant nibble (17th char) is always 8, 9, a, or b", () => {
        for (let i = 0; i < 100; i++) {
            expect(["8", "9", "a", "b"]).toContain(generateUUID()[19]);
        }
    });

    it("produces unique ids across a batch (no collisions in 10k)", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 10_000; i++) {
            seen.add(generateUUID());
        }
        expect(seen.size).toEqual(10_000);
    });

    it("hyphens are in the standard 4 positions (8, 13, 18, 23)", () => {
        const uuid = generateUUID();
        expect(uuid[8]).toEqual("-");
        expect(uuid[13]).toEqual("-");
        expect(uuid[18]).toEqual("-");
        expect(uuid[23]).toEqual("-");
    });

    it("uses only lowercase hex (no uppercase letters)", () => {
        const uuid = generateUUID();
        expect(uuid).toEqual(uuid.toLowerCase());
    });
});
