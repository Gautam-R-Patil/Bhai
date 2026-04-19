// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { parseEffect } from "../effects.js";

describe("parseEffect — valid directives", () => {
    it("parses bg_replace with asset path", () => {
        const result = parseEffect("bg_replace:path/to/bg.jpg");
        expect(result).toEqual({ kind: "bg_replace", asset: "path/to/bg.jpg" });
    });

    it("parses stabilize (no colon)", () => {
        const result = parseEffect("stabilize");
        expect(result).toEqual({ kind: "stabilize" });
    });

    it("parses color_grade with preset", () => {
        const result = parseEffect("color_grade:warm");
        expect(result).toEqual({ kind: "color_grade", preset: "warm" });
    });

    it("parses stylize with preset", () => {
        const result = parseEffect("stylize:anime");
        expect(result).toEqual({ kind: "stylize", preset: "anime" });
    });

    it("parses bg_replace with a nested path containing slashes", () => {
        const result = parseEffect("bg_replace:assets/backgrounds/beach/sunset.jpg");
        expect(result).toEqual({ kind: "bg_replace", asset: "assets/backgrounds/beach/sunset.jpg" });
    });
});

describe("parseEffect — invalid / rejected inputs", () => {
    it("returns null for unknown kind", () => {
        expect(parseEffect("sharpen")).toBeNull();
        expect(parseEffect("zoom:2x")).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(parseEffect("")).toBeNull();
    });

    it("returns null for color_grade with missing preset (empty after colon)", () => {
        expect(parseEffect("color_grade:")).toBeNull();
    });

    it("returns null for bg_replace with missing asset (empty after colon)", () => {
        expect(parseEffect("bg_replace:")).toBeNull();
    });

    it("returns null for stylize with missing preset (empty after colon)", () => {
        expect(parseEffect("stylize:")).toBeNull();
    });
});
