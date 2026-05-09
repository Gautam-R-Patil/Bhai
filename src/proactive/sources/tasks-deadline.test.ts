import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/tasks-fetch.js", () => ({
    fetchTasksToday: vi.fn(async () => [
        { id: "t1", title: "Submit PR", dueMs: Date.now() + 3600_000, priority: "high", completed: false },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    tasksScore: vi.fn((_tasks: unknown[], _now: number, _tz: number) => ({
        urgentToday: ["t1"],
        normalToday: [],
        overdue: [],
        deadlineNudges: [
            { taskId: "t1", title: "Submit PR", dueMs: Date.now() + 3600_000, fireAtMs: Date.now() + 30 * 60_000 },
        ],
    })),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { TASKS_DEADLINE } from "./tasks-deadline.js";

describe("tasks-deadline source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits deadline_imminent intent for approaching deadline", async () => {
        const intents = await TASKS_DEADLINE.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("deadline_imminent");
        expect(intents[0].source).toBe("tasks_deadline");
        expect(intents[0].urgency).toBe("urgent");
        expect(intents[0].mode).toBe("question");
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await TASKS_DEADLINE.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no deadline nudges", async () => {
        const native = await import("../../../native/index.js");
        (native.tasksScore as any).mockReturnValueOnce({ urgentToday: [], normalToday: [], overdue: [], deadlineNudges: [] });
        const intents = await TASKS_DEADLINE.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
