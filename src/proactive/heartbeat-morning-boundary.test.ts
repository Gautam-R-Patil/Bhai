// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notification-tracker.js", () => ({
    getEstimatedWakeTime: vi.fn(() => ({ meanHour: 7, stdDev: 1, briefingHour: 6.5, confidence: 0 })),
    recordNotification: vi.fn(),
}));

import { type BoundaryEvent, globalBoundaryBus } from "./boundary-events.js";
import { _resetBriefingStateForTests, maybeEmitMorningBoundary } from "./heartbeat.js";

describe("heartbeat morning boundary emission", () => {
    let events: BoundaryEvent[] = [];
    let unsub: (() => void) | null = null;
    const origFlag = process.env.BHAI_PROACTIVE_V3_SOURCES;

    beforeEach(() => {
        events = [];
        unsub = globalBoundaryBus.subscribe((e) => events.push(e));
        _resetBriefingStateForTests();
        // Clear dedup-by-kind state on the bus so successive tests can emit the same kind
        (globalBoundaryBus as unknown as { lastByKind: Map<string, number> }).lastByKind.clear();
    });

    afterEach(() => {
        unsub?.();
        if (origFlag === undefined) {
            delete process.env.BHAI_PROACTIVE_V3_SOURCES;
        } else {
            process.env.BHAI_PROACTIVE_V3_SOURCES = origFlag;
        }
    });

    it("emits morning_window when V3 flag is set and target minute reached in primary window", () => {
        process.env.BHAI_PROACTIVE_V3_SOURCES = "true";
        const emitted = maybeEmitMorningBoundary({
            minutesNow: 8 * 60,
            todayStr: "2026-05-08",
            inWindow: true,
            targetMinute: 7 * 60 + 30,
        });
        expect(emitted).toBe(true);
        expect(events.some((e) => e.kind === "morning_window")).toBe(true);
    });

    it("does not emit when V3 flag is off", () => {
        process.env.BHAI_PROACTIVE_V3_SOURCES = "false";
        const emitted = maybeEmitMorningBoundary({
            minutesNow: 8 * 60,
            todayStr: "2026-05-08",
            inWindow: true,
            targetMinute: 7 * 60 + 30,
        });
        expect(emitted).toBe(false);
        expect(events).toHaveLength(0);
    });

    it("does not emit when target minute is not yet reached", () => {
        process.env.BHAI_PROACTIVE_V3_SOURCES = "true";
        const emitted = maybeEmitMorningBoundary({
            minutesNow: 7 * 60,
            todayStr: "2026-05-08",
            inWindow: true,
            targetMinute: 8 * 60,
        });
        expect(emitted).toBe(false);
    });

    it("emits catch-up when past 10am and not yet sent today", () => {
        process.env.BHAI_PROACTIVE_V3_SOURCES = "true";
        const emitted = maybeEmitMorningBoundary({
            minutesNow: 11 * 60,
            todayStr: "2026-05-08",
            inWindow: false,
            targetMinute: -1,
        });
        expect(emitted).toBe(true);
        expect(events.some((e) => e.kind === "morning_window")).toBe(true);
    });

    it("deduplicates — second call same day does not re-emit", () => {
        process.env.BHAI_PROACTIVE_V3_SOURCES = "true";
        const first = maybeEmitMorningBoundary({
            minutesNow: 8 * 60,
            todayStr: "2026-05-08",
            inWindow: true,
            targetMinute: 7 * 60 + 30,
        });
        expect(first).toBe(true);
        const second = maybeEmitMorningBoundary({
            minutesNow: 9 * 60,
            todayStr: "2026-05-08",
            inWindow: true,
            targetMinute: 7 * 60 + 30,
        });
        expect(second).toBe(false);
    });
});
