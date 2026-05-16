// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import { runCompileCheck, runLintCritic, runSastCritic } from "../critics.js";

describe("compile critic", () => {
    it("passes valid JS", () => {
        const r = runCompileCheck("const x = 1; module.exports = async () => x + 1;");
        expect(r.pass).toBe(true);
    });

    it("fails on syntax error", () => {
        const r = runCompileCheck("const x = ;");
        expect(r.pass).toBe(false);
        expect(r.hardFail).toBe(true);
    });
});

describe("SAST critic (regex fallback)", () => {
    it("detects eval()", async () => {
        const r = await runSastCritic("module.exports = async (i) => eval(i.code);", { rulesPath: null });
        expect(r.pass).toBe(false);
        expect(r.findings[0].ruleId).toMatch(/eval/i);
    });

    it("detects new Function()", async () => {
        const r = await runSastCritic("const f = new Function('x', 'return x'); module.exports = async () => f(1);", { rulesPath: null });
        expect(r.pass).toBe(false);
        expect(r.findings[0].ruleId).toMatch(/function|eval/i);
    });

    it("detects require('child_process')", async () => {
        const r = await runSastCritic("require('child_process');", { rulesPath: null });
        expect(r.pass).toBe(false);
    });

    it("detects source-tree read", async () => {
        const r = await runSastCritic(`fs.readFileSync("/Users/x/Desktop/ATLAS/src/agent.ts");`, { rulesPath: null });
        expect(r.pass).toBe(false);
    });

    it("passes clean code", async () => {
        const r = await runSastCritic("module.exports = async (i) => i.x + 1;", { rulesPath: null });
        expect(r.pass).toBe(true);
    });
});

describe("lint critic", () => {
    it("returns soft-pass with degraded:true when Biome binary missing", async () => {
        const r = await runLintCritic("const x = 1;", { biomePath: "/nonexistent/biome" });
        expect(r.degraded).toBe(true);
        expect(r.pass).toBe(true); // soft pass when degraded
    });
});
