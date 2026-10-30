// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A recurring schedule_task job runs on one timer per job, on the minutes node-cron would fire.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
    process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sched-cron-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 10, 0, 30)); // Fri 30 Oct 2026, 10:00:30 local
});
afterEach(() => {
    vi.useRealTimers();
    delete process.env.ATLAS_DATA_DIR;
});

async function load() {
    vi.resetModules();
    const mod = await import("./scheduled.js");
    const fired: number[] = [];
    mod.setTaskTriggerHandler(async () => {
        fired.push(Date.now());
    });
    return { ...mod, fired };
}

it("computes the next minute with node-cron's own rules (names, 7 = Sunday, */2 days)", async () => {
    const { nextCronMinute } = await load();
    const at = (...a: [number, number, number, number, number]) => new Date(...a).getTime();
    const now = Date.now();
    expect(nextCronMinute("0 9 * * MON", now)).toBe(at(2026, 10, 2, 9, 0));
    expect(nextCronMinute("0 9 * * 7", now)).toBe(at(2026, 10, 1, 9, 0));
    expect(nextCronMinute("0 0 */2 * *", now)).toBe(at(2026, 10, 2, 0, 0)); // even days, as node-cron expands it
    expect(nextCronMinute("*/5 * * * *", now)).toBe(at(2026, 9, 30, 10, 5));
    expect(nextCronMinute("0 0 30 2 *", now)).toBeNull();
});

it("fires every 5 minutes on the minute, waking about once a minute instead of every second", async () => {
    const { scheduleTask, fired } = await load();
    const spy = vi.spyOn(globalThis, "setTimeout");
    await scheduleTask.handler({ expression: "*/5 * * * *", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toHaveLength(12);
    for (const t of fired) expect(new Date(t).getMinutes() % 5 === 0 && new Date(t).getSeconds() === 0).toBe(true);
    expect(spy.mock.calls.length).toBeLessThan(120);
});

it("skips a run the machine slept through, then keeps its schedule", async () => {
    const { scheduleTask, fired } = await load();
    await scheduleTask.handler({ expression: "0 * * * *", description: "d", action: "a" });
    vi.setSystemTime(Date.now() + 75 * 60_000); // asleep across 11:00, wake 11:15:30 (timers paused)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired.map((t) => new Date(t).getHours())).toEqual([12]);
});
