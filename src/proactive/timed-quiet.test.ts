// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "not now" holds proactive sends for 2h; urgent ones still pass.
import { beforeEach, describe, expect, it } from "vitest";
import { shouldSuppressMessage } from "./dnd.js";
import { _resetQuietForTests, isQuietNow, noteOwnerBusy } from "./kill-switches.js";

describe("timed quiet", () => {
    beforeEach(() => _resetQuietForTests());

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

    it("holds ordinary sends at the sender, not urgent ones", async () => {
        noteOwnerBusy("not now");
        expect(await shouldSuppressMessage("how'd the demo go?")).toBe(true);
        expect(await shouldSuppressMessage("⏰ Reminder: call the bank")).toBe(false);
    });
});
