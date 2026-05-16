// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { selectModel, type TaskType } from "../../model-router.js";

describe("tool_synthesis task type", () => {
    it("selectModel accepts taskType='tool_synthesis'", () => {
        const r = selectModel({ taskType: "tool_synthesis" as TaskType });
        expect(r.modelId).toBeTruthy();
    });

    it("synthesis routes to Pro tier (tier <= 2)", () => {
        const r = selectModel({ taskType: "tool_synthesis" as TaskType });
        expect(r.modelId).not.toContain("haiku");
    });

    it("ATLAS_NO_SYNTHESIS_ESCALATION skips the escalation", () => {
        process.env.ATLAS_NO_SYNTHESIS_ESCALATION = "true";
        try {
            const r = selectModel({ taskType: "tool_synthesis" as TaskType });
            expect(r.modelId).toBeTruthy();
        } finally {
            delete process.env.ATLAS_NO_SYNTHESIS_ESCALATION;
        }
    });
});
