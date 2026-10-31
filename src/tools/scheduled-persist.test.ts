// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Reminders and scheduled tasks survive a restart (app update, crash, sign-in).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
    process.env.BHAI_DATA_DIR = dir;
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    delete process.env.BHAI_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh copy of the module: what the bot has after a restart. */
async function boot() {
    vi.resetModules();
    const mod = await import("./scheduled.js");
    const fired: string[] = [];
    const described: Array<string | undefined> = [];
    const runs: Array<{ doTask: boolean; isOwner: boolean }> = [];
    mod.setTaskTriggerHandler(async (_id, action, description, opts) => {
        fired.push(action);
        described.push(description);
        runs.push(opts);
    });
    return { ...mod, fired, described, runs, restored: mod.restoreScheduledTasks() };
}

describe("scheduled tasks across restarts", () => {
    it("a reminder set before a restart still fires after it", async () => {
        const first = await boot();
        await first.setReminder.handler({ minutes: 10, description: "water", action: "Remind me to drink water" });
        await first.scheduleTask.handler({ expression: "0 9 * * *", description: "brief", action: "Morning brief" });

        const second = await boot();
        expect(second.restored).toBe(2);
        const listed = JSON.parse(await second.listTasks.handler({}));
        expect(listed.count).toBe(2);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(second.fired).toEqual(["Remind me to drink water"]);
        expect(second.described).toEqual(["water"]); // what the owner sees
        // Fired one-offs are gone from disk too.
        expect((await boot()).restored).toBe(1);
    });

    it("a reminder due while Bhai was off fires shortly after boot", async () => {
        const first = await boot();
        await first.setReminder.handler({ minutes: 1, description: "call", action: "Call mom" });
        vi.setSystemTime(Date.now() + 60 * 60_000); // an hour later, nothing running

        const second = await boot();
        await vi.advanceTimersByTimeAsync(29_000);
        expect(second.fired).toEqual([]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(second.fired).toEqual(["Call mom"]);
    });

    it("cancelled tasks stay cancelled, and new ids don't reuse old ones", async () => {
        const first = await boot();
        const { id } = JSON.parse(await first.setReminder.handler({ minutes: 5, description: "a", action: "A" }));
        await first.setReminder.handler({ minutes: 5, description: "b", action: "B" });
        await first.cancelTask.handler({ id });

        const second = await boot();
        expect(second.restored).toBe(1);
        const next = JSON.parse(await second.setReminder.handler({ minutes: 5, description: "c", action: "C" }));
        expect(next.id).toBe("reminder_3");
    });

    it("a far-off reminder doesn't fire early, and bad minutes are refused", async () => {
        const { setReminder, fired } = await boot();
        await setReminder.handler({ minutes: 40 * 24 * 60, description: "far", action: "Renew passport" });
        await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000);
        expect(fired).toEqual([]);
        await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60_000);
        expect(fired).toEqual(["Renew passport"]);

        for (const minutes of ["soon", Number.NaN, 0, -5]) {
            expect(
                JSON.parse(await setReminder.handler({ minutes, description: "x", action: "x" })).error,
            ).toBeTruthy();
        }
    });

    it("tasks do their work as whoever scheduled them; plain reminders just remind", async () => {
        const first = await boot();
        const { runWithCallerContext } = await import("./cron-tool.js"); // the copy scheduled.js uses
        await runWithCallerContext({ isOwner: true }, () =>
            first.setReminder.handler({
                minutes: 1,
                description: "weather",
                action: "Check the weather and tell me",
                do_task: true,
            }),
        );
        await first.setReminder.handler({ minutes: 2, description: "stretch", action: "Remind me to stretch" });
        // Outside an owner turn (a contact, or the model passing isOwner itself): no owner tools.
        await first.scheduleTask.handler({
            expression: "0 9 * * *",
            description: "inbox",
            action: "Summarize my inbox",
            isOwner: true,
        });

        const second = await boot(); // the flags survive a restart
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(second.runs).toEqual([
            { doTask: true, isOwner: true },
            { doTask: false, isOwner: false },
        ]);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, "scheduled-tasks.json"), "utf8"));
        expect(saved).toEqual([expect.objectContaining({ description: "inbox", doTask: true, isOwner: false })]);
    });
});
