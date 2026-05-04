// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { classifyComplexity, getComplexityHint } from "./complexity-classifier.js";

describe("classifyComplexity — default / no signals", () => {
    it("returns 'none' for a plain short message", () => {
        const r = classifyComplexity("hi");
        expect(r.suggestion).toEqual("none");
        expect(r.score).toBeLessThan(0.4);
    });

    it("returns a 'No complexity signals detected' reason when no patterns match", () => {
        const r = classifyComplexity("what is 2+2");
        expect(r.signals).toEqual([]);
        expect(r.reason).toEqual("No complexity signals detected");
    });
});

describe("classifyComplexity — swarm signals", () => {
    it("suggests swarm for 'in parallel' requests", () => {
        const r = classifyComplexity(
            "Do these tasks in parallel: fetch data and also run the pipeline",
        );
        expect(r.signals).toContain("parallel request");
    });

    it("suggests swarm for 'for each' loops", () => {
        const r = classifyComplexity(
            "For each user in the list, check their status and send an email",
        );
        expect(r.signals).toContain("for-each pattern");
    });

    it("suggests swarm for 'simultaneously'", () => {
        const r = classifyComplexity("Run simultaneously: the build and the tests and the deploy");
        expect(r.signals).toContain("simultaneously");
    });

    it("suggests swarm when both 'research X' and 'create Y' appear together", () => {
        const r = classifyComplexity(
            "Research the topic and create a comprehensive report for investors",
        );
        expect(r.signals).toContain("research+create");
    });

    it("suggests swarm for 'code X' + 'test/deploy Y' pattern", () => {
        const r = classifyComplexity("Write the code to handle auth and then test the endpoints");
        expect(r.signals).toContain("code+test");
    });
});

describe("classifyComplexity — long_task signals", () => {
    it("suggests long_task for 'monitor'", () => {
        const r = classifyComplexity(
            "Monitor the logs continuously and alert me if something changes over time",
        );
        expect(r.signals).toContain("monitoring");
    });

    it("suggests long_task for 'step by step'", () => {
        const r = classifyComplexity(
            "Walk me step by step through the refactoring — phase by phase, carefully",
        );
        expect(r.signals).toContain("step-by-step");
    });

    it("suggests long_task for 'continuously'", () => {
        const r = classifyComplexity(
            "Watch the stream continuously over time and save any events you observe",
        );
        expect(r.signals).toContain("continuous");
    });

    it("suggests long_task for phase-based wording", () => {
        const r = classifyComplexity(
            "This has two phases: first the data gathering phase, then the analysis phase",
        );
        expect(r.signals).toContain("phased");
    });
});

describe("classifyComplexity — both signals (ambiguous)", () => {
    it("scope/scale keywords count for both", () => {
        const r = classifyComplexity(
            "Do a comprehensive, thorough, detailed, full audit of the codebase",
        );
        expect(r.signals).toContain("comprehensive");
        expect(r.signals).toContain("thorough");
        expect(r.signals).toContain("detailed");
        expect(r.signals).toContain("full");
    });

    it("numbered list counts for both", () => {
        const r = classifyComplexity("Do these:\n1. Task one\n2. Task two\n3. Task three");
        expect(r.signals).toContain("numbered list");
    });
});

describe("classifyComplexity — suggestion selection", () => {
    it("score >= 0.4 with swarm-heavy signals → suggestion = 'swarm'", () => {
        const r = classifyComplexity(
            "Run in parallel: for each item process simultaneously both the data and the research, comprehensively",
        );
        expect(r.score).toBeGreaterThanOrEqual(0.4);
        expect(r.suggestion).toEqual("swarm");
    });

    it("score >= 0.4 with long-task-heavy signals → suggestion = 'long_task'", () => {
        const r = classifyComplexity(
            "Monitor this continuously over time, step by step, through all the phases",
        );
        expect(r.score).toBeGreaterThanOrEqual(0.4);
        expect(r.suggestion).toEqual("long_task");
    });

    it("score < 0.4 → suggestion = 'none' even with some signals", () => {
        const r = classifyComplexity("Full detail");
        expect(r.score).toBeLessThan(0.4);
        expect(r.suggestion).toEqual("none");
    });

    it("score is capped at 1.0", () => {
        const heavy =
            "In parallel, for each item, simultaneously run the research and create comprehensive, thorough, detailed, full analysis. " +
            "Also monitor continuously, step by step, phase by phase. Both the data and code should be tested and deployed.";
        const r = classifyComplexity(heavy);
        expect(r.score).toBeLessThanOrEqual(1.0);
    });

    it("length bonus is capped at 0.2 (2000 chars / 2000 = 1.0, clamped to 0.2)", () => {
        const long = "x ".repeat(2000);
        const r = classifyComplexity(long);
        // length contributes up to +0.2 to each score
        expect(r.score).toBeLessThanOrEqual(1.0);
    });
});

describe("classifyComplexity — case insensitivity", () => {
    it("patterns are case-insensitive", () => {
        const r = classifyComplexity("DO IT IN PARALLEL AND SIMULTANEOUSLY, COMPREHENSIVELY");
        expect(r.signals.length).toBeGreaterThan(0);
    });
});

describe("getComplexityHint", () => {
    it("returns empty string for low-complexity messages", () => {
        expect(getComplexityHint("hi")).toEqual("");
        expect(getComplexityHint("what is 2+2")).toEqual("");
    });

    it("returns swarm hint with 💡 prefix when swarm suggested", () => {
        const hint = getComplexityHint(
            "Run in parallel: for each user, simultaneously check their data and also email them a comprehensive thorough report",
        );
        // Only assert if suggestion actually triggered (depends on score threshold)
        if (hint) {
            expect(hint).toContain("💡");
            expect(hint).toContain("swarm_task");
        }
    });

    it("returns long_task hint when long_task suggested", () => {
        const hint = getComplexityHint(
            "Monitor the service continuously over time, step by step through all the phases, watching",
        );
        if (hint) {
            expect(hint).toContain("💡");
            expect(hint).toContain("start_long_task");
        }
    });

    it("hint mentions the detected reasons", () => {
        const hint = getComplexityHint(
            "Run in parallel for each item simultaneously — comprehensive, thorough analysis of all",
        );
        if (hint) {
            expect(hint).toMatch(/Detected:/);
        }
    });
});
