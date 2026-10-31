// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTool, setRegistryRef } from "../../tools/create-tool.js";
import type { ToolDefinition } from "../../tools/get-current-time.js";
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

describe("create_tool routes through forge.synthesizeTool when ready", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;
    let registry: Map<string, ToolDefinition>;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-ctv-"));
        originalEnv = process.env.BHAI_HOME;
        process.env.BHAI_HOME = join(tmpDir, ".bhai");
        process.env.BHAI_FORGE_STUB_LLM = "true";
        registry = new Map();
        setRegistryRef(registry);
        await initForge({ embedFn: async () => vector(0) });
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.BHAI_FORGE_STUB_LLM;
        if (originalEnv === undefined) delete process.env.BHAI_HOME;
        else process.env.BHAI_HOME = originalEnv;
    });

    it("forge-routed synthesis registers a tool", async () => {
        const r = await createTool.handler({
            name: "verified_tool",
            description: "A verified tool",
            handler_code: "return 'should be replaced by forge';",
            persistent: false,
        });
        const result = JSON.parse(r);
        expect(result.success).toBe(true);
        // Either Phase 2 lookup-hit (no match yet) → falls through to synthesis, OR synthesized
        expect(result.lookup_hit || result.synthesized).toBeTruthy();
    });

    it("BHAI_NO_FORGE_VERIFIER=true falls back to legacy path", async () => {
        process.env.BHAI_NO_FORGE_VERIFIER = "true";
        const r = await createTool.handler({
            name: "legacy_path",
            description: "Legacy path",
            handler_code: "return 'ok';",
            persistent: false,
        });
        const result = JSON.parse(r);
        expect(result.success).toBe(true);
        expect(registry.has("legacy_path")).toBe(true);
        delete process.env.BHAI_NO_FORGE_VERIFIER;
    });
});
