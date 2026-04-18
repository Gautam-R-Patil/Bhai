// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LLMClient } from "../../../llm.js";
import { PlanValidationError } from "../planner.js";
import type { EditPlan } from "../schema.js";
import { checkDurations, checkSourcesExist, checkTransitionBetweenExists, repairPlan } from "../validator.js";

const TEST_ROOT = join(tmpdir(), `atlas-validator-test-${process.pid}`);
const existingPath = "existing.mp4";
const missingPath = "missing.mp4";

function makePlan(overrides: Partial<EditPlan> = {}): EditPlan {
    const base: EditPlan = {
        projectId: "vid_test_01",
        output: { path: "renders/out.mp4", aspect: "16:9", fps: 30, resolution: "1920x1080" },
        sources: [{ id: "s1", path: existingPath, duration: 10 }],
        tracks: {
            video: [{ id: "v1", source: "s1", in: 0, out: 5 }],
            audio: [],
            overlays: [],
        },
        transitions: [],
        export_targets: ["mp4"],
    };
    return { ...base, ...overrides };
}

beforeAll(async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await fs.writeFile(join(TEST_ROOT, existingPath), "fake-mp4", "utf-8");
});

afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("checkSourcesExist", () => {
    it("returns ok when all sources exist", async () => {
        const plan = makePlan();
        const result = await checkSourcesExist(plan, TEST_ROOT);
        expect(result.ok).toBe(true);
    });

    it("collects errors for all missing sources in parallel", async () => {
        const plan = makePlan({
            sources: [
                { id: "s1", path: existingPath, duration: 10 },
                { id: "s2", path: missingPath, duration: 10 },
                { id: "s3", path: "also_missing.mp4", duration: 10 },
            ],
        });
        const result = await checkSourcesExist(plan, TEST_ROOT);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors).toHaveLength(2);
            expect(result.errors.some((e) => e.includes("s2"))).toBe(true);
            expect(result.errors.some((e) => e.includes("s3"))).toBe(true);
        }
    });

    it("honors absolute paths without resolving against projectRoot", async () => {
        const absPath = join(TEST_ROOT, existingPath);
        const plan = makePlan({ sources: [{ id: "s1", path: absPath, duration: 10 }] });
        const result = await checkSourcesExist(plan, "/nonexistent/root");
        expect(result.ok).toBe(true);
    });
});

describe("checkDurations", () => {
    it("returns ok when all clips are within source duration", () => {
        const plan = makePlan();
        expect(checkDurations(plan).ok).toBe(true);
    });

    it("flags clip with in >= out", () => {
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "s1", in: 5, out: 3 }],
                audio: [],
                overlays: [],
            },
        });
        const result = checkDurations(plan);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toContain("in=5 >= out=3");
    });

    it("flags clip with out > source duration", () => {
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "s1", in: 0, out: 100 }],
                audio: [],
                overlays: [],
            },
        });
        const result = checkDurations(plan);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toContain("exceeds");
    });

    it("flags clip referencing unknown source", () => {
        const plan = makePlan({
            tracks: {
                video: [{ id: "v1", source: "ghost", in: 0, out: 5 }],
                audio: [],
                overlays: [],
            },
        });
        const result = checkDurations(plan);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toContain("unknown source");
    });
});

describe("checkTransitionBetweenExists", () => {
    it("returns ok when all transitions reference existing videos", () => {
        const plan = makePlan({
            tracks: {
                video: [
                    { id: "v1", source: "s1", in: 0, out: 5 },
                    { id: "v2", source: "s1", in: 5, out: 10 },
                ],
                audio: [],
                overlays: [],
            },
            transitions: [{ between: ["v1", "v2"], type: "xfade", kind: "fade", duration: 0.5 }],
        });
        expect(checkTransitionBetweenExists(plan).ok).toBe(true);
    });

    it("flags transition referencing missing video id", () => {
        const plan = makePlan({
            transitions: [{ between: ["v1", "ghost"], type: "xfade", kind: "fade", duration: 0.5 }],
        });
        const result = checkTransitionBetweenExists(plan);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toContain("ghost");
    });

    it("returns ok when transitions array is empty", () => {
        const plan = makePlan({ transitions: [] });
        expect(checkTransitionBetweenExists(plan).ok).toBe(true);
    });
});

describe("repairPlan", () => {
    const VALID_REPAIRED = JSON.stringify({
        projectId: "vid_test_01",
        output: { path: "renders/out.mp4", aspect: "9:16", fps: 30, resolution: "1080x1920" },
        sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 10 }],
        tracks: { video: [{ id: "v1", source: "s1", in: 0, out: 5 }], audio: [], overlays: [] },
        transitions: [],
        export_targets: ["mp4"],
    });

    function makeMockLLM(response: string): LLMClient {
        return {
            config: {} as never,
            chat: vi.fn().mockResolvedValue({
                choices: [{ message: { role: "assistant", content: response }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
        } as unknown as LLMClient;
    }

    it("returns a validated EditPlan when LLM repairs successfully", async () => {
        const llm = makeMockLLM(VALID_REPAIRED);
        const plan = await repairPlan(llm, { broken: true }, ["output.aspect is required"]);
        expect(plan.projectId).toBe("vid_test_01");
    });

    it("throws PlanValidationError when LLM response contains no JSON", async () => {
        const llm = makeMockLLM("Sorry, I cannot help with that.");
        await expect(repairPlan(llm, { broken: true }, ["output.aspect is required"])).rejects.toThrow(
            PlanValidationError,
        );
    });

    it("throws PlanValidationError when repaired JSON still fails Zod", async () => {
        const stillBroken = JSON.stringify({
            projectId: "x",
            output: {},
            sources: [],
            tracks: { video: [] },
            export_targets: [],
        });
        const llm = makeMockLLM(stillBroken);
        await expect(repairPlan(llm, { broken: true }, ["lots of errors"])).rejects.toThrow(PlanValidationError);
    });
});
