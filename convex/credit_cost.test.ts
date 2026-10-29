// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { CREDIT_COSTS, getCreditCost } from "./credit_cost.js";

describe("credit_cost", () => {
    describe("getCreditCost", () => {
        it("charges by the Claude model the request actually runs on", () => {
            expect(getCreditCost("anthropic/claude-haiku-4.5")).toEqual(0.25);
            expect(getCreditCost("openai/gpt-5-nano")).toEqual(0.25);
            expect(getCreditCost("anthropic/claude-sonnet-4.6")).toEqual(1);
            expect(getCreditCost("deepseek/deepseek-v4-pro")).toEqual(1);
            expect(getCreditCost("google/gemini-3.1-pro-preview-customtools")).toEqual(1);
            expect(getCreditCost("anthropic/claude-opus-4.6")).toEqual(2);
        });

        it("bills unknown and empty IDs at the Sonnet rate, never zero", () => {
            expect(getCreditCost("unknown-model-xyz")).toEqual(1);
            expect(getCreditCost("")).toEqual(1);
        });

        it("costs are exactly-representable binary floats (no float-epsilon drift on arithmetic)", () => {
            // The precise pre-check `account.ai_credits < cost` in convex/http.ts
            // relies on these being exact IEEE-754 doubles.
            for (const cost of Object.values(CREDIT_COSTS)) {
                let bal = 100 * cost;
                for (let i = 0; i < 100; i++) bal -= cost;
                expect(bal).toEqual(0);
            }
        });
    });
});
