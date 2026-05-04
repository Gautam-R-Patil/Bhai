// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { CREDIT_COSTS, getCreditCost } from "./credit_cost.js";

describe("credit_cost", () => {
    describe("getCreditCost", () => {
        it("returns 0.25 for light-tier Haiku", () => {
            expect(getCreditCost("anthropic/claude-haiku-4.5")).toEqual(0.25);
        });

        it("returns 0.25 for light-tier Nova Micro", () => {
            expect(getCreditCost("amazon/nova-micro-v1")).toEqual(0.25);
        });

        it("returns 0.5 for mid-tier Nova Pro", () => {
            expect(getCreditCost("amazon/nova-pro-v1")).toEqual(0.5);
        });

        it("returns 1 for pro-tier Sonnet 4.6", () => {
            expect(getCreditCost("anthropic/claude-sonnet-4.6")).toEqual(1);
        });

        it("returns 1 for pro-tier GPT-4o", () => {
            expect(getCreditCost("gpt-4o")).toEqual(1);
        });

        it("returns 3 for heavy-tier Opus 4.6", () => {
            expect(getCreditCost("anthropic/claude-opus-4.6")).toEqual(3);
        });

        it("returns 3 for heavy-tier GPT-5 image", () => {
            expect(getCreditCost("openai/gpt-5-image")).toEqual(3);
        });

        it("returns the default (pro tier) for unknown models", () => {
            expect(getCreditCost("unknown-model-xyz")).toEqual(CREDIT_COSTS.default);
            expect(CREDIT_COSTS.default).toEqual(1);
        });

        it("returns the default for empty string rather than undefined", () => {
            // Defensive: a typo on the client should still bill, not bypass
            expect(getCreditCost("")).toEqual(CREDIT_COSTS.default);
        });

        it("is case-sensitive (model IDs are canonical strings)", () => {
            // OpenRouter IDs are lowercase. Deliberate: a wrong-case query
            // falls through to default rather than matching by accident.
            expect(getCreditCost("ANTHROPIC/CLAUDE-OPUS-4.6")).toEqual(CREDIT_COSTS.default);
        });

        it("does not return 0 for any known model", () => {
            // Regression guard: if someone adds a free tier it should be
            // explicit, not an accidental 0 that bypasses billing.
            for (const [modelId, cost] of Object.entries(CREDIT_COSTS)) {
                if (modelId === "default") continue;
                expect(cost, `cost for ${modelId}`).toBeGreaterThan(0);
            }
        });
    });

    describe("CREDIT_COSTS table invariants", () => {
        it("has a default entry", () => {
            expect(CREDIT_COSTS.default).toBeDefined();
            expect(typeof CREDIT_COSTS.default).toEqual("number");
        });

        it("uses only the 4 documented tiers (0.25, 0.5, 1, 3)", () => {
            const validTiers = new Set([0.25, 0.5, 1, 3]);
            for (const [modelId, cost] of Object.entries(CREDIT_COSTS)) {
                expect(validTiers.has(cost), `${modelId} -> ${cost} not in {0.25,0.5,1,3}`).toBe(
                    true,
                );
            }
        });

        it("every tier has at least one model", () => {
            const tiers = { light: 0, mid: 0, pro: 0, heavy: 0 };
            for (const [modelId, cost] of Object.entries(CREDIT_COSTS)) {
                if (modelId === "default") continue;
                if (cost === 0.25) tiers.light++;
                else if (cost === 0.5) tiers.mid++;
                else if (cost === 1) tiers.pro++;
                else if (cost === 3) tiers.heavy++;
            }
            expect(tiers.light).toBeGreaterThan(0);
            expect(tiers.mid).toBeGreaterThan(0);
            expect(tiers.pro).toBeGreaterThan(0);
            expect(tiers.heavy).toBeGreaterThan(0);
        });

        it("costs are exactly-representable binary floats (no float-epsilon drift on arithmetic)", () => {
            // Important for the credit-bypass fix in convex/http.ts:
            // the precise pre-check `account.ai_credits < cost` relies on
            // 0.25 / 0.5 / 1 / 3 being exact IEEE-754 doubles so subtraction
            // doesn't accumulate rounding error that could silently skip
            // billing over many requests.
            for (const cost of [0.25, 0.5, 1, 3]) {
                // 100 decrements of `cost` should equal 100*cost exactly.
                let bal = 100 * cost;
                for (let i = 0; i < 100; i++) bal -= cost;
                expect(bal).toEqual(0);
            }
        });
    });
});
