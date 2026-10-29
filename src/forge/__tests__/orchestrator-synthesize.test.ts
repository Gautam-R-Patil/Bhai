// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initForge, shutdownForge, synthesizeTool } from "../orchestrator.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("orchestrator.synthesizeTool real impl", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-syn-"));
        originalEnv = process.env.ATLAS_HOME;
        process.env.ATLAS_HOME = join(tmpDir, ".atlas");
        process.env.ATLAS_FORGE_STUB_LLM = "true";
        await initForge({ embedFn: async () => vector(0) });
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.ATLAS_FORGE_STUB_LLM;
        if (originalEnv === undefined) delete process.env.ATLAS_HOME;
        else process.env.ATLAS_HOME = originalEnv;
    });

    it("synthesizes a session tool end-to-end", async () => {
        const result = await synthesizeTool({
            name: "increment",
            description: "Add 1 to input.x",
            parametersSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
            persistent: false,
            source: "synchronous",
        });
        expect(result.kind).toBe("synthesized");
        if (result.kind === "synthesized") {
            expect(result.slug).toBe("increment");
            expect(result.attempts).toBeGreaterThanOrEqual(1);
        }
    });

    it("returns lookup_hit when library has a match", async () => {
        await synthesizeTool({
            name: "increment",
            description: "Add 1 to input.x",
            parametersSchema: {},
            persistent: false,
            source: "synchronous",
        });
        const r = await synthesizeTool({
            name: "increment_v2",
            description: "Add 1 to input.x",
            parametersSchema: {},
            persistent: false,
            source: "synchronous",
        });
        expect(r.kind).toBe("lookup_hit");
    });

    it("ATLAS_NO_FORGE_VERIFIER=true falls back via stub path", async () => {
        delete process.env.ATLAS_FORGE_STUB_LLM;
        process.env.ATLAS_NO_FORGE_VERIFIER = "true";
        try {
            const r = await synthesizeTool({
                name: "fallback_x",
                description: "fallback description",
                parametersSchema: {},
                persistent: false,
                source: "synchronous",
            });
            expect(r.kind).toBe("synthesized");
        } finally {
            delete process.env.ATLAS_NO_FORGE_VERIFIER;
            process.env.ATLAS_FORGE_STUB_LLM = "true";
        }
    });

    it("returns failed result instead of throwing on duplicate slug", async () => {
        await synthesizeTool({
            name: "dup_slug",
            description: "first description",
            parametersSchema: {},
            persistent: false,
            source: "synchronous",
        });

        process.env.ATLAS_NO_FORGE_LOOKUP = "true";
        try {
            const r = await synthesizeTool({
                name: "dup_slug",
                description: "completely different description bypasses cosine match",
                parametersSchema: {},
                persistent: false,
                source: "synchronous",
            });
            expect(r.kind).toBe("failed");
            if (r.kind === "failed") {
                expect(r.report.finalDiagnosis).toContain("library insert failed");
            }
        } finally {
            delete process.env.ATLAS_NO_FORGE_LOOKUP;
        }
    });
});
