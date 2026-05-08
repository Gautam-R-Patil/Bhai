import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/calendar-fetch.js", () => ({
    fetchCalendarToday: vi.fn(async () => [
        {
            id: "e1", title: "Sprint Planning",
            startMs: Date.now() + 20 * 60_000, endMs: Date.now() + 80 * 60_000,
            location: "Room 3A", hasAttendees: true, isAllDay: false,
        },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    calendarPrepIntents: vi.fn((_events: unknown[], _now: number, _offset: number) => [
        {
            eventId: "e1",
            title: "Sprint Planning",
            fireAtMs: Date.now() + 5 * 60_000,
            eventStartMs: Date.now() + 20 * 60_000,
            location: "Room 3A",
            hasAttendees: true,
        },
    ]),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { CALENDAR_PREP } from "./calendar-prep.js";

describe("calendar-prep source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits prep intent for upcoming event", async () => {
        const intents = await CALENDAR_PREP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("meeting_prep");
        expect(intents[0].source).toBe("calendar_prep");
        expect(intents[0].urgency).toBe("urgent");
        expect(intents[0].mode).toBe("fyi");
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await CALENDAR_PREP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no events today", async () => {
        const fetchMod = await import("./_shared/calendar-fetch.js");
        (fetchMod.fetchCalendarToday as any).mockResolvedValueOnce([]);
        const intents = await CALENDAR_PREP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when calendarPrepIntents returns no preps", async () => {
        const native = await import("../../../native/index.js");
        (native.calendarPrepIntents as any).mockReturnValueOnce([]);
        const intents = await CALENDAR_PREP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
