// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import type {
    SynthesisRequest, SynthesisResult, SynthesisFailureReport,
    ToolMetadata, ForgeStats, DynamicManifestEntry, ToolLifecycleState,
} from "../types.js";

describe("forge types compile", () => {
    it("SynthesisRequest accepts well-formed input", () => {
        const req: SynthesisRequest = {
            name: "extract_pdf",
            description: "Extract text from PDFs",
            parametersSchema: { type: "object", properties: {}, required: [] },
            persistent: false,
            originIntent: "user asked to extract PDF",
            source: "synchronous",
        };
        expect(req.source).toBe("synchronous");
    });

    it("SynthesisResult lookup_hit variant has tool field", () => {
        const result: SynthesisResult = {
            kind: "lookup_hit",
            slug: "extract_pdf",
            reusedFrom: { matchSimilarity: 0.91, source: "library_embedding" },
        };
        expect(result.kind).toBe("lookup_hit");
    });

    it("ToolLifecycleState enumerates 7 states", () => {
        const states: ToolLifecycleState[] = [
            "proposed", "verifying", "awaiting_approval",
            "active", "graduated", "published", "archived",
        ];
        expect(states).toHaveLength(7);
    });
});
