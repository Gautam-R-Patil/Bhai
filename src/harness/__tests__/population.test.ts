// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ATLAS_SEED_CONFIGS, initializePopulation } from "../population.js";
import { HarnessRunStore } from "../run-store.js";
import type { LLMClient } from "../../llm.js";
import type { HarnessScore } from "../types.js";

vi.mock("../evaluator.js", () => ({
    evaluateCandidate: vi.fn(async (_llm: unknown, candidateId: string): Promise<HarnessScore> => ({
        candidateId,
        composite: 50 + Math.random() * 30,
        memoryRecallScore: 0.6,
        toolSelectionScore: 0.7,
        taskCompletionScore: 65,
        researchQualityScore: 0.55,
        tokenEfficiency: 0.5,
        tokensUsed: 12000,
        timestamp: new Date().toISOString(),
    })),
}));

const fakeLLM = {} as LLMClient;

describe("population", () => {
    let runDir: string;
    let store: HarnessRunStore;

    beforeEach(() => {
        const tmp = mkdtempSync(join(tmpdir(), "atlas-harness-pop-"));
        process.env.ATLAS_DATA_DIR = tmp;
        runDir = tmp;
        store = new HarnessRunStore();
        store.initializeRun({ budget: 5, fastMode: true, searchMode: "hill-climb", proposalBatchSize: 1, objective: "test" });
    });

    afterEach(() => {
        delete process.env.ATLAS_DATA_DIR;
        try { rmSync(runDir, { recursive: true, force: true }); } catch { /* */ }
        vi.clearAllMocks();
    });

    it("exposes exactly 4 seed configs with unique ids", () => {
        expect(ATLAS_SEED_CONFIGS).toHaveLength(4);
        const ids = ATLAS_SEED_CONFIGS.map(s => s.id);
        expect(new Set(ids).size).toBe(4);
        expect(ids).toContain("baseline-defaults");
        expect(ids).toContain("memory-aggressive");
        expect(ids).toContain("tool-conservative");
        expect(ids).toContain("evaluator-strict");
    });

    it("materializes all 4 seeds as candidates c0000-c0003", async () => {
        const manifests = await initializePopulation(store, fakeLLM, true);
        expect(manifests).toHaveLength(4);
        const ids = manifests.map(m => m.candidateId).sort();
        expect(ids).toEqual(["c0000", "c0001", "c0002", "c0003"]);
    });

    it("writes manifest.json + scores.json + harness-config.json per seed", async () => {
        await initializePopulation(store, fakeLLM, true);
        for (const id of ["c0000", "c0001", "c0002", "c0003"]) {
            const dir = join(store.runDir, "candidates", id);
            expect(existsSync(join(dir, "manifest.json"))).toBe(true);
            expect(existsSync(join(dir, "scores.json"))).toBe(true);
            expect(existsSync(join(dir, "harness-config.json"))).toBe(true);
        }
    });

    it("evaluates all seeds in parallel", async () => {
        const evalMod = await import("../evaluator.js");
        const spy = vi.mocked(evalMod.evaluateCandidate);
        await initializePopulation(store, fakeLLM, true);
        expect(spy).toHaveBeenCalledTimes(4);
    });

    it("returns only valid (scored) manifests", async () => {
        const manifests = await initializePopulation(store, fakeLLM, true);
        for (const m of manifests) {
            expect(m.valid).toBe(true);
            expect(m.scores).not.toBeNull();
            expect(m.objective).not.toBeNull();
            expect(["baseline", "keep"]).toContain(m.outcome);
        }
    });

    it("baseline-defaults seed produces an empty dimensions override", () => {
        const seed = ATLAS_SEED_CONFIGS.find(s => s.id === "baseline-defaults");
        expect(seed).toBeDefined();
        expect(Object.keys(seed!.dimensions)).toHaveLength(0);
    });

    it("memory-aggressive seed sets memory.recall.k=15 and fusion weights", () => {
        const seed = ATLAS_SEED_CONFIGS.find(s => s.id === "memory-aggressive");
        expect(seed!.dimensions["memory.recall.k"]).toBe(15);
        expect(seed!.dimensions["memory.fusion.relevanceWeight"]).toBe(0.4);
        expect(seed!.dimensions["memory.fusion.recencyWeight"]).toBe(0.4);
        expect(seed!.dimensions["memory.fusion.importanceWeight"]).toBe(0.2);
    });

    it("propagates progress messages via onProgress callback", async () => {
        const messages: string[] = [];
        await initializePopulation(store, fakeLLM, true, async (msg) => { messages.push(msg); });
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.some(m => m.toLowerCase().includes("seed"))).toBe(true);
    });

    it("tolerates a single seed evaluation failure without aborting population", async () => {
        const evalMod = await import("../evaluator.js");
        const spy = vi.mocked(evalMod.evaluateCandidate);
        spy.mockReset();
        spy.mockImplementation(async (_llm, cid) => {
            if (cid === "c0002") throw new Error("simulated eval crash");
            return {
                candidateId: cid, composite: 60, memoryRecallScore: 0.6,
                toolSelectionScore: 0.7, taskCompletionScore: 65,
                researchQualityScore: 0.55, tokenEfficiency: 0.5,
                tokensUsed: 12000, timestamp: new Date().toISOString(),
            };
        });
        const manifests = await initializePopulation(store, fakeLLM, true);
        expect(manifests.length).toBe(3);
        expect(manifests.map(m => m.candidateId)).not.toContain("c0002");
    });

    it("dimensions from each seed are reflected in harness-config.json", async () => {
        await initializePopulation(store, fakeLLM, true);
        const aggressivePath = join(store.runDir, "candidates", "c0001", "harness-config.json");
        const raw = readFileSync(aggressivePath, "utf-8");
        const cfg = JSON.parse(raw);
        expect(cfg.dimensions["memory.recall.k"]).toBe(15);
    });
});
