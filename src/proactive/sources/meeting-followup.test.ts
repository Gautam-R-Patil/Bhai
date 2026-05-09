import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/calendar-fetch.js", () => ({
    fetchCalendarToday: vi.fn(async () => [
        {
            id: "e1", title: "Design Review",
            startMs: Date.now() - 30 * 60_000, endMs: Date.now() - 5 * 60_000,
            location: undefined, hasAttendees: true, isAllDay: false,
        },
    ]),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    calendarPrepIntents: vi.fn((_events: unknown[], _now: number, _offset: number) => [
        {
            eventId: "e1",
            title: "Design Review",
            fireAtMs: Date.now() + 2 * 60_000,
            eventStartMs: Date.now() - 5 * 60_000,
            location: undefined,
            hasAttendees: true,
        },
    ]),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { MEETING_FOLLOWUP } from "./meeting-followup.js";

describe("meeting-followup source", () => {
    beforeEach(() => vi.clearAllMocks());

    it("emits debrief intent for recently ended meeting", async () => {
        const intents = await MEETING_FOLLOWUP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("meeting_debrief");
        expect(intents[0].source).toBe("meeting_followup");
        expect(intents[0].mode).toBe("question");
        expect(intents[0].urgency).toBe("normal");
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await MEETING_FOLLOWUP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when no events today", async () => {
        const fetchMod = await import("./_shared/calendar-fetch.js");
        (fetchMod.fetchCalendarToday as any).mockResolvedValueOnce([]);
        const intents = await MEETING_FOLLOWUP.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
