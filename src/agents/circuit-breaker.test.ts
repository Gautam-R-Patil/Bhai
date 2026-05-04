// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
    createCircuitBreaker,
    recordProgress,
    recordFailure,
    recordNoProgress,
    shouldTrip,
    tryHalfOpen,
    getStatusMessage,
    resetCircuitBreaker,
} from "./circuit-breaker.js";

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("circuit-breaker — initial state", () => {
    it("starts in CLOSED state", () => {
        const cb = createCircuitBreaker();
        expect(cb.state).toEqual("closed");
        expect(cb.failureCount).toEqual(0);
        expect(cb.consecutiveNoProgress).toEqual(0);
        expect(cb.tripCount).toEqual(0);
    });

    it("initial lastProgressAt is near Date.now()", () => {
        const before = Date.now();
        const cb = createCircuitBreaker();
        expect(cb.lastProgressAt).toBeGreaterThanOrEqual(before);
    });
});

describe("circuit-breaker — recordProgress", () => {
    it("resets failure count", () => {
        const cb = createCircuitBreaker();
        recordFailure(cb);
        recordFailure(cb);
        expect(cb.failureCount).toEqual(2);
        recordProgress(cb);
        expect(cb.failureCount).toEqual(0);
    });

    it("resets no-progress counters", () => {
        const cb = createCircuitBreaker();
        recordNoProgress(cb);
        recordNoProgress(cb);
        expect(cb.consecutiveNoProgress).toEqual(2);
        recordProgress(cb);
        expect(cb.consecutiveNoProgress).toEqual(0);
    });

    it("transitions HALF-OPEN → CLOSED on success + resets tripCount", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        cb.state = "half-open";
        cb.tripCount = 3;
        recordProgress(cb);
        expect(cb.state).toEqual("closed");
        expect(cb.tripCount).toEqual(0);
    });
});

describe("circuit-breaker — recordFailure", () => {
    it("increments failureCount", () => {
        const cb = createCircuitBreaker();
        recordFailure(cb);
        recordFailure(cb);
        expect(cb.failureCount).toEqual(2);
    });

    it("transitions HALF-OPEN → OPEN on failure, increments tripCount", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        cb.state = "half-open";
        cb.tripCount = 1;
        recordFailure(cb);
        expect(cb.state).toEqual("open");
        expect(cb.tripCount).toEqual(2);
    });
});

describe("circuit-breaker — shouldTrip", () => {
    it("trips on 5 consecutive failures", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        for (let i = 0; i < 5; i++) recordFailure(cb);
        const result = shouldTrip(cb);
        expect(result.trip).toBe(true);
        expect(cb.state).toEqual("open");
        expect(result.reason).toContain("5 consecutive failures");
    });

    it("does not trip on 4 consecutive failures (below threshold)", () => {
        const cb = createCircuitBreaker();
        for (let i = 0; i < 4; i++) recordFailure(cb);
        expect(shouldTrip(cb).trip).toBe(false);
    });

    it("trips on 8 consecutive no-progress iterations", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        for (let i = 0; i < 8; i++) recordNoProgress(cb);
        const result = shouldTrip(cb);
        expect(result.trip).toBe(true);
        expect(result.reason).toContain("consecutive no-progress");
    });

    it("trips on time-based no-progress (3+ minutes)", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        // Advance 3 min 1 sec — past the 3-min timeout
        vi.setSystemTime(new Date("2025-01-01T00:03:01Z"));
        const result = shouldTrip(cb);
        expect(result.trip).toBe(true);
        expect(result.reason).toContain("No progress");
    });

    it("returns trip:true when already OPEN (idempotent)", () => {
        const cb = createCircuitBreaker();
        cb.state = "open";
        expect(shouldTrip(cb).trip).toBe(true);
    });

    it("returns trip:true when in HALF-OPEN (locked until probe)", () => {
        const cb = createCircuitBreaker();
        cb.state = "half-open";
        expect(shouldTrip(cb).trip).toBe(true);
    });

    it("tripCount increments on each trip", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        for (let i = 0; i < 5; i++) recordFailure(cb);
        shouldTrip(cb);
        expect(cb.tripCount).toEqual(1);
    });
});

