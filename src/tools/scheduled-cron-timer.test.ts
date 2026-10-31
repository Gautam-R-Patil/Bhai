// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A recurring schedule_task job runs on one timer per job, on the minutes node-cron would fire.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
    process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sched-cron-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 10, 0, 30)); // Fri 30 Oct 2026, 10:00:30 local
});
afterEach(() => {
    vi.useRealTimers();
    delete process.env.BHAI_DATA_DIR;
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

it("still runs a job due just after the Mac wakes, though the pending step fires late", async () => {
    const { scheduleTask, fired } = await load();
    await scheduleTask.handler({ expression: "0 * * * *", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(58 * 60_000 + 10_000); // 10:58:40, a 60 s step armed at 10:58:30
    vi.setSystemTime(new Date(2026, 9, 30, 11, 59, 30)); // asleep; wake 30 s before 12:00 (timers paused)
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired.map((t) => new Date(t).getHours())).toEqual([12]);
});

it("keeps a job whose runs are more than a year apart (Friday the 13th, Feb 29)", async () => {
    const at = (...a: [number, number, number, number, number]) => new Date(...a).getTime();
    vi.setSystemTime(new Date(2027, 7, 12, 12, 0)); // Thu 12 Aug 2027
    const { scheduleTask, fired, nextCronMinute } = await load();
    expect(nextCronMinute("0 9 13 * 5", at(2027, 7, 13, 9, 0))).toBe(at(2028, 9, 13, 9, 0));
    expect(nextCronMinute("0 9 29 2 *", at(2096, 1, 29, 9, 0))).toBe(at(2104, 1, 29, 9, 0));
    await scheduleTask.handler({ expression: "0 9 13 * 5", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000);
    expect(fired.map((t) => new Date(t).toDateString())).toEqual(["Fri Aug 13 2027"]);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // still armed for Oct 2028
});

it("runs a job due just after the Mac wakes on time when the desktop says it woke", async () => {
    const { scheduleTask, fired, cronTimersOnWake } = await load();
    await scheduleTask.handler({ expression: "0 * * * *", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(58 * 60_000 + 10_000); // 10:58:40, a 60 s step armed at 10:58:30
    vi.setSystemTime(new Date(2026, 9, 30, 11, 59, 30)); // asleep; wake 30 s before 12:00 (timers paused)
    cronTimersOnWake();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fired.map((t) => new Date(t).toTimeString().slice(0, 8))).toEqual(["12:00:00"]);
    cronTimersOnWake(); // a second wake signal doesn't run it again
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toHaveLength(1);
});

it("a wake signal runs what came due at the wake, but not runs slept through", async () => {
    const { scheduleTask, fired, cronTimersOnWake } = await load();
    await scheduleTask.handler({ expression: "* * * * *", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(10_000); // 10:00:40, a 20 s step pending
    vi.setSystemTime(new Date(2026, 9, 30, 10, 30, 1)); // woke at 10:30:00, the signal a second later
    cronTimersOnWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(fired.map((t) => new Date(t).toTimeString().slice(0, 8))).toEqual(["10:30:01"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(2);
});

it("the desktop's ##BHAI_RESUME## line is the wake signal", async () => {
    const { scheduleTask, fired } = await load();
    const { handleDesktopLine } = await import("../security/vault.js");
    await scheduleTask.handler({ expression: "0 * * * *", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(58 * 60_000 + 10_000);
    vi.setSystemTime(new Date(2026, 9, 30, 11, 59, 30));
    handleDesktopLine("##BHAI_RESUME##");
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fired.map((t) => new Date(t).toTimeString().slice(0, 8))).toEqual(["12:00:00"]);
});

it("a wake signal that comes a few seconds late still runs a job due after the wake", async () => {
    const { scheduleTask, fired, cronTimersOnWake } = await load();
    await scheduleTask.handler({ expression: "0 * * * *", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(58 * 60_000 + 10_000); // 10:58:40, a 60 s step armed at 10:58:30
    vi.setSystemTime(new Date(2026, 9, 30, 11, 59, 58)); // woke 2 s before 12:00
    await vi.advanceTimersByTimeAsync(6_000); // the signal comes 6 s after the wake, at 12:00:04
    cronTimersOnWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(fired.map((t) => new Date(t).toTimeString().slice(0, 8))).toEqual(["12:00:04"]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toHaveLength(1);
});

it("keeps a job whose next run is more than 8 years after a run (Dec 31 on a Friday: 2038, then 2049)", async () => {
    vi.setSystemTime(new Date(2038, 11, 30, 12, 0)); // Thu 30 Dec 2038
    const { scheduleTask, fired, nextCronMinute } = await load();
    expect(nextCronMinute("0 0 31 12 5", new Date(2038, 11, 31, 0, 0).getTime())).toBeNull(); // past the scan
    await scheduleTask.handler({ expression: "0 0 31 12 5", description: "d", action: "a" });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fired.map((t) => new Date(t).toDateString())).toEqual(["Fri Dec 31 2038"]);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // still armed, looking again later
    vi.setSystemTime(new Date(2049, 11, 1)); // the process stays up (time jumps, as across a sleep)
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1); // the long look-again step ends: 2049 is in the scan
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000);
    expect(fired.map((t) => new Date(t).toString().slice(0, 24))).toEqual([
        "Fri Dec 31 2038 00:00:00",
        "Fri Dec 31 2049 00:00:00",
    ]);
});
