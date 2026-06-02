// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assess, createMetacognitionState, logOutcome, updateSignals } from "./metacognition.js";

describe("metacognition — content-aware loop detection (A1)", () => {
    it("flags a loop when the SAME tool+args repeats, even if name-only matching wouldn't", () => {
        const s = createMetacognitionState();
        // 5 calls, same tool, IDENTICAL step key — the content-aware signal.
        for (let i = 0; i < 5; i++) {
            updateSignals(s, { toolName: "read", hadError: false, responseLength: 100, stepKey: "read:abc123" });
        }
        const a = assess(s);
        expect(a.loopDetected).toBe(true);
        expect(a.struggleDetected).toBe(true);
        expect(a.confidence).toBeLessThanOrEqual(0.3);
        expect(a.reasoning).toContain("identical");
    });

    it("does NOT flag a loop when the same tool runs with DIFFERENT args", () => {
        const s = createMetacognitionState();
        for (let i = 0; i < 6; i++) {
            updateSignals(s, { toolName: "read", hadError: false, responseLength: 100, stepKey: `read:file${i}` });
        }
        const a = assess(s);
        // Distinct step keys → no identical-repeat loop signal from A1.
        expect(a.reasoning).not.toContain("identical");
    });

    it("tracks the max identical-repeat run across the turn", () => {
        const s = createMetacognitionState();
        updateSignals(s, { toolName: "x", stepKey: "x:1" });
        updateSignals(s, { toolName: "x", stepKey: "x:1" });
        updateSignals(s, { toolName: "y", stepKey: "y:1" }); // breaks the run
        updateSignals(s, { toolName: "x", stepKey: "x:1" });
        expect(s.signals.maxIdenticalStepRepeats).toBe(2);
    });
});

describe("metacognition — outcome log (A3)", () => {
    let dir: string;
    let prevCwd: string;

    beforeEach(() => {
        prevCwd = process.cwd();
        dir = mkdtempSync(join(tmpdir(), "atlas-metacog-"));
        process.chdir(dir);
        delete process.env.ATLAS_NO_METACOG_LOG;
    });
    afterEach(() => {
        process.chdir(prevCwd);
        rmSync(dir, { recursive: true, force: true });
    });

    it("appends a JSONL row capturing the turn outcome", () => {
        const s = createMetacognitionState();
        for (let i = 0; i < 4; i++)
            updateSignals(s, { toolName: "shell", hadError: false, responseLength: 50, stepKey: `shell:${i}` });
        logOutcome(s, true, { taskType: "coding", modelTier: "anthropic/claude-opus-4-8" });

        const file = join(dir, "data", "metacog-outcomes.jsonl");
        expect(existsSync(file)).toBe(true);
        const row = JSON.parse(readFileSync(file, "utf8").trim());
        expect(row.taskCompleted).toBe(true);
        expect(row.taskType).toBe("coding");
        expect(row.toolCalls).toBe(4);
        expect(typeof row.qualityScore).toBe("number");
    });

    it("writes nothing when ATLAS_NO_METACOG_LOG=true", () => {
        process.env.ATLAS_NO_METACOG_LOG = "true";
        const s = createMetacognitionState();
        updateSignals(s, { toolName: "shell", stepKey: "shell:1" });
        logOutcome(s, true);
        expect(existsSync(join(dir, "data", "metacog-outcomes.jsonl"))).toBe(false);
        delete process.env.ATLAS_NO_METACOG_LOG;
    });

    it("never throws on a malformed state (fail-open)", () => {
        const s = createMetacognitionState();
        expect(() => logOutcome(s, false)).not.toThrow();
    });
});
