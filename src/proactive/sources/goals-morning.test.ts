import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../goal-engine.js", () => ({
    getActiveGoals: vi.fn(() => [
        { id: 1, title: "Ship v2", progress: 0.4, status: "active", description: "", source: "user_explicit", priority: 0.8, parentGoalId: null, evidence: "", createdAt: "", updatedAt: "" },
        { id: 2, title: "Learn Rust", progress: 0.1, status: "active", description: "", source: "curiosity", priority: 0.5, parentGoalId: null, evidence: "", createdAt: "", updatedAt: "" },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { GOALS_MORNING } from "./goals-morning.js";

describe("goals-morning source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits goals_status intent when active goals exist", async () => {
        const intents = await GOALS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("goals_status");
        expect(intents[0].source).toBe("goals_morning");
        expect(intents[0].urgency).toBe("ambient");
        expect((intents[0].payload.goals as unknown[]).length).toBe(2);
    });

    it("returns empty when no active goals", async () => {
        const goalMod = await import("../../goal-engine.js");
        (goalMod.getActiveGoals as any).mockReturnValueOnce([]);
        const intents = await GOALS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await GOALS_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
