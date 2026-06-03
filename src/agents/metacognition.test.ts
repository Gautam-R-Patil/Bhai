// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    __setCalibratorBundleForTesting,
    applyCalibrator,
    assess,
    type CalibratorBundle,
    type CalibratorRow,
    calibratorBeatsBaseline,
    computeBinStats,
    createMetacognitionState,
    fitCalibrator,
    fitPlatt,
    logOutcome,
    setCalibrationContext,
    tierBucket,
    updateSignals,
} from "./metacognition.js";

// Drive assess() into a HIGH-confidence name-pattern loop: alternating tools
// with DISTINCT step keys (so the A1 identical-args clamp does NOT fire) →
// detectLoopJS flags loopDetected → intervention "replan" while confidence
// stays well above τ. The most-recent tool is the VOC pending-risk proxy.
function highConfLoop(tools: string[]) {
    const s = createMetacognitionState();
    for (let i = 0; i < tools.length; i++) {
        updateSignals(s, { toolName: tools[i], hadError: false, responseLength: 100, stepKey: `${tools[i]}:${i}` });
    }
    return s;
}

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

describe("metacognition — VOC cost-aware threshold (B1)", () => {
    const READONLY_LOOP = ["web_search", "read_file", "web_search", "read_file", "web_search", "read_file"];
    const DESTRUCTIVE_LOOP = ["shell_exec", "delete_file", "shell_exec", "delete_file", "shell_exec", "delete_file"];

    beforeEach(() => {
        delete process.env.ATLAS_NO_META_VOC;
        process.env.ATLAS_METACOG_SHADOW = "true"; // calibration stays identity
        __setCalibratorBundleForTesting(null);
    });
    afterEach(() => {
        delete process.env.ATLAS_NO_META_VOC;
        delete process.env.ATLAS_METACOG_SHADOW;
        __setCalibratorBundleForTesting(undefined);
    });

    it("downgrades an expensive arm to escalate when pending tool is read-only + confidence moderate", () => {
        const a = assess(highConfLoop(READONLY_LOOP));
        // P=0.75 ≥ τ=1−1/2=0.5 for read-only → replan downgrades to escalate.
        expect(a.intervention).toBe("escalate");
        expect(a.reasoning).toContain("VOC↓");
    });

    it("keeps the expensive arm when pending tool is destructive and confidence < 0.9", () => {
        const a = assess(highConfLoop(DESTRUCTIVE_LOOP));
        // Irreversible pending → keep firing unless P≥0.9. P=0.75 → keep replan.
        expect(a.intervention).toBe("replan");
        expect(a.reasoning).not.toContain("VOC↓");
    });

    it("ATLAS_NO_META_VOC=true disables VOC (byte-identical fixed-threshold enum)", () => {
        process.env.ATLAS_NO_META_VOC = "true";
        const a = assess(highConfLoop(READONLY_LOOP));
        expect(a.intervention).toBe("replan"); // not downgraded
        expect(a.reasoning).not.toContain("VOC↓");
    });

    it("never gates the free arms (genuine loop at low confidence keeps replan)", () => {
        // 5 identical read_file calls → A1 clamps confidence to ≤0.3 and forces
        // replan. P=0.3 < τ=0.5 for read-only → VOC does NOT downgrade; the real
        // loop still gets its intervention.
        const s = createMetacognitionState();
        for (let i = 0; i < 5; i++)
            updateSignals(s, { toolName: "read_file", hadError: false, responseLength: 100, stepKey: "read_file:x" });
        const a = assess(s);
        expect(a.intervention).toBe("replan");
        expect(a.reasoning).not.toContain("VOC↓");
    });
});

