// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it, vi } from "vitest";
import type { LLMClient } from "../../../llm.js";
import type { Timeline } from "../../analyze/timeline-builder.js";
import { PlanValidationError, planEdit } from "../planner.js";

const MOCK_TIMELINE = {
    videoPath: "inputs/clip1.mp4",
    duration: 42.1,
    fps: 30,
    resolution: "1920x1080",
    width: 1920,
    height: 1080,
    scenes: [
        { index: 0, start: 0, end: 20, duration: 20 },
        { index: 1, start: 20, end: 42.1, duration: 22.1 },
    ],
    keyframes: [
        { sceneIndex: 0, timestamp: 10, imagePath: "/p/s0.jpg", caption: "Person talking" },
        { sceneIndex: 1, timestamp: 31, imagePath: "/p/s1.jpg", caption: "Person walks away" },
    ],
    transcript: {
        language: "en",
        segments: [
            {
                start: 0,
                end: 2,
                text: "Hello world",
                words: [
                    { start: 0.5, end: 0.9, word: "Hello", confidence: 0.95 },
                    { start: 1.0, end: 1.3, word: "world", confidence: 0.95 },
                ],
            },
        ],
    },
} as unknown as Timeline;

const VALID_PLAN_JSON = JSON.stringify({
    projectId: "vid_test_01",
    output: { path: "renders/final.mp4", aspect: "9:16", fps: 30, resolution: "1080x1920" },
    sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 42.1 }],
    tracks: { video: [{ id: "v1", source: "s1", in: 0, out: 20 }], audio: [], overlays: [] },
    transitions: [],
    export_targets: ["mp4"],
});

const INVALID_PLAN_JSON = JSON.stringify({
    projectId: "vid_test_01",
    output: { path: "renders/final.mp4", fps: 30, resolution: "1080x1920" },
    sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 42.1 }],
    tracks: { video: [{ id: "v1", source: "s1", in: 0, out: 20 }] },
    transitions: [],
    export_targets: ["mp4"],
});

function makeMockLLM(responses: string[]): LLMClient {
    let call = 0;
    return {
        config: {} as never,
        chat: vi.fn().mockImplementation(async () => {
            const text = responses[call] ?? responses[responses.length - 1];
            call++;
            return {
                choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            };
        }),
    } as unknown as LLMClient;
}

describe("planEdit", () => {
    it("returns a valid EditPlan when LLM responds with correct JSON on first call", async () => {
        const llm = makeMockLLM([VALID_PLAN_JSON]);
        const plan = await planEdit({
            llm,
            timeline: MOCK_TIMELINE,
            userIntent: "20s highlight",
            projectId: "vid_test_01",
        });
        expect(plan.projectId).toBe("vid_test_01");
        expect(plan.tracks.video).toHaveLength(1);
        expect(llm.chat).toHaveBeenCalledTimes(1);
    });

    it("triggers auto-repair when first response fails validation and succeeds on repair", async () => {
        const llm = makeMockLLM([INVALID_PLAN_JSON, VALID_PLAN_JSON]);
        const plan = await planEdit({
            llm,
            timeline: MOCK_TIMELINE,
            userIntent: "short clip",
            projectId: "vid_test_01",
        });
        expect(plan.projectId).toBe("vid_test_01");
        expect(llm.chat).toHaveBeenCalledTimes(2);
    });

    it("throws PlanValidationError after two consecutive validation failures", async () => {
        const llm = makeMockLLM([INVALID_PLAN_JSON, INVALID_PLAN_JSON]);
        await expect(
            planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" }),
        ).rejects.toThrow(PlanValidationError);
        expect(llm.chat).toHaveBeenCalledTimes(2);
    });

    it("PlanValidationError carries lastAttempt and validationErrors", async () => {
        const llm = makeMockLLM([INVALID_PLAN_JSON, INVALID_PLAN_JSON]);
        let caught: PlanValidationError | undefined;
        try {
            await planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" });
        } catch (e) {
            if (e instanceof PlanValidationError) caught = e;
        }
        expect(caught).toBeDefined();
        expect(caught?.lastAttempt).toBeDefined();
        expect(Array.isArray(caught?.validationErrors)).toBe(true);
        expect(caught?.validationErrors.length).toBeGreaterThan(0);
    });

    it("throws PlanValidationError when LLM returns prose (no JSON) both times", async () => {
        const llm = makeMockLLM(["I cannot help with that.", "Still no JSON here."]);
        await expect(
            planEdit({ llm, timeline: MOCK_TIMELINE, userIntent: "short clip", projectId: "vid_test_01" }),
        ).rejects.toThrow(PlanValidationError);
    });
});
