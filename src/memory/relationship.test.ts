// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { nextEngagementStreak } from "./relationship.js";

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
