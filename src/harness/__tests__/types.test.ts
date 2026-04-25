// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import {
    DEFAULT_OBJECTIVE_VECTOR,
    isObjectiveVector,
    isParetoPoint,
} from "../types.js";
import type {
    ObjectiveVector,
    ParetoPoint,
    SeedConfig,
    DimensionGradient,
    GpObservation,
    OptimizeOptions,
    OptimizeResult,
} from "../types.js";

describe("harness v2 types", () => {
    it("DEFAULT_OBJECTIVE_VECTOR is a zeroed ObjectiveVector", () => {
        expect(DEFAULT_OBJECTIVE_VECTOR).toEqual({
            task: 0,
            tokenEff: 0,
            memPrec: 0,
            toolAcc: 0,
        });
    });

    it("isObjectiveVector validates shape", () => {
        const valid: ObjectiveVector = { task: 50, tokenEff: 0.5, memPrec: 0.8, toolAcc: 0.9 };
        expect(isObjectiveVector(valid)).toBe(true);
        expect(isObjectiveVector({ task: 50 })).toBe(false);
        expect(isObjectiveVector(null)).toBe(false);
        expect(isObjectiveVector({ task: "x", tokenEff: 0, memPrec: 0, toolAcc: 0 })).toBe(false);
    });

    it("isParetoPoint requires all NSGA-II fields", () => {
        const p: ParetoPoint = {
            candidateId: "c0001",
            objectives: { task: 70, tokenEff: 0.6, memPrec: 0.7, toolAcc: 0.8 },
            dominatedBy: [],
            dominates: ["c0002"],
            rank: 1,
            crowdingDistance: Infinity,
        };
        expect(isParetoPoint(p)).toBe(true);
        expect(isParetoPoint({ ...p, rank: undefined })).toBe(false);
    });

    it("SeedConfig carries partial dimension records", () => {
        const seed: SeedConfig = {
            id: "aggressive-memory",
            description: "High memory recall weight",
            dimensions: { "memory.recall.k": 20 },
        };
        expect(seed.id).toBe("aggressive-memory");
        expect(seed.dimensions["memory.recall.k"]).toBe(20);
    });

    it("DimensionGradient accepts all severity levels", () => {
        const severities: DimensionGradient["severity"][] = ["critical", "moderate", "minor"];
        const directions: DimensionGradient["proposedDirection"][] = ["increase", "decrease", "rewrite"];
        for (const sev of severities) {
            for (const dir of directions) {
                const g: DimensionGradient = {
                    dimensionId: "memory.recall.k",
                    currentValue: 10,
                    critique: "too low",
                    proposedDirection: dir,
                    severity: sev,
                };
                expect(g.severity).toBe(sev);
                expect(g.proposedDirection).toBe(dir);
            }
        }
    });

    it("GpObservation ties numeric dims to a score", () => {
        const o: GpObservation = { dims: { "memory.recall.k": 10 }, score: 62 };
        expect(o.score).toBe(62);
    });

    it("OptimizeOptions carries usePareto + useSurrogate + useCodeSearch + useGradients", () => {
        const opts: OptimizeOptions = {
            budget: 20,
            fastMode: false,
            searchMode: "frontier",
            proposalBatchSize: 1,
            objective: "increase memory recall",
            usePareto: true,
            useSurrogate: true,
            useCodeSearch: true,
            useGradients: true,
        };
        expect(opts.usePareto).toBe(true);
        expect(opts.useSurrogate).toBe(true);
        expect(opts.useCodeSearch).toBe(true);
        expect(opts.useGradients).toBe(true);
    });

    it("OptimizeResult carries paretoFrontier + surrogateSkips", () => {
        const r: OptimizeResult = {
            runId: "run_x",
            runDir: "/tmp/x",
            bestCandidateId: "c0001",
            bestObjective: 72,
            candidateIds: ["c0000", "c0001"],
            iterationsRun: 2,
            durationMs: 1000,
            paretoFrontier: [],
            surrogateSkips: 0,
        };
        expect(r.paretoFrontier).toEqual([]);
        expect(r.surrogateSkips).toBe(0);
    });
});
