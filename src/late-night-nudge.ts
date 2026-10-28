// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// identity.md says to mention the late hour "once per night", but the model
// sees a fresh clock every turn and can't remember that it already did. So we
// remember for it: spot the nudge in an outgoing owner reply, store the night
// (local date, rolling over at 4 AM) in a tiny file that survives restarts,
// and on later owner turns that night add one line telling it to drop the topic.

import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./config/paths.js";
import { getTimezone } from "./location/index.js";

export const ALREADY_NUDGED_NOTE =
    "You already mentioned the late hour tonight; don't bring up the time again unless they ask.";

const ROLLOVER_HOUR = 4;
const NIGHT_START_HOUR = 21;

// ponytail: phrase heuristic, built from real late-night replies. A miss just
// means one more nudge; a false hit just mutes time talk for the night.
const NUDGE_RE =
    /\b(?:past midnight|it[’']?s (?:about |almost |nearly |already |like )?\d{1,2}(?::\d{2})? ?a\.?m\b|\d{1,2} baj gaye|(?:be|get|go(?:ing)?(?: to)?) (?:asleep|to sleep|to bed|some sleep|sleep)\b|still up\b|up (?:this|so) late|at this hour|night owl|after you sleep|sleep on it)/i;

let nudgedNight: string | null | undefined; // undefined = not loaded yet

const stateFile = () => path.join(getDataDir(), "late-night-nudge.json");

function localHour(now: Date, tz: string): number {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
}

function isNight(now: Date, tz: string): boolean {
    const h = localHour(now, tz);
    return h >= NIGHT_START_HOUR || h < ROLLOVER_HOUR;
}

/** Local date of the night `now` belongs to: 1 AM on the 29th → "…-28". */
function nightKey(now: Date, tz: string): string {
    return new Date(now.getTime() - ROLLOVER_HOUR * 3_600_000).toLocaleDateString("en-CA", { timeZone: tz });
}

function loadNight(): string | null {
    if (nudgedNight === undefined) {
        try {
            nudgedNight = JSON.parse(fs.readFileSync(stateFile(), "utf8")).night ?? null;
        } catch {
            nudgedNight = null;
        }
    }
    return nudgedNight ?? null;
}

/** Call with each reply sent to the owner; records the night if it nudged about the hour. */
export function noteOwnerReply(text: string, now = new Date(), tz = getTimezone()): void {
    if (!text || !isNight(now, tz) || !NUDGE_RE.test(text)) return;
    const key = nightKey(now, tz);
    if (loadNight() === key) return;
    nudgedNight = key;
    try {
        fs.mkdirSync(getDataDir(), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify({ night: key }));
    } catch {
        /* fail-open: in-memory flag still covers this run */
    }
}

/** The system note for an owner turn, or null when no nudge happened yet tonight. */
export function lateNightNote(now = new Date(), tz = getTimezone()): string | null {
    return isNight(now, tz) && loadNight() === nightKey(now, tz) ? ALREADY_NUDGED_NOTE : null;
}

export function _resetLateNightNudge(): void {
    nudgedNight = undefined;
}
