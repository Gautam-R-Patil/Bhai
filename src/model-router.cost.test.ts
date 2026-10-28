// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { isNativeRouterLoaded, selectModel } from "./model-router.js";

// Cost-aware routing: the cheapest user-facing rungs route to GPT-5
// nano/mini, plain single-turn chat never reaches Opus, and the
// ATLAS_NO_COST_ROUTING env net caps Opus→Sonnet at the TS layer even
// against a stale native binary. These assume the native binary is built
// (npm run build:native); they verify the wired contract, not the JS
// fallback (which sends every turn to Haiku), so those skip without it.
const withNative = it.skipIf(!isNativeRouterLoaded());

describe("cost-aware routing tiers", () => {
    withNative("trivial casual chat routes to a cheap OpenAI rung, not Claude", () => {
        const r = selectModel({ message: "tell me a bit about what you can do", iteration: 1 });
        expect(["openai/gpt-4.1-nano", "openai/gpt-5-nano", "openai/gpt-5-mini"]).toContain(r.modelId);
        expect(r.modelId).not.toContain("claude");
    });

    withNative("background synthesis routes to DeepSeek (cheap, user never sees prose)", () => {
        const r = selectModel({ taskType: "synthesis", message: "merge these findings", iteration: 1 });
        expect(r.modelId).toBe("deepseek/deepseek-chat-v3.1");
    });

    it("never routes a low-personality plain chat turn to Opus", () => {
        for (const msg of [
            "what's the weather like in a sentence",
            "give me a quick summary of recursion",
            "list three fun facts about cats",
        ]) {
            const r = selectModel({ message: msg, iteration: 1 });
            expect(r.modelId).not.toBe("anthropic/claude-opus-4.6");
        }
    });

    it("ATLAS_NO_COST_ROUTING does not crash and yields a valid model", () => {
        const prev = process.env.ATLAS_NO_COST_ROUTING;
        process.env.ATLAS_NO_COST_ROUTING = "true";
        try {
            const r = selectModel({ message: "hi there friend", iteration: 1 });
            expect(typeof r.modelId).toBe("string");
            expect(r.modelId.length).toBeGreaterThan(0);
        } finally {
            if (prev === undefined) delete process.env.ATLAS_NO_COST_ROUTING;
            else process.env.ATLAS_NO_COST_ROUTING = prev;
        }
    });
});
