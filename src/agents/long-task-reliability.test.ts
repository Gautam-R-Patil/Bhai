// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Long tasks: failed phases are not "done" on resume; the start tool emits the
// [LONG-TASK:<id>] marker telegram.ts parses; the channel callback still gets
// the result after the turn (Discord threads post it); stale dependents re-run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.ATLAS_DATA_DIR = mkdtempSync(join(tmpdir(), "lt-test-"));

// Each running phase queues its release; the test waits for a real one (a no-op default
// made "is it a function yet?" pass at once, releasing a phase that didn't exist — flaky under load).
const pendingPhases: Array<() => void> = [];
vi.mock("./sub-agent.js", () => ({
    runSubAgent: async () => {
        await new Promise<void>((r) => {
            pendingPhases.push(r);
        });
        return { id: "p", role: "general", success: true, output: "done", toolCalls: 0, durationMs: 0, estimatedCost: 0 };
    },
}));
vi.mock("../proactive/long-task-events.js", () => ({ globalLongTaskBus: { emit: () => {} } }));

const { phaseSucceeded, invalidateStaleDependents } = await import("./long-task.js");
const tool = await import("../tools/long-task-tool.js");

describe("phaseSucceeded", () => {
    it("failed / errored / missing phases are not done", () => {
        const task = { checkpointData: { a: "result", b: "PHASE FAILED: boom\nPartial output: x", c: "PHASE ERROR: x" } };
        expect(phaseSucceeded(task, "a")).toBe(true);
        expect(phaseSucceeded(task, "b")).toBe(false);
        expect(phaseSucceeded(task, "c")).toBe(false);
        expect(phaseSucceeded(task, "d")).toBe(false);
    });
});

describe("invalidateStaleDependents", () => {
    it("drops the checkpoint of every phase built on a failed one", () => {
        const task = {
            phases: [
                { id: "p1", role: "general" as const, description: "", depends_on: [] },
                { id: "p2", role: "general" as const, description: "", depends_on: ["p1"] },
                { id: "p3", role: "general" as const, description: "", depends_on: ["p2"] },
                { id: "p4", role: "general" as const, description: "", depends_on: ["p3"] },
                { id: "p5", role: "general" as const, description: "", depends_on: ["p1"] },
            ],
            checkpointData: { p1: "data", p2: "PHASE FAILED: 403", p3: "data unavailable", p4: "report", p5: "ok" } as Record<string, string>,
        };
        invalidateStaleDependents(task);
        expect(Object.keys(task.checkpointData).sort()).toEqual(["p1", "p2", "p5"]);
    });
});

describe("start_long_task telegram controls", () => {
    it("emits the marker telegram.ts parses and still delivers completion after the turn", async () => {
        const turn = vi.fn(async (_m: string) => {});
        const llm = { chat: async () => { throw new Error("offline"); } }; // planner falls back to one phase
        tool.setLongTaskLLM(llm as never);
        tool.setLongTaskProgress(turn);
        const res = JSON.parse(await tool.startLongTaskTool.handler({ description: "do a long thing" }));
        const marker = turn.mock.calls.map((c) => c[0]).find((m) => /\[LONG-TASK:([^\]]+)\]\s*(.*)/.test(m));
        expect(marker?.match(/\[LONG-TASK:([^\]]+)\]/)?.[1]).toBe(res.task_id);

        tool.clearLongTaskProgress(); // turn ended
        turn.mockClear();
        for (let i = 0; i < 2; i++) {
            // finish the phase, then the quality review
            await vi.waitFor(() => expect(pendingPhases.length).toBeGreaterThan(0), { timeout: 10_000 });
            pendingPhases.shift()?.();
        }
        await vi.waitFor(() => expect(turn.mock.calls.some((c) => c[0].includes("Task complete"))).toBe(true), {
            timeout: 10_000,
        });
    }, 30_000);
});
