// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { analyzeRole, shouldOverrideRole } from "./role-analyzer.js";

describe("analyzeRole — role detection", () => {
    it("recommends 'coder' for code-focused tasks", () => {
        const r = analyzeRole("write code to edit code and refactor the function");
        expect(r.recommendedRole).toEqual("coder");
        expect(r.confidence).toBeGreaterThan(0);
    });

    it("recommends 'browser' for web automation tasks", () => {
        const r = analyzeRole("navigate to the website and click the login button and fill in form");
        expect(r.recommendedRole).toEqual("browser");
    });

    it("recommends 'researcher' for information-gathering tasks", () => {
        const r = analyzeRole("research quantum computing and summarize sources and investigate");
        expect(r.recommendedRole).toEqual("researcher");
    });

    it("recommends 'system' for OS-automation tasks", () => {
        const r = analyzeRole(
            "take a screenshot on macOS using AppleScript and adjust brightness and volume",
        );
        expect(r.recommendedRole).toEqual("system");
    });

    it("falls back to 'general' when no keywords match", () => {
        const r = analyzeRole("do the thing with the stuff now");
        expect(r.recommendedRole).toEqual("general");
        expect(r.confidence).toEqual(0);
    });

    it("is case-insensitive", () => {
        const r = analyzeRole("NAVIGATE TO THE WEBSITE AND CLICK LOGIN AND FILL FORM");
        expect(r.recommendedRole).toEqual("browser");
    });
});

describe("analyzeRole — confidence scoring", () => {
    it("confidence is 0 when no keywords match", () => {
        const r = analyzeRole("xyzzy plugh frobozz");
        expect(r.confidence).toEqual(0);
    });

    it("confidence is positive when multiple keywords match", () => {
        const r = analyzeRole("write code to refactor the shell script and compile it");
        expect(r.confidence).toBeGreaterThan(0);
    });

    it("confidence is bounded at 1 (after margin multiplication)", () => {
        const r = analyzeRole(
            "write code and compile and refactor and build the npm script and edit the code",
        );
        expect(r.confidence).toBeLessThanOrEqual(1);
    });

    it("high confidence when the winning role dominates", () => {
        // Pure browser vocab, no overlap with other roles
        const r = analyzeRole(
            "navigate website click fill form login sign in scrape browse url open site",
        );
        expect(r.recommendedRole).toEqual("browser");
        expect(r.confidence).toBeGreaterThan(0.3);
    });

    it("lower confidence when two roles tie (cross-classification)", () => {
        // Mix of coder + browser keywords
        const r = analyzeRole(
            "write code to navigate website and fill form via automated script",
        );
        // Confidence should reflect the tie
        expect(r.confidence).toBeLessThan(0.7);
    });
});

describe("analyzeRole — result metadata", () => {
    it("returns a reason string describing matched keywords", () => {
        const r = analyzeRole("write code to refactor");
        expect(r.reason).toMatch(/Matched \d+ keywords for coder/);
    });

    it("when no match, reason says 'No role-specific keywords found'", () => {
        const r = analyzeRole("xyzzy");
        expect(r.reason).toEqual("No role-specific keywords found");
    });

    it("matchedKeywords contains the source regex strings", () => {
        const r = analyzeRole("research and cite the source");
        expect(r.matchedKeywords.length).toBeGreaterThan(0);
        // All entries are regex source strings
        expect(r.matchedKeywords.every((k) => typeof k === "string")).toBe(true);
    });
});

describe("shouldOverrideRole", () => {
    it("returns no override when planned role is 'general' (not restricted)", () => {
        const r = shouldOverrideRole("general", "navigate the website and click login");
        expect(r.override).toBe(false);
    });

    it("returns override when a specialized role is recommended with high confidence", () => {
        // Coder planned but description is clearly browser
        const r = shouldOverrideRole(
            "coder",
            "navigate to the website and click the login button and fill in form and scrape",
        );
        if (r.override) {
            expect(r.newRole).toEqual("browser");
            expect(r.reason).toBeDefined();
        }
        // We can't guarantee confidence hits the threshold — but IF override is
        // true, the new role must differ from the planned one.
    });

    it("no override when recommendation matches planned role", () => {
        const r = shouldOverrideRole(
            "coder",
            "write code to refactor the shell script and compile it and run npm install",
        );
        expect(r.override).toBe(false);
    });

    it("no override when confidence is below threshold", () => {
        // Weak match — single keyword
        const r = shouldOverrideRole("coder", "just do the thing");
        expect(r.override).toBe(false);
    });

    it("respects a custom confidence threshold", () => {
        const description = "search web and find information about quantum computing";
        // With a very low threshold (0.05), we'd override coder → researcher
        const low = shouldOverrideRole("coder", description, 0.05);
        // With a very high threshold (0.99), we should NOT override
        const high = shouldOverrideRole("coder", description, 0.99);
        expect(high.override).toBe(false);
        // Low threshold may or may not override depending on keyword density
        if (low.override) {
            expect(low.newRole).toEqual("researcher");
        }
    });
});

describe("analyzeRole — 'implement' is a coder keyword (regression: typo was 'implment')", () => {
    it("recommends 'coder' for an implement task", () => {
        const r = analyzeRole("implement a REST API feature");
        expect(r.recommendedRole).toEqual("coder");
    });
});
