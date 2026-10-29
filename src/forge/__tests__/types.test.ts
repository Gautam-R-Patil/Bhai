// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import type {
    DynamicManifestEntry,
    ForgeStats,
    PersistedToolManifest,
    SynthesisFailureReport,
    SynthesisRequest,
    SynthesisResult,
    ToolLifecycleState,
    ToolMetadata,
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

    it("SynthesisResult lookup_hit variant has kind and reusedFrom", () => {
        const result: SynthesisResult = {
            kind: "lookup_hit",
            slug: "extract_pdf",
            reusedFrom: { matchSimilarity: 0.91, source: "library_embedding" },
        };
        expect(result.kind).toBe("lookup_hit");
    });

    it("ToolLifecycleState enumerates 7 states", () => {
        const states: ToolLifecycleState[] = [
            "proposed",
            "verifying",
            "awaiting_approval",
            "active",
            "graduated",
            "published",
            "archived",
        ];
        expect(states).toHaveLength(7);
    });
});

describe("PersistedToolManifest type", () => {
    it("has the expected runtime-checkable shape", () => {
        const example: PersistedToolManifest = {
            slug: "extract_invoice",
            description: "Extract invoice fields from a PDF",
            capabilities: { fs_read: ["~/Downloads/"], fs_write: [], net: [], exec: [] },
            parametersSchema: { type: "object", properties: { pdfPath: { type: "string" } } },
            version: "0.1.0",
            approvedAt: 1700000000000,
            userQuote: "yes go ahead and approve this tool",
            handlerHash: "deadbeefcafe1234",
        };
        const cloned = structuredClone(example);
        expect(cloned.slug).toBe("extract_invoice");
        expect(cloned.handlerHash).toHaveLength(16);
        expect(cloned.capabilities.fs_read).toEqual(["~/Downloads/"]);
    });
});
