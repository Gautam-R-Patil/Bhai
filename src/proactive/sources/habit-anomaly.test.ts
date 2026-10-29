import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExec = vi.fn((_sql: string, _params: unknown[]) => [{
    values: Array.from({ length: 20 }, (_, i) => [
        "worked on code today",
        new Date(Date.now() - i * 3600_000).toISOString(),
    ]),
}]);

vi.mock("../../memory/sqlite.js", () => ({
    getMemoryDB: vi.fn(() => ({ exec: mockExec })),
    dbTimeMs: (t: string) => new Date(t).getTime(),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    detectHabits: vi.fn((_events: unknown[], _minFreq: number) => [
        { eventType: "coding", pattern: "daily", typicalHour: 9, frequency: 5, consistency: 0.8, confidence: 0.85, nextExpectedMs: Date.now() },
    ]),
    habitDetectAnomalies: vi.fn((_habits: unknown[], _events: unknown[], _now: number) => [
        { eventType: "coding", expectedHour: 9, lastSeenDaysAgo: 2, confidence: 0.8 },
    ]),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { HABIT_ANOMALY } from "./habit-anomaly.js";

describe("habit-anomaly source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits habit_anomaly intent when anomaly detected", async () => {
        const intents = await HABIT_ANOMALY.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("habit_anomaly");
        expect(intents[0].source).toBe("habit_anomaly");
        expect(intents[0].mode).toBe("question");
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await HABIT_ANOMALY.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no anomalies detected", async () => {
        const native = await import("../../../native/index.js");
        (native.habitDetectAnomalies as any).mockReturnValueOnce([]);
        const intents = await HABIT_ANOMALY.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when insufficient history (< 10 events)", async () => {
        mockExec.mockReturnValueOnce([{ values: Array.from({ length: 5 }, () => ["email work", new Date().toISOString()]) }]);
        mockExec.mockReturnValueOnce([{ values: [] }]);
        const intents = await HABIT_ANOMALY.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
