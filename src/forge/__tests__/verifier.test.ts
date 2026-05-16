// src/forge/__tests__/verifier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifier } from "../verifier.js";
import type { SynthesisEnvelope } from "../synthesis.js";

const SUCCESSFUL_ENVELOPE: SynthesisEnvelope = {
    handler_code: "return input.x + 1;",
    tests: [
        { input: { x: 1 }, expected_kind: "returns_equals", expected_value: 2, description: "1+1=2" },
        { input: { x: 5 }, expected_kind: "returns_equals", expected_value: 6, description: "5+1=6" },
        { input: { x: 0 }, expected_kind: "returns_equals", expected_value: 1, description: "0+1=1" },
    ],
    capabilities_declared: [],
    side_effects: "none",
    synthesis_notes: "increment",
};

describe("verifier", () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "forge-ver-")); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it("succeeds on first attempt when handler is correct", async () => {
        let calls = 0;
        const llmFn = async (_prompt: string) => {
            calls++;
            return JSON.stringify(SUCCESSFUL_ENVELOPE);
        };

        const r = await runVerifier({
            slug: "increment",
            initialPrompt: "build an incrementer",
            llmFn,
            maxAttempts: 3,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.attempts).toBe(1);
            expect(r.envelope.handler_code).toContain("input.x + 1");
        }
        expect(calls).toBe(1);
    });

    it("retries on test failure and succeeds on attempt 2", async () => {
        let calls = 0;
        const llmFn = async () => {
            calls++;
            if (calls === 1) {
                return JSON.stringify({
                    ...SUCCESSFUL_ENVELOPE,
                    handler_code: "return input.x - 1;", // wrong
                });
            }
            return JSON.stringify(SUCCESSFUL_ENVELOPE);
        };
        const r = await runVerifier({
            slug: "increment",
            initialPrompt: "build an incrementer",
            llmFn,
            maxAttempts: 3,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.attempts).toBe(2);
    });

    it("exhausts attempts and returns failure report", async () => {
        const llmFn = async () => JSON.stringify({
            ...SUCCESSFUL_ENVELOPE,
            handler_code: "return -999;", // always wrong
        });
        const r = await runVerifier({
            slug: "x",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 2,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.failureReason).toBe("exhausted_attempts");
            expect(r.reportPath).toContain(tmpDir);
        }
    });

    it("fails fast on SAST hard fail (after retries also fail SAST)", async () => {
        const llmFn = async () => JSON.stringify({
            ...SUCCESSFUL_ENVELOPE,
            handler_code: "eval(input.code);",
        });
        const r = await runVerifier({
            slug: "x",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 2,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.failureReason).toBe("sast_unrecoverable");
    });

    it("respects wall-clock budget", async () => {
        const llmFn = async () => {
            await new Promise(r => setTimeout(r, 200));
            return JSON.stringify({ ...SUCCESSFUL_ENVELOPE, handler_code: "return -1;" });
        };
        const r = await runVerifier({
            slug: "x",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 10,
            wallClockMs: 100, // very tight
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.failureReason).toBe("budget_exceeded");
    });

    it("LLM throw on first attempt does not crash and uses initialPrompt for retry", async () => {
        let calls = 0;
        const prompts: string[] = [];
        const llmFn = async (p: string) => {
            prompts.push(p);
            calls++;
            if (calls === 1) throw new Error("network gone");
            return JSON.stringify(SUCCESSFUL_ENVELOPE);
        };
        const r = await runVerifier({
            slug: "x",
            initialPrompt: "INIT_PROMPT_MARKER",
            llmFn,
            maxAttempts: 3,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.attempts).toBe(2);
        expect(prompts[1]).toContain("INIT_PROMPT_MARKER");
        expect(prompts[1]).toContain("network gone");
        expect(prompts[1]).not.toMatch(/produced this handler:\s*```js\s*```/);
    });

    it("compile failure on final attempt returns sast_unrecoverable", async () => {
        const llmFn = async () => JSON.stringify({
            ...SUCCESSFUL_ENVELOPE,
            handler_code: "function (((( syntactically broken",
        });
        const r = await runVerifier({
            slug: "x",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 2,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.failureReason).toBe("sast_unrecoverable");
    });

    it("parse failure on final attempt returns parse_unrecoverable", async () => {
        const llmFn = async () => "not json at all";
        const r = await runVerifier({
            slug: "x",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 2,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.failureReason).toBe("parse_unrecoverable");
    });

    it("failure report file actually exists and contains expected fields", async () => {
        const { readFile } = await import("node:fs/promises");
        const llmFn = async () => JSON.stringify({
            ...SUCCESSFUL_ENVELOPE,
            handler_code: "return -999;",
        });
        const r = await runVerifier({
            slug: "myslug",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 2,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            const body = await readFile(r.reportPath, "utf-8");
            const obj = JSON.parse(body);
            expect(obj.slug).toBe("myslug");
            expect(obj.attempts).toBe(2);
            expect(obj.reason).toBe("exhausted_attempts");
            expect(Array.isArray(obj.last_failures)).toBe(true);
        }
    });

    it("safeJsonStringify handles BigInt and circular actuals in the report", async () => {
        const { readFile } = await import("node:fs/promises");
        const llmFn = async () => JSON.stringify({
            ...SUCCESSFUL_ENVELOPE,
            handler_code: "return 999n;",
        });
        const r = await runVerifier({
            slug: "bigint",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 1,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            const body = await readFile(r.reportPath, "utf-8");
            expect(body).toContain("999n");
        }
    });

    it("stale failures across heterogeneous attempts do not leak into final report", async () => {
        const { readFile } = await import("node:fs/promises");
        let calls = 0;
        const llmFn = async () => {
            calls++;
            if (calls === 1) {
                return JSON.stringify({ ...SUCCESSFUL_ENVELOPE, handler_code: "return -1;" });
            }
            return JSON.stringify({ ...SUCCESSFUL_ENVELOPE, handler_code: "function (((((" });
        };
        const r = await runVerifier({
            slug: "het",
            initialPrompt: "build",
            llmFn,
            maxAttempts: 2,
            failedReportDir: tmpDir,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            const body = await readFile(r.reportPath, "utf-8");
            const obj = JSON.parse(body);
            expect(obj.last_failures).toEqual([]);
            expect(obj.sast_findings.some((f: { ruleId: string }) => f.ruleId === "compile")).toBe(true);
        }
    });
});
