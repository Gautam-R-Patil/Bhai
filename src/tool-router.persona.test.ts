// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Persona overlay integration test for the tool-router scoring loop.
// Doesn't run the full router (LLM + embeddings); validates the pure
// overlay behaviour by exercising getPersonaToolWeights against the
// real category names from tool-router.ts.

import { describe, it, expect } from "vitest";
import { getPersonaToolWeights, applyPersonaWeight } from "./prompts/persona-bias.js";

// These are the real category IDs from src/tool-router.ts. Listed here
// to lock the integration contract — if any of these names change in
// tool-router.ts, persona-bias.ts must change in lockstep.
const REAL_CATEGORIES = [
    "core", "memory", "shell", "file_system", "coding", "browser",
    "web_search", "os_control", "system_controls", "media",
    "video_editing", "presentation", "communication", "scheduling",
    "app_management", "research", "long_tasks", "google_api",
    "github", "code_execution", "codebase", "tool_creation",
    "document", "marketing",
];

describe("persona overlay — score reordering", () => {
    it("developer reorders [coding, marketing] when scores are close", () => {
        // Mimic the relevant slice of tool-router state.
        const scores = [
            { category: "marketing", score: 0.55 },
            { category: "coding",    score: 0.50 },
        ];
        // No persona: marketing wins (higher base score).
        const noPersona = [...scores].sort((a, b) => b.score - a.score);
        expect(noPersona[0].category).toBe("marketing");

        // Developer persona: coding gets ×1.35, marketing untouched.
        const withDev = scores.map((s) => ({
            ...s,
            score: applyPersonaWeight("developer", s.category, s.score),
        })).sort((a, b) => b.score - a.score);
        expect(withDev[0].category).toBe("coding");
    });

    it("explorer is a no-op (ordering unchanged)", () => {
        const scores = [
            { category: "marketing", score: 0.55 },
            { category: "coding",    score: 0.50 },
        ];
        const withExplorer = scores.map((s) => ({
            ...s,
            score: applyPersonaWeight("explorer", s.category, s.score),
        })).sort((a, b) => b.score - a.score);
        expect(withExplorer[0].category).toBe("marketing");
        expect(withExplorer.map((s) => s.score)).toEqual([0.55, 0.50]);
    });

    it("researcher boosts research-cluster scores over creative ones", () => {
        const scores = [
            { category: "media",      score: 0.60 },
            { category: "research",   score: 0.55 },
            { category: "web_search", score: 0.50 },
        ];
        // Without persona, ordering is media > research > web_search.
        // With researcher, research (×1.4) and web_search (×1.3) overtake media.
        const withResearcher = scores.map((s) => ({
            ...s,
            score: applyPersonaWeight("researcher", s.category, s.score),
        })).sort((a, b) => b.score - a.score);
        expect(withResearcher[0].category).toBe("research");
        // web_search at 0.50 * 1.3 = 0.65 also beats media at 0.60.
        expect(withResearcher[1].category).toBe("web_search");
        expect(withResearcher[2].category).toBe("media");
    });

    it("every weighted category in every persona maps to a real tool-router category", () => {
        const realSet = new Set(REAL_CATEGORIES);
        const personas = ["developer", "founder", "creator", "researcher", "explorer"] as const;
        for (const p of personas) {
            const w = getPersonaToolWeights(p);
            for (const cat of Object.keys(w)) {
                expect(realSet, `persona=${p} cat=${cat} is not a real tool-router category`).toContain(cat);
            }
        }
    });
});
