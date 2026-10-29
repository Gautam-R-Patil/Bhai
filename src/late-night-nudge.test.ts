// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "late-nudge-"));
const { ALREADY_NUDGED_NOTE, _resetLateNightNudge, isLateHourRemark, lateNightNote, noteOwnerReply } = await import(
    "./late-night-nudge.js"
);

const TZ = "Asia/Kolkata"; // UTC+5:30
const at = (iso: string) => new Date(iso);
// Real 2026-10-28 session, IST: 00:24, 00:28, 01:21.
const T1 = at("2026-10-28T18:54:57Z");
const T2 = at("2026-10-28T18:58:02Z");
const T3 = at("2026-10-28T19:51:00Z");

// Labelled replies sent to the owner at night: [reply, isRemark, ownerMessage?].
// Includes every case from the review of the first version.
const CORPUS: [string, boolean, string?][] = [
    // remarks about the owner being up late
    ["hey, what's up? Shouldn't you be asleep? It's past midnight.", true],
    ["Hey, you're back. It's 12:28 AM and you've got your demo stress going on", true],
    ["Hey. It's about 12:51 AM and your demo code is still broken", true],
    ["It’s 1 AM and you're still just saying hey.", true],
    ["2 baj gaye. kal fresh dimaag se karein?", true],
    ["done. now go sleep.", true],
    ["It's 11 PM, wrap up soon.", true],
    ["It's 1:15 in the morning.", true],
    ["Almost 1 o'clock. Time to crash?", true],
    ["Late night again? Let's keep it short.", true],
    ["You should get some rest.", true],
    ["still up? it's 11 at night", true],
    ["You're still up? Fine, paste the stack trace.", true],
    ["Why are you still awake, bhai?", true],
    ["It's nearly midnight. The fix is in, go to bed.", true],
    ["Pushed the fix. Now get some sleep, it's 2:40 a.m.", true],
    ["Hey, still awake? The deploy went through.", true],
    ["What are you doing up at this hour?", true],
    ["It's already 3 AM. Let's call it a night after this one.", true],
    ["Shipped. Go to sleep.", true],
    ["Working this late again? Okay, what's broken.", true],
    ["Classic night owl move. What do you need?", true],
    ["It's 11 p.m. and you're still on this? Alright.", true],
    ["Tests pass. Time to hit the sack.", true],
    // replies that mention sleep, time or "up" but are not a remark about the owner
    ["paste the build error and we'll deal with it.", false],
    ["Your Mac is going to sleep now.", false],
    ["The server is still up and responding.", false],
    ["Spotify will go to sleep after the timer.", false],
    ["It's 9 AM in New York right now, so they're probably online.", false],
    ["It's 2 AM in Tokyo, so don't call them now.", false],
    ["The pharmacy is closed at this hour, but the one on MG Road is open 24 hours.", false],
    ["Set your alarm. It's 12:30 AM now, so 7 hours gets you to 7:30.", false],
    ["Hmm, sleep on it?", false],
    ["Reminder set for 2:30 AM.", false],
    ["It's 12:40 AM.", false, "what time is it?"],
    ["It's 1:05 AM, so the timer has 25 minutes left.", false, "how long on the timer?"],
    ["Alarm set for 6:30. It's 1 AM now, that's five and a half hours.", false],
    ["Put the display to sleep after 10 minutes and the Mac goes to sleep after 30.", false],
    ["The container is still up, health checks are green.", false],
    ["Are you still up for the 10 AM call tomorrow? I'll prep the notes.", false],
    ["Most stores near you close at 11 PM.", false],
    ["Their support hours are 9 AM to 6 PM EST.", false],
    ["Your flight lands at 1:30 AM local time.", false],
    ["The cron job runs at midnight UTC.", false],
    ["Done, the email is sent.", false],
    ["It's 1 AM there, so Rahul is likely asleep.", false],
    ["The build will crash if you skip that env var.", false],
    ["Battery is at 12%, the laptop will go to sleep soon.", false],
];

