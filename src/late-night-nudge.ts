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

// ponytail: hand-written detector checked against the labelled corpus in
// late-night-nudge.test.ts; add a miss or false hit there before touching it.
// A miss costs one more remark; a false hit mutes time talk for the night.

// "it's 1:15 AM", "almost 1 o'clock", "nearly midnight": the current local time.
const CLOCK_RE =
    /\b(?:it[’']?s|it is|already|almost|nearly|now|past)\s+(?:about |almost |nearly |already |like |just |past |gone )?(?:(\d{1,2})(?::\d{2})?\s*(a\.?m\b|p\.?m\b|o[’']?\s?clock\b|in the morning\b|at night\b)|midnight\b)(?!,?\s+(?:there|for (?:them|him|her))\b)/gi;
// Talk aimed at the user's own night: rest, still being up, the late hour.
const REMARK_RE = new RegExp(
    [
        String.raw`\b(?:past|after) midnight\b`,
        String.raw`\b\d{1,2} baj gaye\b`,
        String.raw`\blate[ -]night\b`,
        String.raw`\b(?:up|on|working|awake) (?:this|so) late\b`,
        String.raw`\bnight owl\b`,
        String.raw`\b(?:get|grab|catch) some (?:rest|sleep|shut-?eye)\b`,
        String.raw`\btime to (?:crash|sleep|hit the (?:sack|hay|bed)|call it a night)\b`,
        String.raw`\bcall it a night\b`,
        String.raw`\b(?:hit|head to) (?:the )?(?:sack|hay|bed)\b`,
        // imperative "go (to) sleep/bed/crash", not "the Mac will go to sleep"
        String.raw`(?:^|\b(?:now|just|so|pls|please|then|and|should|gotta|need to|must|better)\s+)go (?:to )?(?:sleep|bed|crash)\b`,
        String.raw`\bshouldn[’']?t you be (?:asleep|sleeping|in bed)\b`,
        String.raw`\byou (?:should|need to|gotta|must|better) (?:sleep|rest|crash)\b`,
        String.raw`(?:\b(?:you[’']?re|you are|are you|you)\s|^|,\s*)still (?:up|awake)\b(?! for\b)`,
        String.raw`\bwhy are you (?:still )?(?:up|awake)\b`,
        String.raw`\b(?:up|awake) at this hour\b`,
    ].join("|"),
    "i",
);
// Sentence is about a device, service or timer, not the user ("your Mac is going to sleep").
const DEVICE_RE =
    /\b(?:mac(?:book)?|laptop|computer|pc|display|screen|monitor|server|service|timer|spotify|music|playback|device|phone|iphone|system|machine|app|process|container|pod|database|db|site|website|api|bot|cron|job|build|deploy(?:ment)?|instance|battery)s?\b/i;
// Sentence is about opening hours or another place's clock ("9 AM in New York").
const PLACE_RE =
    /\b(?:open|opens|closed?|closes|closing|(?:business|opening|open|store) hours|deliver(?:y|s)?|store|shop|pharmacy|restaurant|diner|caf[eé]|time ?zone|utc|gmt|[ecmp][sd]t)\b/i;
const OTHER_PLACE_RE = /\b(?:in|over in|for) (?:[A-Z][a-z]+|the (?:US|UK))\b/;
// The reply is about an alarm/reminder/schedule, so a clock mention is information.
const SCHEDULE_RE = /\b(?:alarm|remind(?:er)?s?|timer|wake you|wake-?up|scheduled?|calendar|meeting|flight|set for)\b/i;
// The owner asked for the time or a time-based action.
const TIME_QUESTION_RE =
    /\b(?:what(?:[’']?s| is)? (?:the )?time|time is it|what time|alarm|remind(?:er)?|timer|wake me|time in|time zone|timezone)\b/i;

function isNightClock(hourStr: string | undefined, suffix: string | undefined): boolean {
    if (hourStr === undefined) return true; // midnight
    const h = Number(hourStr);
    const s = (suffix ?? "").toLowerCase().replace(/[.\s’']/g, "");
    if (s.startsWith("p") || s === "atnight") return h >= 9 && h <= 11;
    if (s.startsWith("a") || s === "inthemorning") return h === 12 || (h >= 1 && h <= 3);
    return h >= 9 || h <= 3; // o'clock
}

// Unmistakable "go to sleep" remarks count whatever else the sentence mentions
// ("close the laptop and go to sleep"): a missed remark means more nagging, a
// false hit only mutes unprompted time talk for the night.
const SLEEP_TALK_RE =
    /\b(?:go(?:ing)? (?:to )?(?:sleep|bed)|get some (?:sleep|shut-?eye)|past (?:your )?bedtime|past midnight|call it a night|time to crash|run(?:ning)? on empty|up (?:this|so) late|\d{1,2} baj (?:gaye|rahe)|so ja(?:o)?)\b/i;

/** True when `reply` remarks on the user being up late (not a time answer, device or opening hours). */
export function isLateHourRemark(reply: string, userText = ""): boolean {
    if (SLEEP_TALK_RE.test(reply) && !/\b(?:kids?|baby|dog|cat|mac|computer|laptop|server|device|phone|display|screen|spotify|music|timer|app|tv)\s+(?:is |will |should |needs? to |can |also )?go(?:es|ing)? (?:to )?(?:sleep|bed)/i.test(reply)) return true;
    const clockAllowed = !TIME_QUESTION_RE.test(userText) && !SCHEDULE_RE.test(reply);
    for (const sentence of reply.split(/(?<=[.!?…])\s+|\n+/)) {
        const s = sentence.trim();
        if (!s || PLACE_RE.test(s) || OTHER_PLACE_RE.test(s)) continue;
        if (REMARK_RE.test(s) && !DEVICE_RE.test(s)) return true;
        if (clockAllowed) for (const m of s.matchAll(CLOCK_RE)) if (isNightClock(m[1], m[2])) return true;
    }
    return false;
}

let nudgedNight: string | null | undefined; // undefined = not loaded yet

const stateFile = () => path.join(getDataDir(), "late-night-nudge.json");

function localHour(now: Date, tz: string): number {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
}

function isNight(now: Date, tz: string): boolean {
    const h = localHour(now, tz);
    return h >= NIGHT_START_HOUR || h < ROLLOVER_HOUR;
}

/** Local date of the night `now` belongs to: 1 AM on the 29th → "…-28". Local
 *  hours, not elapsed ones, so the DST fall-back night (25 h) stays one night. */
function nightKey(now: Date, tz: string): string {
    const p = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            hourCycle: "h23",
        })
            .formatToParts(now)
            .map((x) => [x.type, Number(x.value)]),
    );
    const back = p.hour < ROLLOVER_HOUR ? 1 : 0;
    return new Date(Date.UTC(p.year, p.month - 1, p.day - back)).toISOString().slice(0, 10);
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

/** Call with each reply sent to the owner (and what they said); records the night if it remarked on the hour. */
export function noteOwnerReply(text: string, userText = "", now = new Date(), tz = getTimezone()): void {
    if (!text || !isNight(now, tz) || !isLateHourRemark(text, userText)) return;
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
