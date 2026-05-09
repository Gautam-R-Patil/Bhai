// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../tools/google-api.js", () => ({
    listCalendarEventsRaw: vi.fn(async () => [
        {
            id: "evt1",
            summary: "Standup",
            start: { dateTime: "2026-05-08T09:00:00Z" },
            end: { dateTime: "2026-05-08T09:30:00Z" },
            attendees: [{ email: "a@b.com" }, { email: "c@d.com" }],
        },
    ]),
}));

import { fetchCalendarToday, _resetCalendarCache } from "./calendar-fetch.js";
import { listCalendarEventsRaw } from "../../../tools/google-api.js";

describe("calendar-fetch", () => {
    beforeEach(() => {
        _resetCalendarCache();
        vi.mocked(listCalendarEventsRaw).mockClear();
    });

    it("returns events with Rust-shaped fields", async () => {
        const events = await fetchCalendarToday();
        expect(events).toHaveLength(1);
        expect(events[0].id).toBe("evt1");
        expect(events[0].title).toBe("Standup");
        expect(events[0].hasAttendees).toBe(true);
        expect(events[0].isAllDay).toBe(false);
    });

    it("caches within TTL window", async () => {
        await fetchCalendarToday();
        await fetchCalendarToday();
        expect(listCalendarEventsRaw).toHaveBeenCalledTimes(1);
    });

    it("all-day event detected via date-only start", async () => {
        vi.mocked(listCalendarEventsRaw).mockResolvedValueOnce([
            {
                id: "allday1",
                summary: "Conference",
                start: { date: "2026-05-08" },
                end: { date: "2026-05-09" },
                attendees: undefined,
            },
        ]);
        const events = await fetchCalendarToday();
        expect(events[0].isAllDay).toBe(true);
    });
});
