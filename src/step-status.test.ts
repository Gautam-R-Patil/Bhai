// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatStepStatus, mapStepStatus, parseStepLine, startStepHeartbeat } from "./step-status.js";

describe("formatStepStatus", () => {
    it("names the step, the status and whole seconds since the turn began", () => {
        expect(formatStepStatus(3, "🌐 Opening example.com...", 42_400)).toBe(
            "step 3 · 🌐 Opening example.com... · 42s",
        );
        expect(formatStepStatus(1, "  working on it ", 0)).toBe("step 1 · working on it · 0s");
    });
});

describe("mapStepStatus", () => {
    it("rewrites only the status and keeps step + elapsed", () => {
        expect(mapStepStatus('step 2 · 🔍 Searching: "a · b" · 15s', (s) => s.toUpperCase())).toBe(
            'step 2 · 🔍 SEARCHING: "A · B" · 15s',
        );
    });
    it("drops a step line whose status the channel hides, and passes other messages whole", () => {
        expect(mapStepStatus("step 2 · ⚠️ nope · 15s", () => null)).toBeNull();
        expect(mapStepStatus("Searching the web...", (s) => `[${s}]`)).toBe("[Searching the web...]");
    });
});

describe("parseStepLine", () => {
    it("splits a step line so a heartbeat resend can be matched by step + status", () => {
        expect(parseStepLine("step 2 · ⚙️ Running command: npm test · 40s")).toEqual({
            step: 2,
            status: "⚙️ Running command: npm test",
            elapsedMs: 40_000,
        });
        expect(parseStepLine("📋 plan: 5 steps")).toBeNull();
    });
    it("lets a channel cap the status without cutting the elapsed time off", () => {
        const long = formatStepStatus(4, `🔍 Searching: "${"q".repeat(120)}"`, 60_000);
        const capped = mapStepStatus(long, (s) => s.substring(0, 80));
        expect(capped.endsWith(" · 60s")).toBe(true);
        expect(capped.length).toBeLessThanOrEqual(100);
    });
});

describe("startStepHeartbeat", () => {
    afterEach(() => vi.useRealTimers());

    it("re-sends every ~20s of silence and stops when the batch ends", () => {
        vi.useFakeTimers();
        let lastSent = 0;
        const resend = vi.fn(() => {
            lastSent = Date.now();
        });
        const stop = startStepHeartbeat(() => lastSent, resend);

        vi.advanceTimersByTime(19_000);
        expect(resend).not.toHaveBeenCalled(); // a fresh batch isn't quiet yet
        vi.advanceTimersByTime(1_000);
        expect(resend).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(20_000);
        expect(resend).toHaveBeenCalledTimes(2);

        stop();
        vi.advanceTimersByTime(60_000);
        expect(resend).toHaveBeenCalledTimes(2);
    });

    it("holds off while other progress keeps going out", () => {
        vi.useFakeTimers();
        let lastSent = Date.now();
        const resend = vi.fn();
        const stop = startStepHeartbeat(() => lastSent, resend);
        for (let i = 0; i < 6; i++) {
            vi.advanceTimersByTime(10_000);
            lastSent = Date.now(); // a milestone every 10s
        }
        expect(resend).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20_000);
        expect(resend).toHaveBeenCalledTimes(1);
        stop();
    });
});
