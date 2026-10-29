// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import {
    classifyOrchestratorComplexity,
    pickOrchestratorModel,
    claudeTier,
    type OrchestratorSignals,
} from "./model-router.js";
import { MODELS } from "./llm.js";

function sig(over: Partial<OrchestratorSignals> = {}): OrchestratorSignals {
    return {
        activeCategories: ["os_control", "app_management", "communication"],
        classifierConfidence: 0.9,
        intent: "general",
        actionCategoryCount: 2,
        ...over,
    };
}

describe("classifyOrchestratorComplexity — 3-tier orchestrator router", () => {
    describe("simple (→ DeepSeek)", () => {
        it.each([
            "open WhatsApp",
            "play Bohemian Rhapsody on Spotify",
            "send AP a message saying gym at 6",
            "search for the nearest coffee shop",
            "mute the volume",
            "turn off do not disturb",
        ])("`%s` → simple", (msg) => {
            expect(classifyOrchestratorComplexity(msg, sig({ actionCategoryCount: 2 }))).toBe("simple");
        });

        it("requires high confidence — medium confidence falls to mild", () => {
            expect(classifyOrchestratorComplexity("open WhatsApp", sig({ classifierConfidence: 0.6 }))).toBe(
                "mild",
            );
        });
    });

    describe("complex (→ Sonnet)", () => {
        it.each([
            "open Figma and align the buttons on the canvas",
            "sculpt a low-poly tree in Blender and render it",
            "place a block in Minecraft next to the door",
        ])("`%s` (vision/canvas) → complex", (msg) => {
            expect(classifyOrchestratorComplexity(msg, sig({ actionCategoryCount: 1 }))).toBe("complex");
        });

        it("browser + desktop mix → complex", () => {
            expect(
                classifyOrchestratorComplexity("look up the address online then text it to mom", sig({
                    activeCategories: ["browser", "communication"],
                    actionCategoryCount: 2,
                })),
            ).toBe("complex");
        });

        it.each([
            "figure out the best way to organize all my downloads",
            "migrate all my notes into the new app",
            "clean up everything in my downloads folder",
        ])("`%s` (ambiguous high-stakes) → complex", (msg) => {
            expect(classifyOrchestratorComplexity(msg, sig())).toBe("complex");
        });

        it("long + low-confidence → complex", () => {
            const long = `I want you to ${"go through my open tabs and ".repeat(20)} and decide what matters`;
            expect(classifyOrchestratorComplexity(long, sig({ classifierConfidence: 0.5 }))).toBe("complex");
        });

        it(">=3 action categories with low confidence → complex", () => {
            expect(
                classifyOrchestratorComplexity("do the thing across the apps", sig({
                    actionCategoryCount: 3,
                    classifierConfidence: 0.5,
                })),
            ).toBe("complex");
        });
    });

    describe("mild (→ Gemini Pro) — asymmetric catch-all", () => {
        it.each([
            "open the spreadsheet and then add up the totals and email it",
            "find my flight, then check me in, and add it to my calendar",
        ])("`%s` (chained, no escalation trigger) → mild", (msg) => {
            expect(classifyOrchestratorComplexity(msg, sig({ actionCategoryCount: 2 }))).toBe("mild");
        });

        it("non-verb-initial moderate task → mild (never cheap when unsure)", () => {
            expect(
                classifyOrchestratorComplexity("the report needs the latest numbers pulled in", sig()),
            ).toBe("mild");
        });

        it("empty message → mild (safe middle)", () => {
            expect(classifyOrchestratorComplexity("", sig())).toBe("mild");
        });
    });

    describe("vision-canvas gating", () => {
        it("chat-only mention of a game with no action category does NOT escalate to complex", () => {
            // "what..." is verb-initial, short, high-conf, 0 action cats → simple.
            // The point: the vision-canvas keyword must NOT force complex without an action.
            expect(
                classifyOrchestratorComplexity("what was the score of the game last night?", sig({
                    activeCategories: [],
                    actionCategoryCount: 0,
                })),
            ).not.toBe("complex");
        });
    });
});

describe("claudeTier — which Claude model an id runs on", () => {
    it("matches the proxy's mapping, including gemini not being 'mini'", () => {
        expect(claudeTier(MODELS.PRO)).toBe("opus");
        expect(claudeTier(MODELS.GEMINI_PRO)).toBe("sonnet");
        expect(claudeTier(MODELS.FLASH_LITE)).toBe("haiku");
        expect(claudeTier(MODELS.GPT5_MINI)).toBe("haiku");
        expect(claudeTier(MODELS.DEEPSEEK_V4_PRO)).toBe("sonnet");
    });
});

describe("pickOrchestratorModel — tier → model", () => {
    it("simple → Haiku, thinking off", () => {
        const p = pickOrchestratorModel("simple");
        expect(p.model).toBe(MODELS.HAIKU);
        expect(p.thinkingLevel).toBe("off");
    });

    it("mild → Haiku, thinking low", () => {
        const p = pickOrchestratorModel("mild");
        expect(p.model).toBe(MODELS.HAIKU);
        expect(p.thinkingLevel).toBe("low");
    });

    it("complex → Sonnet 4.6, thinking low", () => {
        const p = pickOrchestratorModel("complex");
        expect(p.model).toBe(MODELS.SONNET);
        expect(p.thinkingLevel).toBe("low");
    });
});
