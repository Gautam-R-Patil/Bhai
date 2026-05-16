// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initForge, queueSynthesisCandidate, shutdownForge } from "../orchestrator.js";
import { consumeOnePending } from "../pending-consumer.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("pending-queue consumer", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-pc-"));
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

    it("consumes one queued candidate", async () => {
        await queueSynthesisCandidate({
            name: "pending_tool",
            description: "A pending tool",
            parametersSchema: {},
            persistent: false,
            source: "synchronous",
            originIntent: "test",
        });
        const result = await consumeOnePending();
        expect(result).not.toBeNull();
        expect(result?.kind).toBe("synthesized");
    });

    it("returns null when queue empty", async () => {
        const result = await consumeOnePending();
        expect(result).toBeNull();
    });
});
