// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { MODELS } from "../llm.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterventionContext, MetaAssessment } from "./metacognition.js";
import { applyIntervention, createInterventionState } from "./metacognition.js";

// Mock the two paid arms so NO real network/LLM is ever touched. Each mock is a
// spy we assert against; default impls return benign shapes.
const replanMock = vi.fn(async (..._a: unknown[]) => ({ action: "replan", reason: "revised approach" }));
const multiCriticMock = vi.fn(async (..._a: unknown[]) => ({
    overall_score: 40,
    key_issues: ["[correctness] off by one"],
    consensus_suggestions: ["recheck the loop bound"],
    should_retry: true,
}));

vi.mock("./replanner.js", () => ({ replan: (...a: unknown[]) => replanMock(...a) }));
vi.mock("./multi-critic.js", () => ({
    runMultiCriticDebate: (...a: unknown[]) => multiCriticMock(...a),
}));

// A fake LLM whose chat() throws — proves zero-cost arms never call it, and that
// a throwing paid arm fails open without escaping applyIntervention.
function throwingLLM(): LLMClient {
    return {
        chat: vi.fn(async () => {
            throw new Error("LLM should not be called");
        }),
        config: {} as LLMClient["config"],
    } as unknown as LLMClient;
}

function assessment(intervention: MetaAssessment["intervention"], over: Partial<MetaAssessment> = {}): MetaAssessment {
    return {
        confidence: 0.3,
        struggleDetected: true,
        loopDetected: false,
        intervention,
        reasoning: "test reasoning",
        ...over,
    };
}

function makeCtx(
    intervention: MetaAssessment["intervention"],
    over: Partial<InterventionContext> = {},
    assessOver: Partial<MetaAssessment> = {},
): InterventionContext {
    const messages: ChatCompletionMessageParam[] = over.messages ?? [];
    return {
        llm: over.llm ?? throwingLLM(),
        assessment: assessment(intervention, assessOver),
        iterations: 10,
        totalToolCalls: 12,
        originalRequest: "do the thing",
        messages,
        recentToolNames: over.recentToolNames ?? [],
        taskType: over.taskType,
        onProgress: over.onProgress,
        state: over.state ?? createInterventionState(),
    };
}

const ORIG_ENV = process.env.BHAI_NO_META_INTERVENTIONS;

beforeEach(() => {
    replanMock.mockClear();
    multiCriticMock.mockClear();
    delete process.env.BHAI_NO_META_INTERVENTIONS;
});

afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.BHAI_NO_META_INTERVENTIONS;
    else process.env.BHAI_NO_META_INTERVENTIONS = ORIG_ENV;
});

