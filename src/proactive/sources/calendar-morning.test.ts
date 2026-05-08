import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/calendar-fetch.js", () => ({
    fetchCalendarToday: vi.fn(async () => [
        {
            id: "e1", title: "Standup",
            startMs: Date.now() + 3600_000, endMs: Date.now() + 4500_000,
            location: undefined, hasAttendees: true, isAllDay: false,
        },
        {
            id: "e2", title: "Review",
            startMs: Date.now() + 5400_000, endMs: Date.now() + 7200_000,
            location: undefined, hasAttendees: false, isAllDay: false,
        },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    calendarAnalyze: vi.fn(() => ({
        conflicts: [],
        backToBack: [],
        longGaps: [],
        nextEventId: "e1",
        morningMeetingCount: 2,
        afternoonMeetingCount: 0,
    })),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { CALENDAR_MORNING } from "./calendar-morning.js";

describe("calendar-morning source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits one intent with calendar_today_summary payload", async () => {
        const intents = await CALENDAR_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("calendar_today_summary");
        expect(intents[0].payloadKind).toBe("calendar_today_summary");
        expect(intents[0].source).toBe("calendar_morning");
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await CALENDAR_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no events today", async () => {
        const fetchMod = await import("./_shared/calendar-fetch.js");
        (fetchMod.fetchCalendarToday as any).mockResolvedValueOnce([]);
        const intents = await CALENDAR_MORNING.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
