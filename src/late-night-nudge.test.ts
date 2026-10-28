// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "late-nudge-"));
const { ALREADY_NUDGED_NOTE, _resetLateNightNudge, lateNightNote, noteOwnerReply } = await import(
    "./late-night-nudge.js"
);

const TZ = "Asia/Kolkata"; // UTC+5:30
const at = (iso: string) => new Date(iso);
// Real 2026-10-28 session, IST: 00:24, 00:28, 01:21.
const T1 = at("2026-10-28T18:54:57Z");
const T2 = at("2026-10-28T18:58:02Z");
const T3 = at("2026-10-28T19:51:00Z");

describe("late-night nudge tracker", () => {
    beforeEach(() => {
        fs.rmSync(path.join(process.env.ATLAS_DATA_DIR as string, "late-night-nudge.json"), { force: true });
        _resetLateNightNudge();
    });

    it("spots the real nudges", () => {
        for (const reply of [
            "hey, what's up? Shouldn't you be asleep? It's past midnight.",
            "Hey, you're back. It's 12:28 AM and you've got your demo stress going on",
            "Hey. It's about 12:51 AM and your demo code is still broken",
            "It’s 1 AM and you're still just saying hey.",
            "2 baj gaye. kal fresh dimaag se karein?",
            "done. now go sleep.",
        ]) {
            _resetLateNightNudge();
            fs.rmSync(path.join(process.env.ATLAS_DATA_DIR as string, "late-night-nudge.json"), { force: true });
            noteOwnerReply(reply, T1, TZ);
            expect(lateNightNote(T2, TZ), reply).toBe(ALREADY_NUDGED_NOTE);
        }
    });

    it("stays quiet until a nudge is sent, then notes the rest of the night", () => {
        noteOwnerReply("paste the build error and we'll deal with it.", T1, TZ);
        expect(lateNightNote(T2, TZ)).toBeNull();
        noteOwnerReply("Shouldn't you be asleep? It's past midnight.", T1, TZ);
        expect(lateNightNote(T2, TZ)).toBe(ALREADY_NUDGED_NOTE);
        expect(lateNightNote(T3, TZ)).toBe(ALREADY_NUDGED_NOTE);
    });

    it("survives a restart (persisted per night)", () => {
        noteOwnerReply("It's 12:28 AM, go to bed", T1, TZ);
        _resetLateNightNudge();
        expect(lateNightNote(T3, TZ)).toBe(ALREADY_NUDGED_NOTE);
    });

    it("rolls over at 4 AM local, and 11 PM belongs to the same night", () => {
        noteOwnerReply("still up? it's 11 at night", at("2026-10-28T17:30:00Z"), TZ); // 23:00 IST on the 28th
        expect(lateNightNote(T1, TZ)).toBe(ALREADY_NUDGED_NOTE); // 00:24 on the 29th
        expect(lateNightNote(at("2026-10-28T22:29:00Z"), TZ)).toBe(ALREADY_NUDGED_NOTE); // 03:59
        expect(lateNightNote(at("2026-10-28T22:31:00Z"), TZ)).toBeNull(); // 04:01
        expect(lateNightNote(at("2026-10-29T18:54:57Z"), TZ)).toBeNull(); // next night, 00:24 on the 30th
    });

    it("ignores daytime replies", () => {
        noteOwnerReply("It's 10 AM, still up for the meeting?", at("2026-10-29T04:30:00Z"), TZ); // 10:00 IST
        expect(lateNightNote(T1, TZ)).toBeNull();
    });
});
