// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { selectModel, selectForToolSynthesis, MODEL_REGISTRY } from "../../model-router.js";

describe("tool_synthesis task type", () => {
    it("selectModel accepts taskType='tool_synthesis'", () => {
        const r = selectModel({ taskType: "tool_synthesis" });
        expect(r.modelId).toBeTruthy();
    });

    it("synthesis routes to Pro tier (tier <= 2)", () => {
        const r = selectModel({ taskType: "tool_synthesis" });
        const info = MODEL_REGISTRY[r.modelId];
        expect(info).toBeDefined();
        if (info) expect(info.tier).toBeLessThanOrEqual(2);
    });

    it("ATLAS_NO_SYNTHESIS_ESCALATION skips the escalation", () => {
        const escalated = selectForToolSynthesis(false);
        process.env.ATLAS_NO_SYNTHESIS_ESCALATION = "true";
        try {
            const skipped = selectForToolSynthesis(false);
            expect(skipped.reason).not.toContain("forge synthesis escalation");
            expect(skipped.reason).not.toContain("forge dream-replay");
            // Sanity check that with escalation ON, the reason DOES include it (when base is light-tier)
            const baseTier = MODEL_REGISTRY[selectModel({ taskType: "first_iteration" }).modelId]?.tier ?? 99;
            const escalatedTier = MODEL_REGISTRY[escalated.modelId]?.tier ?? 99;
            if (escalatedTier <= 2 && baseTier > 2) {
                expect(escalated.reason).toContain("forge synthesis escalation");
            }
        } finally {
            delete process.env.ATLAS_NO_SYNTHESIS_ESCALATION;
        }
    });

    it("Track B (dream-replay) reason mentions dream-replay, not Track A escalation", () => {
        const r = selectForToolSynthesis(true);
        // Either Track B fires (and mentions dream-replay) or no escalation happens (base already top-tier)
        if (r.reason !== selectModel({ taskType: "first_iteration" }).reason) {
            expect(r.reason).toContain("forge dream-replay");
            expect(r.reason).not.toContain("forge synthesis escalation →");
        }
    });

    it("ATLAS_FORGE_DREAM_OPUS routes Track B to Opus", () => {
        process.env.ATLAS_FORGE_DREAM_OPUS = "true";
        try {
            const r = selectForToolSynthesis(true);
            const info = MODEL_REGISTRY[r.modelId];
            // Either Opus was found (tier 0) OR Opus was unavailable and we got the base
            if (info && r.reason.includes("forge dream-replay")) {
                expect(info.tier).toBe(0);
            }
        } finally {
            delete process.env.ATLAS_FORGE_DREAM_OPUS;
        }
    });
});
