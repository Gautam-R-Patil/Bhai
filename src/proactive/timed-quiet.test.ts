// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "not now" holds proactive sends for 2h; urgent ones still pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sender } = vi.hoisted(() => ({ sender: vi.fn(async () => {}) }));
vi.mock("../tools/channel-send.js", () => ({ getChannelSender: () => sender }));
vi.mock("../setup/personality-sync.js", () => ({ getToneReminder: () => null }));
// OS Do-Not-Disturb reads as off.
vi.mock("node:child_process", () => ({
    execFile: (...args: unknown[]) => (args.at(-1) as (e: Error) => void)(new Error("no DND")),
}));

const { _resetQuietForTests, isQuietNow, noteOwnerBusy } = await import("./kill-switches.js");
const { dispatchProactiveMessage } = await import("./dispatch.js");
const { shouldSuppressMessage } = await import("./dnd.js");

describe("timed quiet", () => {
    beforeEach(() => {
        _resetQuietForTests();
        sender.mockClear();
    });

    it("short brush-offs quiet for 2h; ordinary messages don't", () => {
        for (const t of ["not now", "busy", "in a meeting, later", "abhi nahi yaar", "can't talk"]) {
            _resetQuietForTests();
            noteOwnerBusy(t, 0);
            expect(isQuietNow(119 * 60_000), t).toBe(true);
            expect(isQuietNow(121 * 60_000), t).toBe(false);
        }
        _resetQuietForTests();
        for (const t of ["is the server busy?", "later today remind me to file the GST return please", "hey"]) {
            noteOwnerBusy(t, 0);
            expect(isQuietNow(1), t).toBe(false);
        }
    });

    it("holds ordinary proactive sends at dispatch, not urgent ones", async () => {
        noteOwnerBusy("not now");
        expect(await dispatchProactiveMessage("telegram", "how'd the demo go?", "fyi")).toBe(false);
        expect(sender).not.toHaveBeenCalled();
        expect(
            await dispatchProactiveMessage("telegram", "Your flight boards in 20 min", "fyi", undefined, false, true),
        ).toBe(true);
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it("doesn't hold sends the owner asked for (the shared Telegram/overlay gate)", async () => {
        noteOwnerBusy("not now");
        expect(await shouldSuppressMessage("here's the ward number: B-214")).toBe(false);
    });
});
