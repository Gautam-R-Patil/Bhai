// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { nextEngagementStreak, pickMilestone } from "./relationship.js";

describe("nextEngagementStreak", () => {
    const now = new Date("2026-10-29T10:00:00");

    it("doesn't inflate on multiple sessions the same day", () => {
        const sameDay = "2026-10-29T01:00:00";
        expect(nextEngagementStreak(5, sameDay, now)).toBe(5);
        // Idempotent across repeated same-day calls.
        expect(nextEngagementStreak(nextEngagementStreak(5, sameDay, now), sameDay, now)).toBe(5);
    });

    it("increments on the next calendar day", () => {
        expect(nextEngagementStreak(5, "2026-10-28T23:00:00", now)).toBe(6);
    });

    it("resets after a gap — including the exactly-2-day dead-zone", () => {
        expect(nextEngagementStreak(5, "2026-10-27T10:00:00", now)).toBe(1); // 2 days
        expect(nextEngagementStreak(5, "2026-10-25T10:00:00", now)).toBe(1); // 4 days
    });
});

describe("pickMilestone", () => {
    const now = new Date("2026-10-29T10:00:00Z");

    it("fires a streak milestone once, only on the day it is reached", () => {
        expect(pickMilestone(30, null, [], now)?.key).toBe("streak_30");
        expect(pickMilestone(30, null, ["streak_7", "streak_30"], now)).toBeNull();
        expect(pickMilestone(31, null, [], now)).toBeNull();
    });

    it("fires a first-chat anniversary in the week after it, once", () => {
        expect(pickMilestone(1, "2025-10-27 09:00:00", [], now)?.key).toBe("year_1");
        expect(pickMilestone(1, "2025-10-27 09:00:00", ["year_1"], now)).toBeNull();
        expect(pickMilestone(1, "2025-09-01 09:00:00", [], now)).toBeNull();
        expect(pickMilestone(1, "2026-01-01 09:00:00", [], now)).toBeNull();
    });
});
