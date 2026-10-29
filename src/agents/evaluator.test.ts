// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluator.js";
import type { LLMClient } from "../llm.js";
import type { SubAgentResult } from "./sub-agent.js";

// Minimal LLMClient stub that returns a fixed JSON body from .chat().
function mockLlm(body: Record<string, unknown>): LLMClient {
    return {
        chat: async () => ({
            choices: [{ message: { content: JSON.stringify(body) } }],
        }),
    } as unknown as LLMClient;
}

const noSteps = new Map<string, SubAgentResult>();

describe("evaluate — rubric coercion (no `|| 70` clobber)", () => {
    it("keeps legitimate 0 scores (does not map 0 → 70)", async () => {
        const llm = mockLlm({
            completeness: 0, accuracy: 0, coherence: 0, actionability: 0,
            feedback: "wrong", verdict: "replan",
        });
        const r = await evaluate(llm, "req", "bad synthesis", noSteps);
        expect(r.rubric.completeness).toEqual(0);
        expect(r.score).toEqual(0);
    });

    it("a null (omitted) dimension defaults to 70, not 0", async () => {
        const llm = mockLlm({
            completeness: null, accuracy: 90, coherence: 90, actionability: 90,
            feedback: "", verdict: "accept",
        });
        const r = await evaluate(llm, "req", "synthesis", noSteps);
        expect(r.rubric.completeness).toEqual(70);
        expect(r.score).toEqual(85);
    });

    it("non-numeric rubric values default to 70, never NaN", async () => {
        const llm = mockLlm({
            completeness: "excellent", accuracy: "high", coherence: "ok", actionability: "great",
            feedback: "", verdict: "accept",
        });
        const r = await evaluate(llm, "req", "synthesis", noSteps);
        expect(Number.isFinite(r.score)).toBe(true);
        expect(r.score).toEqual(70);
    });
});

describe("evaluate — verdict is derived from score, not self-reported", () => {
    it("ignores a model-claimed 'accept' when the score fails the threshold", async () => {
        const llm = mockLlm({
            completeness: 10, accuracy: 10, coherence: 10, actionability: 10,
            feedback: "", verdict: "accept",
        });
        const r = await evaluate(llm, "req", "synthesis", noSteps);
        expect(r.score).toEqual(10);
        expect(r.verdict).toEqual("replan"); // 10 < retry threshold → replan, not the claimed "accept"
    });

    it("lets the model ESCALATE: 'replan' on a high score wins over score's 'accept'", async () => {
        const llm = mockLlm({
            completeness: 95, accuracy: 95, coherence: 95, actionability: 95,
            feedback: "structurally wrong despite the numbers", verdict: "replan",
        });
        const r = await evaluate(llm, "req", "synthesis", noSteps);
        expect(r.score).toEqual(95);
        expect(r.verdict).toEqual("replan");
    });
});