describe("metacognition — finalizeAssessment order + shadow calibration (C)", () => {
    beforeEach(() => {
        delete process.env.ATLAS_NO_META_VOC;
        __setCalibratorBundleForTesting(null);
    });
    afterEach(() => {
        delete process.env.ATLAS_NO_META_VOC;
        delete process.env.ATLAS_METACOG_SHADOW;
        delete process.env.ATLAS_NO_METACOG_LOG;
        __setCalibratorBundleForTesting(undefined);
    });

    it("calibrate is an identity passthrough in shadow mode (DEFAULT) — confidence unchanged", () => {
        process.env.ATLAS_METACOG_SHADOW = "true";
        process.env.ATLAS_NO_METACOG_LOG = "true"; // no shadow-log side effect
        // A calibrator that WOULD map everything to 0.99 if applied.
        const bundle: CalibratorBundle = {
            version: 1,
            builtTs: new Date().toISOString(),
            global: { kind: "platt", a: 0, b: 6, n: 100, fitTs: "" }, // sigmoid(6) ≈ 0.9975
            perKey: {},
            diagnostics: {},
        };
        __setCalibratorBundleForTesting(bundle);
        const s = createMetacognitionState();
        setCalibrationContext(s, { taskType: "coding", modelTier: "anthropic/claude-opus-4.6" });
        for (let i = 0; i < 5; i++)
            updateSignals(s, { toolName: "read_file", hadError: false, responseLength: 100, stepKey: "read_file:x" });
        const a = assess(s);
        // Shadow → confidence is the A1-clamped 0.3, NOT the calibrator's 0.9975.
        expect(a.confidence).toBeLessThanOrEqual(0.3);
        expect(a.reasoning).not.toContain("calibrated P=");
    });

    it("finalizeAssessment runs calibrate → A1 → VOC in order (VOC sees A1's loop boost)", () => {
        // With ATLAS_NO_META_VOC unset and a high-confidence read-only loop, the
        // downgrade in the reasoning string proves VOC ran AFTER A1/calibrate and
        // observed the assessment they produced.
        process.env.ATLAS_METACOG_SHADOW = "true";
        const a = assess(
            highConfLoop(["web_search", "read_file", "web_search", "read_file", "web_search", "read_file"]),
        );
        expect(a.reasoning).toContain("Repeating tool-call pattern"); // assessJS produced it
        expect(a.reasoning).toContain("VOC↓"); // VOC ran last on that result
        expect(a.intervention).toBe("escalate");
    });
});

describe("metacognition — confidence calibrator stats (C)", () => {
    it("tierBucket coarsens full model strings", () => {
        expect(tierBucket("anthropic/claude-opus-4.6")).toBe("heavy");
        expect(tierBucket("anthropic/claude-sonnet-4.6")).toBe("pro");
        expect(tierBucket("anthropic/claude-haiku-4.5")).toBe("light");
        expect(tierBucket(null)).toBe("other");
    });

    it("computeBinStats: perfectly-calibrated data → low ECE; baselineBrier matches base-rate predictor", () => {
        const rows: CalibratorRow[] = [];
        for (let i = 0; i < 100; i++)
            rows.push({ finalConfidence: 1, taskCompleted: true, taskType: null, modelTier: null });
        for (let i = 0; i < 100; i++)
            rows.push({ finalConfidence: 0, taskCompleted: false, taskType: null, modelTier: null });
        const s = computeBinStats(rows);
        expect(s.n).toBe(200);
        expect(s.ece).toBeCloseTo(0, 5);
        expect(s.brier).toBeCloseTo(0, 5);
        expect(s.baselineRate).toBeCloseTo(0.5, 5);
        expect(s.baselineBrier).toBeCloseTo(0.25, 5); // (0.5)^2 constant predictor
    });

    it("computeBinStats: miscalibrated (all p=0.9, mean(y)=0.3) → high ECE", () => {
        const rows: CalibratorRow[] = [];
        for (let i = 0; i < 100; i++)
            rows.push({ finalConfidence: 0.9, taskCompleted: i < 30, taskType: null, modelTier: null });
        const s = computeBinStats(rows);
        expect(s.ece).toBeGreaterThan(0.5);
    });

    it("fitPlatt: identity passthrough on one-class / tiny data (cold-start safety)", () => {
        const oneClass: CalibratorRow[] = Array.from({ length: 50 }, () => ({
            finalConfidence: 0.7,
            taskCompleted: true,
            taskType: null,
            modelTier: null,
        }));
        expect(fitPlatt(oneClass).kind).toBe("identity");
        expect(fitPlatt([{ finalConfidence: 0.5, taskCompleted: true, taskType: null, modelTier: null }]).kind).toBe(
            "identity",
        );
    });

    it("fitCalibrator: <200 rows → platt, ≥200 → isotonic", () => {
        const mk = (n: number): CalibratorRow[] =>
            Array.from({ length: n }, (_, i) => ({
                finalConfidence: i / n,
                taskCompleted: i % 2 === 0,
                taskType: null,
                modelTier: null,
            }));
        expect(fitCalibrator(mk(100)).kind).toBe("platt");
        expect(fitCalibrator(mk(250)).kind).toBe("isotonic");
    });

    it("applyCalibrator: identity kind returns input; platt clamps to [0,1]", () => {
        expect(applyCalibrator({ kind: "identity", n: 0, fitTs: "" }, 0.42)).toBe(0.42);
        const p = applyCalibrator({ kind: "platt", a: 100, b: -50, n: 10, fitTs: "" }, 1);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
    });

    it("calibratorBeatsBaseline: false when cal Brier ≥ baselineBrier", () => {
        const stats = { n: 100, ece: 0.1, brier: 0.2, baselineRate: 0.5, baselineBrier: 0.25 };
        expect(calibratorBeatsBaseline(stats, 0.26, 0.05)).toBe(false); // worse Brier
        expect(calibratorBeatsBaseline(stats, 0.2, 0.2)).toBe(false); // worse ECE
        expect(calibratorBeatsBaseline(stats, 0.2, 0.05)).toBe(true); // both improve
    });
});
