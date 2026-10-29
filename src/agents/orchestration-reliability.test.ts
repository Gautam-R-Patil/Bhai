// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Orchestration reliability: context windowing keeps the task and tool-call
// pairs, side effects block blind retries, step text alone never blocks a
// step off Telegram (the tool gate does), replanned deps resolve, the evaluator keeps an honest 0, swarm synthesis caps output.
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";

vi.mock("../tools/index.js", () => ({
    executeTool: async () => "ok",
    getToolSchemasByNames: () => [],
    getToolSchemas: () => [],
}));
vi.mock("../utils/debug-log.js", () => ({
    extractPrimaryPath: () => undefined,
    logToolAction: () => {},
    summarizeToolCall: () => "",
}));
vi.mock("../memory/sqlite.js", () => ({ getRawDb: () => null, recall: async () => [], remember: () => {} }));
vi.mock("../tools/channel-send.js", () => ({ getActiveChannel: () => "discord" }));
vi.mock("./self-heal.js", () => ({ attemptSelfHeal: async () => ({ fixed: false }) }));

const runSubAgentMock = vi.fn();
vi.mock("./sub-agent.js", async (orig) => ({
    ...(await orig<typeof import("./sub-agent.js")>()),
    runSubAgent: (...a: unknown[]) => runSubAgentMock(...a),
}));

const { windowSubAgentHistory, isSideEffectTool } = await import("./sub-agent.js");
const { executeWithRecovery } = await import("./error-recovery.js");
const { executeMesh } = await import("./mesh.js");
const { rubricScore } = await import("./evaluator.js");
const { capStepOutput } = await import("./swarm.js");

const llm = {} as LLMClient;

function history(n: number): ChatCompletionMessageParam[] {
    const h: ChatCompletionMessageParam[] = [{ role: "user", content: "## Your Task\nORIGINAL" }];
    let i = 0;
    while (h.length < n) {
        // one assistant turn with three parallel tool calls + their results
        const ids = [`a${i}`, `b${i}`, `c${i}`];
        h.push({
            role: "assistant",
            content: "",
            tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "read", arguments: "{}" } })),
        } as ChatCompletionMessageParam);
        for (const id of ids) h.push({ role: "tool", tool_call_id: id, content: "result" });
        i++;
    }
    return h;
}

describe("windowSubAgentHistory", () => {
    it("keeps the original task and never starts on an orphan tool result", () => {
        for (let n = 21; n <= 60; n++) {
            const w = windowSubAgentHistory(history(n), 20);
            expect(String(w[0].content)).toContain("ORIGINAL");
            expect(w[1].role).not.toBe("tool");
            const callIds = new Set(
                w.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls.map((t) => t.id) : [])),
            );
            for (const m of w) if (m.role === "tool") expect(callIds.has(m.tool_call_id)).toBe(true);
        }
    });
});

describe("side-effect detection + recovery", () => {
    it("classifies sends/edits/clicks as side effects, reads as not", () => {
        expect(isSideEffectTool("whatsapp_send", {})).toBe(true);
        expect(isSideEffectTool("browser_click", {})).toBe(true);
        expect(isSideEffectTool("edit", {})).toBe(true);
        expect(isSideEffectTool("web_search", {})).toBe(false);
    });

    it("skips blind retry after a send ran and rephrases with what already ran", async () => {
        runSubAgentMock.mockReset();
        runSubAgentMock
            .mockResolvedValueOnce({
                id: "s1", role: "general", success: false, output: "", toolCalls: 1, durationMs: 1,
                estimatedCost: 0, error: "Sub-agent timed out after 1000ms", mutatorsRan: ["whatsapp_send"],
            })
            .mockResolvedValueOnce({
                id: "s1", role: "general", success: true, output: "done", toolCalls: 1, durationMs: 1, estimatedCost: 0,
            });
        const r = await executeWithRecovery(llm, { id: "s1", role: "general", description: "message Bob" }, undefined, {
            backoffMs: 1,
        });
        expect(r.success).toBe(true);
        expect(runSubAgentMock).toHaveBeenCalledTimes(2);
        const second = runSubAgentMock.mock.calls[1][1] as { description: string };
        expect(second.description).toMatch(/ALREADY RAN.*whatsapp_send/);
    });
});

describe("step text is not the gate", () => {
    it("off Telegram a step runs whatever its text says (the tool gate decides)", async () => {
        runSubAgentMock.mockReset();
        runSubAgentMock.mockImplementation(async (_l: unknown, t: { id: string }) => ({
            id: t.id, role: "general", success: true, output: "done", toolCalls: 0, durationMs: 0, estimatedCost: 0,
        }));
        const progress = vi.fn(async () => {});
        const res = await executeMesh(llm, [{ id: "d1", role: "general", description: "delete all files in ~/x", depends_on: [] }], progress);
        expect(res.results.get("d1")?.success).toBe(true);
        expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    });
});

describe("replanned DAG", () => {
    it("resolves deps on prior successes and drops unknown ones instead of throwing", async () => {
        runSubAgentMock.mockReset();
        runSubAgentMock.mockImplementation(async (_l: unknown, t: { id: string; context?: string }) => ({
            id: t.id, role: "general", success: true, output: `ctx:${t.context ?? ""}`, toolCalls: 0, durationMs: 0, estimatedCost: 0,
        }));
        const prior = {
            results: new Map([["s1", { id: "s1", role: "general" as const, success: true, output: "PRIOR_FINDING", toolCalls: 0, durationMs: 0, estimatedCost: 0 }]]),
            steps: [{ id: "s1", role: "general" as const, description: "research", depends_on: [] }],
        };
        const res = await executeMesh(
            llm,
            [{ id: "s3b", role: "general", description: "write it up", depends_on: ["s1", "s2-removed"] }],
            undefined,
            1000,
            prior,
        );
        expect(res.results.get("s3b")?.success).toBe(true);
        expect(res.results.get("s3b")?.output).toContain("PRIOR_FINDING");
    });
});

describe("evaluator + synthesis caps", () => {
    it("an honest 0 stays 0; missing defaults to 70", () => {
        expect(rubricScore(0)).toBe(0);
        expect(rubricScore(undefined)).toBe(70);
        expect(rubricScore("abc")).toBe(70);
        expect(rubricScore(150)).toBe(100);
    });

    it("caps a huge step output keeping head and tail", () => {
        const out = `HEAD${"x".repeat(10_000)}TAIL`;
        const c = capStepOutput(out);
        expect(c.length).toBeLessThan(4100);
        expect(c.startsWith("HEAD")).toBe(true);
        expect(c.endsWith("TAIL")).toBe(true);
    });
});
