// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTool, setRegistryRef } from "../../tools/create-tool.js";
import type { ToolDefinition } from "../../tools/get-current-time.js";
import { insertTool } from "../library.js";
import { initForge, shutdownForge } from "../orchestrator.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("create_tool short-circuits on library hit", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;
    let registry: Map<string, ToolDefinition>;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-ct-"));
        originalEnv = process.env.ATLAS_HOME;
        process.env.ATLAS_HOME = join(tmpDir, ".atlas");
        // Phase 2 test: keep Phase 3 verifier-route off so legacy-path assertions hold
        process.env.ATLAS_NO_FORGE_VERIFIER = "true";
        registry = new Map();
        setRegistryRef(registry);
        await initForge({ embedFn: async () => vector(0) });
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.ATLAS_NO_FORGE_VERIFIER;
        if (originalEnv === undefined) delete process.env.ATLAS_HOME;
        else process.env.ATLAS_HOME = originalEnv;
    });

    it("create_tool returns lookup_hit instead of creating new tool when match exists", async () => {
        insertTool({
            slug: "extract_pdf",
            description: "Extract PDF text",
            schemaJson: JSON.stringify({
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            }),
            handlerHash: "x",
            embedding: vector(0),
            source: "synchronous",
            createdAt: Date.now(),
        });

        const resultJson = await createTool.handler({
            name: "extract_pdf_v2", // different name
            description: "Extract PDF text", // same description
            handler_code: "return 'should not run';",
            persistent: false,
        });
        const result = JSON.parse(resultJson);

        expect(result.success).toBe(true);
        expect(result.lookup_hit).toBe(true);
        expect(result.tool_name).toBe("extract_pdf"); // canonical, not extract_pdf_v2
    });

    it("create_tool proceeds with synthesis when no lookup hit", async () => {
        const resultJson = await createTool.handler({
            name: "send_email",
            description: "Send an email",
            handler_code: "return 'sent';",
            persistent: false,
        });
        const result = JSON.parse(resultJson);
        expect(result.success).toBe(true);
        expect(result.lookup_hit).toBeUndefined();
        expect(registry.has("send_email")).toBe(true);
    });

    it("ATLAS_NO_FORGE_LOOKUP=true skips lookup, always creates", async () => {
        insertTool({
            slug: "extract_pdf",
            description: "Extract PDF",
            schemaJson: "{}",
            handlerHash: "x",
            embedding: vector(0),
            source: "synchronous",
            createdAt: Date.now(),
        });

        process.env.ATLAS_NO_FORGE_LOOKUP = "true";
        try {
            const resultJson = await createTool.handler({
                name: "extract_pdf_v2",
                description: "Extract PDF",
                handler_code: "return 'ok';",
                persistent: false,
            });
            const result = JSON.parse(resultJson);
            expect(result.lookup_hit).toBeUndefined();
            expect(registry.has("extract_pdf_v2")).toBe(true);
        } finally {
            delete process.env.ATLAS_NO_FORGE_LOOKUP;
        }
    });
});