describe("applyIntervention — hot-loop safety", () => {
    it('intervention "none" is a pure no-op with ZERO LLM cost', async () => {
        const ctx = makeCtx("none");
        await applyIntervention(ctx);
        expect(ctx.state.forcedModel).toBeNull();
        expect(ctx.messages).toHaveLength(0);
        expect((ctx.llm.chat as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(replanMock).not.toHaveBeenCalled();
        expect(multiCriticMock).not.toHaveBeenCalled();
    });

    it("BHAI_NO_META_INTERVENTIONS=true reverts to nudge-only (no-op)", async () => {
        process.env.BHAI_NO_META_INTERVENTIONS = "true";
        const ctx = makeCtx("replan"); // would otherwise be a paid arm
        await applyIntervention(ctx);
        expect(ctx.state.forcedModel).toBeNull();
        expect(ctx.messages).toHaveLength(0);
        expect(replanMock).not.toHaveBeenCalled();
        expect(multiCriticMock).not.toHaveBeenCalled();
    });
});

describe("applyIntervention — escalate arm (zero extra cost)", () => {
    it("sets forcedModel and pushes a breadcrumb, never calls the LLM", async () => {
        const ctx = makeCtx("escalate", {}, { confidence: 0.1 });
        await applyIntervention(ctx);
        expect(ctx.state.forcedModel).toBe(MODELS.PRO);
        expect(ctx.state.lastEscalateIter).toBe(10);
        expect(ctx.messages.some((m) => String(m.content).includes("ESCALATE"))).toBe(true);
        expect((ctx.llm.chat as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("picks SONNET when not struggling hard and no recent tools", async () => {
        const ctx = makeCtx(
            "escalate",
            { recentToolNames: [] },
            { confidence: 0.4, struggleDetected: false },
        );
        await applyIntervention(ctx);
        expect(ctx.state.forcedModel).toBe(MODELS.SONNET);
    });

    it("respects the cooldown — a second escalate within the window is a no-op", async () => {
        const state = createInterventionState();
        const ctx1 = makeCtx("escalate", { state }, { confidence: 0.1 });
        await applyIntervention(ctx1);
        expect(state.forcedModel).toBe(MODELS.PRO);

        // Consume forcedModel (as agent.ts does) then fire again 2 iters later.
        state.forcedModel = null;
        const ctx2 = makeCtx("escalate", { state }, { confidence: 0.1 });
        ctx2.iterations = 12; // within ESCALATE_COOLDOWN (5) of iter 10
        await applyIntervention(ctx2);
        expect(state.forcedModel).toBeNull();

        // Past the cooldown it fires again.
        const ctx3 = makeCtx("escalate", { state }, { confidence: 0.1 });
        ctx3.iterations = 16;
        await applyIntervention(ctx3);
        expect(state.forcedModel).toBe(MODELS.PRO);
    });
});

describe("applyIntervention — replan arm (one gated Pro call)", () => {
    it("calls replan exactly once and injects a [SYSTEM — REPLAN] message", async () => {
        const ctx = makeCtx("replan");
        ctx.messages.push({ role: "assistant", content: "I tried approach X but it failed." });
        await applyIntervention(ctx);
        expect(replanMock).toHaveBeenCalledTimes(1);
        expect(ctx.messages.some((m) => String(m.content).includes("[SYSTEM — REPLAN]"))).toBe(true);
        expect(ctx.messages.some((m) => String(m.content).includes("revised approach"))).toBe(true);
    });

    it("respects the cooldown — a second replan within the window is a no-op", async () => {
        const state = createInterventionState();
        const ctx1 = makeCtx("replan", { state });
        await applyIntervention(ctx1);
        expect(replanMock).toHaveBeenCalledTimes(1);

        const ctx2 = makeCtx("replan", { state });
        ctx2.iterations = 14; // within REPLAN_COOLDOWN (6) of iter 10
        await applyIntervention(ctx2);
        expect(replanMock).toHaveBeenCalledTimes(1);

        const ctx3 = makeCtx("replan", { state });
        ctx3.iterations = 17; // past the cooldown
        await applyIntervention(ctx3);
        expect(replanMock).toHaveBeenCalledTimes(2);
    });
});

describe("applyIntervention — critics arm", () => {
    it("WITHOUT a verifier in scope downgrades to escalate (no multi-critic)", async () => {
        const ctx = makeCtx("critics", { recentToolNames: ["read", "edit"], taskType: "general" });
        await applyIntervention(ctx);
        expect(multiCriticMock).not.toHaveBeenCalled();
        expect(ctx.state.forcedModel).not.toBeNull();
        expect(ctx.messages.some((m) => String(m.content).includes("ESCALATE"))).toBe(true);
    });

    it("WITH browser_verify in scope fires multi-critic and injects key_issues", async () => {
        const ctx = makeCtx("critics", { recentToolNames: ["browser_verify"] });
        ctx.messages.push({ role: "assistant", content: "Built the feature." });
        await applyIntervention(ctx);
        expect(multiCriticMock).toHaveBeenCalledTimes(1);
        expect(ctx.messages.some((m) => String(m.content).includes("[SYSTEM — CRITICS]"))).toBe(true);
        expect(ctx.messages.some((m) => String(m.content).includes("off by one"))).toBe(true);
    });

    it("taskType coding fires multi-critic even with no verifier tool", async () => {
        const ctx = makeCtx("critics", { recentToolNames: [], taskType: "coding" });
        await applyIntervention(ctx);
        expect(multiCriticMock).toHaveBeenCalledTimes(1);
    });

    it("respects the critics cooldown (in scope) — second within window is a no-op", async () => {
        const state = createInterventionState();
        const ctx1 = makeCtx("critics", { state, recentToolNames: ["browser_verify"] });
        await applyIntervention(ctx1);
        expect(multiCriticMock).toHaveBeenCalledTimes(1);

        const ctx2 = makeCtx("critics", { state, recentToolNames: ["browser_verify"] });
        ctx2.iterations = 15; // within CRITICS_COOLDOWN (8) of iter 10
        await applyIntervention(ctx2);
        expect(multiCriticMock).toHaveBeenCalledTimes(1);

        const ctx3 = makeCtx("critics", { state, recentToolNames: ["browser_verify"] });
        ctx3.iterations = 19; // past the cooldown
        await applyIntervention(ctx3);
        expect(multiCriticMock).toHaveBeenCalledTimes(2);
    });
});

describe("applyIntervention — ask_user arm (feedback-first, free)", () => {
    it("first arm pushes ONE rephrase nudge, no LLM, no onProgress", async () => {
        const onProgress = vi.fn();
        const ctx = makeCtx("ask_user", { onProgress });
        await applyIntervention(ctx);
        expect(ctx.state.askUserNudges).toBe(1);
        expect(ctx.messages.some((m) => String(m.content).includes("Do NOT ask the user yet"))).toBe(true);
        expect(onProgress).not.toHaveBeenCalled();
        expect((ctx.llm.chat as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("after the rephrase budget it surfaces a clarifying question via onProgress (no LLM)", async () => {
        const state = createInterventionState();
        const onProgress = vi.fn();
        for (let i = 0; i < 2; i++) {
            await applyIntervention(makeCtx("ask_user", { state, onProgress }));
        }
        expect(state.askUserNudges).toBe(2);
        expect(onProgress).not.toHaveBeenCalled();

        await applyIntervention(makeCtx("ask_user", { state, onProgress }));
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(String(onProgress.mock.calls[0][0])).toContain("I'm having trouble");
    });
});

describe("applyIntervention — fail-open", () => {
    it("a throwing replan does NOT escape applyIntervention", async () => {
        replanMock.mockRejectedValueOnce(new Error("boom"));
        const ctx = makeCtx("replan");
        await expect(applyIntervention(ctx)).resolves.toBeUndefined();
    });

    it("a throwing multi-critic does NOT escape applyIntervention", async () => {
        multiCriticMock.mockRejectedValueOnce(new Error("boom"));
        const ctx = makeCtx("critics", { recentToolNames: ["browser_verify"] });
        await expect(applyIntervention(ctx)).resolves.toBeUndefined();
    });
});