describe("late-hour remark detector", () => {
    it("has high precision and recall on the labelled corpus", () => {
        let tp = 0;
        let fp = 0;
        let fn = 0;
        const wrong: string[] = [];
        for (const [reply, label, user] of CORPUS) {
            const got = isLateHourRemark(reply, user);
            if (got && label) tp++;
            else if (got) fp++;
            else if (label) fn++;
            if (got !== label) wrong.push(`${label ? "missed" : "false hit"}: ${reply}`);
        }
        expect(CORPUS.length).toBeGreaterThanOrEqual(40);
        expect(wrong).toEqual([]);
        expect(tp / (tp + fp)).toBe(1); // precision
        expect(tp / (tp + fn)).toBe(1); // recall
    });
});

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
            noteOwnerReply(reply, "", T1, TZ);
            expect(lateNightNote(T2, TZ), reply).toBe(ALREADY_NUDGED_NOTE);
        }
    });

    it("stays quiet until a nudge is sent, then notes the rest of the night", () => {
        noteOwnerReply("paste the build error and we'll deal with it.", "", T1, TZ);
        expect(lateNightNote(T2, TZ)).toBeNull();
        noteOwnerReply("Shouldn't you be asleep? It's past midnight.", "", T1, TZ);
        expect(lateNightNote(T2, TZ)).toBe(ALREADY_NUDGED_NOTE);
        expect(lateNightNote(T3, TZ)).toBe(ALREADY_NUDGED_NOTE);
    });

    it("survives a restart (persisted per night)", () => {
        noteOwnerReply("It's 12:28 AM, go to bed", "", T1, TZ);
        _resetLateNightNudge();
        expect(lateNightNote(T3, TZ)).toBe(ALREADY_NUDGED_NOTE);
    });

    it("rolls over at 4 AM local, and 11 PM belongs to the same night", () => {
        noteOwnerReply("still up? it's 11 at night", "", at("2026-10-28T17:30:00Z"), TZ); // 23:00 IST on the 28th
        expect(lateNightNote(T1, TZ)).toBe(ALREADY_NUDGED_NOTE); // 00:24 on the 29th
        expect(lateNightNote(at("2026-10-28T22:29:00Z"), TZ)).toBe(ALREADY_NUDGED_NOTE); // 03:59
        expect(lateNightNote(at("2026-10-28T22:31:00Z"), TZ)).toBeNull(); // 04:01
        expect(lateNightNote(at("2026-10-29T18:54:57Z"), TZ)).toBeNull(); // next night, 00:24 on the 30th
    });

    it("ignores daytime replies", () => {
        noteOwnerReply("It's 10 AM, still up for the meeting?", "", at("2026-10-29T04:30:00Z"), TZ); // 10:00 IST
        expect(lateNightNote(T1, TZ)).toBeNull();
    });

    it("keeps the DST fall-back night as one night (local hours, not elapsed)", () => {
        const NY = "America/New_York"; // 2026-11-01 02:00 EDT -> 01:00 EST
        noteOwnerReply("It's 11 PM, go to bed", "", at("2026-11-01T03:00:00Z"), NY); // 23:00 EDT Oct 31
        expect(lateNightNote(at("2026-11-01T05:30:00Z"), NY)).toBe(ALREADY_NUDGED_NOTE); // 01:30 EDT
        expect(lateNightNote(at("2026-11-01T06:30:00Z"), NY)).toBe(ALREADY_NUDGED_NOTE); // 01:30 EST
        expect(lateNightNote(at("2026-11-01T08:30:00Z"), NY)).toBe(ALREADY_NUDGED_NOTE); // 03:30 EST
        expect(lateNightNote(at("2026-11-01T09:01:00Z"), NY)).toBeNull(); // 04:01 EST
    });
});
