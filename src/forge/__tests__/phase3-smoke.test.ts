// src/forge/__tests__/phase3-smoke.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForge, synthesizeTool, shutdownForge } from "../orchestrator.js";
import { runVerifier } from "../verifier.js";

function vector(seed: number): Float32Array {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
    let mag = 0;
    for (let i = 0; i < 384; i++) mag += v[i] * v[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < 384; i++) v[i] /= mag;
    return v;
}

describe("Phase 3 — Closed-loop verifier smoke", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-p3-"));
        originalEnv = process.env.BHAI_HOME;
        process.env.BHAI_HOME = join(tmpDir, ".bhai");
        await initForge({ embedFn: async () => vector(0) });
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env.BHAI_HOME;
        else process.env.BHAI_HOME = originalEnv;
    });

    it("verifier succeeds on a correct envelope (no LLM)", async () => {
        const failedDir = join(tmpDir, "_failed");
        const result = await runVerifier({
            slug: "happy",
            initialPrompt: "build",
            llmFn: async () => JSON.stringify({
                handler_code: "return input.x * 2;",
                tests: [
                    { input: { x: 3 }, expected_kind: "returns_equals", expected_value: 6, description: "3*2=6" },
                    { input: { x: 0 }, expected_kind: "returns_equals", expected_value: 0, description: "0*2=0" },
                    { input: { x: -1 }, expected_kind: "returns_equals", expected_value: -2, description: "-1*2=-2" },
                ],
                capabilities_declared: [],
                side_effects: "none",
                synthesis_notes: "doubles input.x",
            }),
            maxAttempts: 3,
            failedReportDir: failedDir,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.attempts).toBe(1);
    });

    it("verifier writes failure report on exhaustion", async () => {
        const failedDir = join(tmpDir, "_failed");
        const result = await runVerifier({
            slug: "bad",
            initialPrompt: "build",
            llmFn: async () => JSON.stringify({
                handler_code: "return 999;",
                tests: [
                    { input: { x: 1 }, expected_kind: "returns_equals", expected_value: 2, description: "wrong" },
                    { input: { x: 2 }, expected_kind: "returns_equals", expected_value: 4, description: "wrong" },
                    { input: { x: 3 }, expected_kind: "returns_equals", expected_value: 6, description: "wrong" },
                ],
                capabilities_declared: [],
                side_effects: "none",
                synthesis_notes: "always wrong",
            }),
            maxAttempts: 2,
            failedReportDir: failedDir,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(existsSync(result.reportPath)).toBe(true);
            expect(result.failureReason).toBe("exhausted_attempts");
        }
    });

    it("orchestrator.synthesizeTool stub-LLM path works end-to-end", async () => {
        process.env.BHAI_FORGE_STUB_LLM = "true";
        const result = await synthesizeTool({
            name: "smoke_increment",
            description: "Increment input.x",
            parametersSchema: { type: "object", properties: { x: { type: "number" } } },
            persistent: false,
            source: "synchronous",
        });
        expect(result.kind).toBe("synthesized");
        delete process.env.BHAI_FORGE_STUB_LLM;
    });
});
