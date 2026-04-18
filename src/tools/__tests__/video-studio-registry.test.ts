// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { getToolSchemasByNames } from "../index.js";

describe("video studio registry", () => {
    it("all 7 video_ tools are registered in the global registry", () => {
        const names = [
            "video_create_project",
            "video_analyze",
            "video_plan_edit",
            "video_render",
            "video_patch_plan",
            "video_ffmpeg",
            "video_list_projects",
        ];
        const schemas = getToolSchemasByNames(names);
        expect(schemas).toHaveLength(7);
        for (const s of schemas) {
            expect(s.type).toBe("function");
            expect(s.function.name).toMatch(/^video_/);
        }
    });
});