describe("circuit-breaker — tryHalfOpen", () => {
    it("returns false if not in OPEN state", () => {
        const cb = createCircuitBreaker();
        expect(tryHalfOpen(cb)).toBe(false);
    });

    it("transitions to HALF-OPEN after initial 30s cooldown", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount = 1;
        // 31s later
        vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
        expect(tryHalfOpen(cb)).toBe(true);
        expect(cb.state).toEqual("half-open");
    });

    it("does NOT transition before cooldown elapses", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const cb = createCircuitBreaker();
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount = 1;
        // 5s later — below 30s cooldown
        vi.setSystemTime(new Date("2025-01-01T00:00:05Z"));
        expect(tryHalfOpen(cb)).toBe(false);
        expect(cb.state).toEqual("open");
    });

    it("uses escalated cooldown (60s) when tripCount > 1", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount = 2;
        // 31s — less than escalated 60s cooldown
        vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
        expect(tryHalfOpen(cb)).toBe(false);
        // 61s — past escalated cooldown
        vi.setSystemTime(new Date("2025-01-01T00:01:01Z"));
        expect(tryHalfOpen(cb)).toBe(true);
    });
});

describe("circuit-breaker — getStatusMessage", () => {
    it("reports CLOSED as normal operation", () => {
        const cb = createCircuitBreaker();
        expect(getStatusMessage(cb)).toContain("CLOSED");
        expect(getStatusMessage(cb)).toContain("normal operation");
    });

    it("OPEN state reports remaining cooldown", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const cb = createCircuitBreaker();
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount = 1;
        // 10s in
        vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));
        const msg = getStatusMessage(cb);
        expect(msg).toContain("OPEN");
        expect(msg).toMatch(/Will retry in \d+s/);
    });

    it("OPEN state with escalated cooldown uses 60s for trip > 1", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const cb = createCircuitBreaker();
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount = 3;
        vi.setSystemTime(new Date("2025-01-01T00:00:15Z"));
        const msg = getStatusMessage(cb);
        // 60 - 15 = 45s remaining
        expect(msg).toMatch(/Will retry in 45s/);
    });

    it("HALF-OPEN reports probe attempt", () => {
        const cb = createCircuitBreaker();
        cb.state = "half-open";
        const msg = getStatusMessage(cb);
        expect(msg).toContain("HALF-OPEN");
        expect(msg).toContain("probe");
    });
});

describe("circuit-breaker — resetCircuitBreaker", () => {
    it("clears all counters + state", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const cb = createCircuitBreaker();
        cb.state = "open";
        cb.failureCount = 10;
        cb.consecutiveNoProgress = 5;
        cb.tripCount = 3;
        cb.openedAt = 1000;
        resetCircuitBreaker(cb);
        expect(cb.state).toEqual("closed");
        expect(cb.failureCount).toEqual(0);
        expect(cb.consecutiveNoProgress).toEqual(0);
        expect(cb.tripCount).toEqual(0);
        expect(cb.openedAt).toEqual(0);
    });

    it("updates lastProgressAt to Date.now()", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        const cb = createCircuitBreaker();
        cb.lastProgressAt = 1;
        vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));
        resetCircuitBreaker(cb);
        expect(cb.lastProgressAt).toEqual(Date.now());
    });
});

describe("circuit-breaker — full lifecycle", () => {
    it("CLOSED → OPEN → (cooldown) → HALF-OPEN → CLOSED", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();

        // 5 failures → trip
        for (let i = 0; i < 5; i++) recordFailure(cb);
        expect(shouldTrip(cb).trip).toBe(true);
        expect(cb.state).toEqual("open");

        // Wait past cooldown
        vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
        expect(tryHalfOpen(cb)).toBe(true);
        expect(cb.state).toEqual("half-open");

        // Success → back to CLOSED
        recordProgress(cb);
        expect(cb.state).toEqual("closed");
        expect(cb.tripCount).toEqual(0);
    });

    it("CLOSED → OPEN → HALF-OPEN → OPEN (failed probe, escalated cooldown)", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const cb = createCircuitBreaker();
        for (let i = 0; i < 5; i++) recordFailure(cb);
        shouldTrip(cb);
        expect(cb.state).toEqual("open");

        vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
        tryHalfOpen(cb);
        expect(cb.state).toEqual("half-open");

        // Probe failed
        recordFailure(cb);
        expect(cb.state).toEqual("open");
        expect(cb.tripCount).toBeGreaterThanOrEqual(2);
    });
});
