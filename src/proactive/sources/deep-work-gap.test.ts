import { describe, it, expect, vi, beforeEach } from "vitest";

const now = Date.now();

vi.mock("./_shared/calendar-fetch.js", () => ({
    fetchCalendarToday: vi.fn(async () => [
        { id: "e1", title: "Standup", startMs: now - 30 * 60_000, endMs: now - 5 * 60_000, location: undefined, hasAttendees: true, isAllDay: false },
        { id: "e2", title: "1:1", startMs: now + 120 * 60_000, endMs: now + 150 * 60_000, location: undefined, hasAttendees: true, isAllDay: false },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    calendarAnalyze: vi.fn((_events: unknown[], _now: number, _s: number, _e: number, _tz: number) => ({
        conflicts: [],
        backToBack: [],
        longGaps: [
            {
                startMs: now - 10 * 60_000,
                endMs: now + 110 * 60_000,
                prevEventId: "e1",
                nextEventId: "e2",
                durationMin: 120,
            },
        ],
        nextEventId: "e2",
        morningMeetingCount: 1,
        afternoonMeetingCount: 1,
    })),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { DEEP_WORK_GAP } from "./deep-work-gap.js";

describe("deep-work-gap source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits focus_block_offer review intent when inside gap window", async () => {
        const intents = await DEEP_WORK_GAP.collectIntents({ now });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("focus_block_offer");
        expect(intents[0].source).toBe("deep_work_gap");
        expect(intents[0].mode).toBe("review");
        expect(intents[0].suggestedAction).toBeDefined();
        expect(intents[0].suggestedAction!.toolCalls[0].toolName).toBe("google_calendar");
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await DEEP_WORK_GAP.collectIntents({ now });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no long gaps", async () => {
        const native = await import("../../../native/index.js");
        (native.calendarAnalyze as any).mockReturnValueOnce({
            conflicts: [], backToBack: [], longGaps: [], nextEventId: undefined, morningMeetingCount: 0, afternoonMeetingCount: 0,
        });
        const intents = await DEEP_WORK_GAP.collectIntents({ now });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when gap is entirely in the future (outside fire window)", async () => {
        const native = await import("../../../native/index.js");
        (native.calendarAnalyze as any).mockReturnValueOnce({
            conflicts: [], backToBack: [],
            longGaps: [{ startMs: now + 4 * 3600_000, endMs: now + 6 * 3600_000, durationMin: 120 }],
            nextEventId: undefined, morningMeetingCount: 0, afternoonMeetingCount: 0,
        });
        const intents = await DEEP_WORK_GAP.collectIntents({ now });
        expect(intents).toHaveLength(0);
    });
});
