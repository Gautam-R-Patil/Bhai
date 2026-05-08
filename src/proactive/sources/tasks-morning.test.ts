import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/tasks-fetch.js", () => ({
    fetchTasksToday: vi.fn(async () => [
        { id: "t1", title: "[!] Ship release", dueMs: Date.now() + 3600_000, priority: "high", completed: false },
        { id: "t2", title: "Write tests", dueMs: Date.now() + 7200_000, priority: "normal", completed: false },
        { id: "t3", title: "Old task", dueMs: Date.now() - 86400_000, priority: "normal", completed: false },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    tasksScore: vi.fn((_tasks: unknown[], _now: number, _tz: number) => ({
        urgentToday: ["t1"],
        normalToday: ["t2"],
        overdue: ["t3"],
        deadlineNudges: [],
    })),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { TASKS_MORNING } from "./tasks-morning.js";

describe("tasks-morning source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits one tasks_today intent with urgent/normal/overdue task lists", async () => {
        const intents = await TASKS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("tasks_today");
        expect(intents[0].source).toBe("tasks_morning");
        expect((intents[0].payload.urgent as unknown[]).length).toBe(1);
        expect((intents[0].payload.overdue as unknown[]).length).toBe(1);
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await TASKS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no tasks today", async () => {
        const fetchMod = await import("./_shared/tasks-fetch.js");
        (fetchMod.fetchTasksToday as any).mockResolvedValueOnce([]);
        const intents = await TASKS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when score result has no tasks in any bucket", async () => {
        const native = await import("../../../native/index.js");
        (native.tasksScore as any).mockReturnValueOnce({ urgentToday: [], normalToday: [], overdue: [], deadlineNudges: [] });
        const intents = await TASKS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
