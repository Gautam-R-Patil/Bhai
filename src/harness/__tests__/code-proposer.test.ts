// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { proposeWithFilesystemAgent } from "../code-proposer.js";
import { HarnessRunStore } from "../run-store.js";
import type { LLMClient } from "../../llm.js";
import type { CandidateManifest, HarnessConfig } from "../types.js";

vi.mock("../../agents/agent-worktree.js", () => ({
    setupAgentWorktree: vi.fn(),
}));

vi.mock("../../agent.js", () => ({
    runAgent: vi.fn(),
}));

vi.mock("../proposer.js", () => ({
    proposeNextCandidate: vi.fn(async (_llm: unknown, candidate: CandidateManifest) => ({
        candidateId: candidate.candidateId,
        dimensions: { "memory.recall.k": 7 },
        createdAt: new Date().toISOString(),
    } as HarnessConfig)),
}));

const fakeLLM = {} as LLMClient;

function buildCandidate(id = "c0001"): CandidateManifest {
    return {
        candidateId: id,
        parentCandidateId: "c0000",
        objective: null,
        valid: false,
        outcome: "no-change",
        outcomeSummary: "",
        harnessConfig: { candidateId: id, dimensions: {}, createdAt: new Date().toISOString() },
        scores: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

describe("proposeWithFilesystemAgent", () => {
    let runDir: string;
    let store: HarnessRunStore;

    beforeEach(() => {
        const tmp = mkdtempSync(join(tmpdir(), "atlas-code-proposer-"));
        process.env.ATLAS_DATA_DIR = tmp;
        runDir = tmp;
        store = new HarnessRunStore();
        store.initializeRun({ budget: 5, fastMode: true, searchMode: "hill-climb", proposalBatchSize: 1, objective: "test" });
    });

    afterEach(() => {
        delete process.env.ATLAS_DATA_DIR;
        try { rmSync(runDir, { recursive: true, force: true }); } catch { /* */ }
        vi.clearAllMocks();
    });

    it("falls back to proposeNextCandidate when not a git repo", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        vi.mocked(wt.setupAgentWorktree).mockReturnValue(null);

        const candidate = store.materializeBaseline();
        const result = await proposeWithFilesystemAgent(fakeLLM, candidate, store);
        expect(result.config.dimensions["memory.recall.k"]).toBe(7);
        expect(result.codeChanges).toEqual([]);
    });

    it("reads proposed-config.json from the worktree after runAgent returns", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        const agentMod = await import("../../agent.js");
        const wtPath = mkdtempSync(join(tmpdir(), "atlas-wt-"));
        const cleanupSpy = vi.fn();
        vi.mocked(wt.setupAgentWorktree).mockReturnValue({ path: wtPath, branch: "test-branch", cleanup: cleanupSpy });

        vi.mocked(agentMod.runAgent).mockImplementation(async () => {
            writeFileSync(join(wtPath, "proposed-config.json"), JSON.stringify({
                candidateId: "c0001",
                dimensions: { "evaluator.acceptThreshold": 82 },
                createdAt: new Date().toISOString(),
            }), "utf-8");
            return { text: "done", toolCalls: 3 };
        });

        const candidate = buildCandidate();
        store.materializeBaseline();
        const result = await proposeWithFilesystemAgent(fakeLLM, candidate, store);

        expect(result.config.dimensions["evaluator.acceptThreshold"]).toBe(82);
        expect(cleanupSpy).toHaveBeenCalled();
        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    });

    it("collects CodeChange entries from src/harness/proposed-changes/ in the worktree", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        const agentMod = await import("../../agent.js");
        const wtPath = mkdtempSync(join(tmpdir(), "atlas-wt-"));
        const cleanupSpy = vi.fn();
        vi.mocked(wt.setupAgentWorktree).mockReturnValue({ path: wtPath, branch: "test-branch", cleanup: cleanupSpy });

        vi.mocked(agentMod.runAgent).mockImplementation(async () => {
            const changesDir = join(wtPath, "src/harness/proposed-changes");
            mkdirSync(changesDir, { recursive: true });
            writeFileSync(join(changesDir, "fusion-weights.ts"), "export function score(x: number) { return x * 2; }", "utf-8");
            writeFileSync(join(changesDir, "recall-k.ts"), "export const K = 15;", "utf-8");
            writeFileSync(join(wtPath, "proposed-config.json"), JSON.stringify({
                candidateId: "c0001", dimensions: {}, createdAt: new Date().toISOString(),
            }), "utf-8");
            return { text: "done", toolCalls: 5 };
        });

        const candidate = buildCandidate();
        store.materializeBaseline();
        const result = await proposeWithFilesystemAgent(fakeLLM, candidate, store);

        expect(result.codeChanges).toHaveLength(2);
        const names = result.codeChanges.map(c => c.patchFile).sort();
        expect(names).toEqual(["fusion-weights.ts", "recall-k.ts"]);
        expect(result.codeChanges.find(c => c.patchFile === "recall-k.ts")!.content).toContain("K = 15");

        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    });

    it("passes a scoped allowedTools list to runAgent (read/shell/write, no browser/memory/network)", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        const agentMod = await import("../../agent.js");
        const wtPath = mkdtempSync(join(tmpdir(), "atlas-wt-"));
        vi.mocked(wt.setupAgentWorktree).mockReturnValue({ path: wtPath, branch: "t", cleanup: vi.fn() });
        vi.mocked(agentMod.runAgent).mockImplementation(async () => {
            writeFileSync(join(wtPath, "proposed-config.json"), JSON.stringify({
                candidateId: "c0001", dimensions: {}, createdAt: new Date().toISOString(),
            }), "utf-8");
            return { text: "ok", toolCalls: 1 };
        });

        const candidate = buildCandidate();
        store.materializeBaseline();
        await proposeWithFilesystemAgent(fakeLLM, candidate, store);

        const call = vi.mocked(agentMod.runAgent).mock.calls[0];
        // runAgent(llm, message, onProgress?, media?, signal?, historyFork?, modelHint?, toolAllowlist?, ...)
        const allowlist = call[7] as string[] | undefined;
        expect(allowlist).toBeDefined();
        expect(allowlist).toContain("read_file");
        expect(allowlist).toContain("shell_exec");
        expect(allowlist).toContain("write_file");
        expect(allowlist).not.toContain("web_search");
        expect(allowlist).not.toContain("browser_navigate");
        expect(allowlist).not.toContain("remember");

        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    });

    it("passes an AbortSignal tied to timeoutMs", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        const agentMod = await import("../../agent.js");
        const wtPath = mkdtempSync(join(tmpdir(), "atlas-wt-"));
        vi.mocked(wt.setupAgentWorktree).mockReturnValue({ path: wtPath, branch: "t", cleanup: vi.fn() });

        let capturedSignal: AbortSignal | undefined;
        vi.mocked(agentMod.runAgent).mockImplementation(async (_llm, _msg, _prog, _media, signal) => {
            capturedSignal = signal as AbortSignal | undefined;
            writeFileSync(join(wtPath, "proposed-config.json"), JSON.stringify({
                candidateId: "c0001", dimensions: {}, createdAt: new Date().toISOString(),
            }), "utf-8");
            return { text: "ok", toolCalls: 1 };
        });

        const candidate = buildCandidate();
        store.materializeBaseline();
        await proposeWithFilesystemAgent(fakeLLM, candidate, store, { timeoutMs: 1000 });
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(false);

        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    });

    it("falls back gracefully if agent writes invalid proposed-config.json", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        const agentMod = await import("../../agent.js");
        const wtPath = mkdtempSync(join(tmpdir(), "atlas-wt-"));
        vi.mocked(wt.setupAgentWorktree).mockReturnValue({ path: wtPath, branch: "t", cleanup: vi.fn() });
        vi.mocked(agentMod.runAgent).mockImplementation(async () => {
            writeFileSync(join(wtPath, "proposed-config.json"), "not valid json {{{", "utf-8");
            return { text: "done", toolCalls: 1 };
        });

        const candidate = buildCandidate();
        store.materializeBaseline();
        const result = await proposeWithFilesystemAgent(fakeLLM, candidate, store);
        expect(result.config.candidateId).toBe(candidate.candidateId);
        expect(result.codeChanges).toEqual([]);

        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    });

    it("calls cleanup() even if runAgent throws", async () => {
        const wt = await import("../../agents/agent-worktree.js");
        const agentMod = await import("../../agent.js");
        const wtPath = mkdtempSync(join(tmpdir(), "atlas-wt-"));
        const cleanupSpy = vi.fn();
        vi.mocked(wt.setupAgentWorktree).mockReturnValue({ path: wtPath, branch: "t", cleanup: cleanupSpy });
        vi.mocked(agentMod.runAgent).mockRejectedValueOnce(new Error("agent boom"));

        const candidate = buildCandidate();
        store.materializeBaseline();
        const result = await proposeWithFilesystemAgent(fakeLLM, candidate, store);
        expect(cleanupSpy).toHaveBeenCalled();
        expect(result.config.candidateId).toBe(candidate.candidateId);

        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    });

    it("AGENTS.md points at individual trace files, not summary.json", async () => {
        const candidate = store.materializeBaseline();
        store.writeInstructionBundle(candidate, candidate, "test objective");
        const agentsMd = readFileSync(
            join(store.runDir, "candidates", candidate.candidateId, ".metaharness", "AGENTS.md"),
            "utf-8",
        );
        expect(agentsMd).toMatch(/read_file|shell_exec/);
        expect(agentsMd).toMatch(/traces.*\.json|\.json.*traces/i);
        expect(agentsMd).toMatch(/do NOT.*summary|NOT.*summary/i);
    });
});
