// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it, vi } from "vitest";

vi.mock("./notification-tracker.js", () => ({
    getEstimatedWakeTime: vi.fn(),
    recordNotification: vi.fn(),
}));

import { pickBriefingTime } from "./heartbeat.js";
import { getEstimatedWakeTime } from "./notification-tracker.js";

describe("pickBriefingTime", () => {
    it("uses estimated wake (hours → minutes) + 5 when confidence >= 0.5", () => {
        (getEstimatedWakeTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            meanHour: 7.5,
            stdDev: 1,
            briefingHour: 7,
            confidence: 0.8,
        });
        const t = pickBriefingTime();
        expect(t).toBe(7 * 60 + 30 + 5);
    });

    it("clamps to 6:00 floor", () => {
        (getEstimatedWakeTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            meanHour: 5,
            stdDev: 1,
            briefingHour: 5,
            confidence: 0.9,
        });
        const t = pickBriefingTime();
        expect(t).toBe(6 * 60);
    });

    it("clamps to 10:00 ceiling", () => {
        (getEstimatedWakeTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            meanHour: 11,
            stdDev: 1,
            briefingHour: 11,
            confidence: 0.9,
        });
        const t = pickBriefingTime();
        expect(t).toBe(10 * 60);
    });

    it("falls back to random when confidence < 0.5", () => {
        (getEstimatedWakeTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            meanHour: 8,
            stdDev: 1,
            briefingHour: 7,
            confidence: 0.2,
        });
        const t = pickBriefingTime();
        expect(t).toBeGreaterThanOrEqual(6 * 60);
        expect(t).toBeLessThan(10 * 60);
    });

    it("falls back to random when confidence is 0 (no data)", () => {
        (getEstimatedWakeTime as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            meanHour: 7,
            stdDev: 1.5,
            briefingHour: 6.5,
            confidence: 0,
        });
        const t = pickBriefingTime();
        expect(t).toBeGreaterThanOrEqual(6 * 60);
        expect(t).toBeLessThan(10 * 60);
    });
});
