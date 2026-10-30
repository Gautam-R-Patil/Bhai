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

describe("orchestrator.lookupTool", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;
    let registry: Map<string, ToolDefinition>;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-orch-lk-"));
        registry = new Map();
        setRegistryRef(registry);
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

    it("returns null when library is empty", async () => {
        const tool = await lookupTool("extract PDF", { type: "object", properties: {}, required: [] });
        expect(tool).toBeNull();
    });

    it("returns a tool when one matches by embedding", async () => {
        insertTool({
            slug: "extract_pdf",
            description: "Extract PDF text",
            schemaJson: JSON.stringify({ type: "object", properties: { path: { type: "string" } } }),
            handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });
        // Not callable in this process (awaiting approval, or a session tool
        // from before a restart) → not reused.
        expect(await lookupTool("Extract PDF text", {})).toBeNull();
        registry.set("extract_pdf", {} as ToolDefinition);
        const tool = await lookupTool("Extract PDF text", { type: "object", properties: { path: { type: "string" } } });
        expect(tool).not.toBeNull();
        expect(tool!.slug).toBe("extract_pdf");
    });

    it("returns null when ATLAS_NO_FORGE_LOOKUP=true even if a match exists", async () => {
        insertTool({
            slug: "extract_pdf", description: "Extract PDF text",
            schemaJson: "{}", handlerHash: "x", embedding: vector(0),
            source: "synchronous", createdAt: Date.now(),
        });
        process.env.ATLAS_NO_FORGE_LOOKUP = "true";
        try {
            const tool = await lookupTool("Extract PDF text", { type: "object", properties: {}, required: [] });
            expect(tool).toBeNull();
        } finally {
            delete process.env.ATLAS_NO_FORGE_LOOKUP;
        }
    });

    it("returns null when orchestrator is not ready", async () => {
        shutdownForge();
        const tool = await lookupTool("anything", {});
        expect(tool).toBeNull();
    });
});
