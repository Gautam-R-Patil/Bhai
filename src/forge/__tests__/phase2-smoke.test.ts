// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForge, lookupTool, shutdownForge } from "../orchestrator.js";
import { insertTool } from "../library.js";
import { setRegistryRef } from "../../tools/create-tool.js";
import type { ToolDefinition } from "../../tools/get-current-time.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("Phase 2 — Lookup-first smoke", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-p2-"));
        originalEnv = process.env.ATLAS_HOME;
        process.env.ATLAS_HOME = join(tmpDir, ".atlas");
        await initForge({ embedFn: async () => vector(0) });
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env.ATLAS_HOME;
        else process.env.ATLAS_HOME = originalEnv;
    });

    it("end-to-end: insert → lookup", async () => {
        setRegistryRef(new Map([["extract_pdf", {} as ToolDefinition]]));
        insertTool({
            slug: "extract_pdf",
            description: "Extract text from a PDF file",
            schemaJson: JSON.stringify({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
            handlerHash: "abc", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });

        // Lookup finds the tool by exact description match (cosine = 1.0 → above 0.85 threshold)
        const found = await lookupTool("Extract text from a PDF file", { type: "object", properties: { path: {} } });
        expect(found).not.toBeNull();
        expect(found!.slug).toBe("extract_pdf");
    });

    it("ATLAS_NO_FORGE_LOOKUP=true disables lookup entirely", async () => {
        insertTool({
            slug: "x", description: "test",
            schemaJson: "{}", handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });

        process.env.ATLAS_NO_FORGE_LOOKUP = "true";
        try {
            const found = await lookupTool("test", {});
            expect(found).toBeNull();
        } finally {
            delete process.env.ATLAS_NO_FORGE_LOOKUP;
        }
    });
});
