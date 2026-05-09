// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { fetchCalendarToday } from "./_shared/calendar-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 3600;

function getTimezoneOffsetMin(): number {
    return -new Date().getTimezoneOffset();
}

export const CALENDAR_MORNING: IntentSourceModule = {
    name: "calendar_morning",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("calendar_morning", GATE_SEC);
        if (!gate.mayRun) return [];

        let events;
        try {
            events = await fetchCalendarToday();
        } catch (err) {
            debugProactive("calendar_morning_fetch_failed", { err: (err as Error).message });
            return [];
        }
        if (events.length === 0) return [];

        const analysis = native.calendarAnalyze(
            events,
            ctx.now,
            9,
            18,
            getTimezoneOffsetMin(),
        );

        const topic = `morning calendar ${new Date(ctx.now).toISOString().slice(0, 10)}`;
        const intent = await buildIntent({
            source: "calendar_morning",
            mode: "fyi",
            urgency: "normal",
            channelPreference: "telegram",
            payloadKind: "calendar_today_summary",
            topic,
            evidence: [
                { label: "events_today", value: String(events.length) },
                { label: "conflicts", value: String(analysis.conflicts.length) },
                { label: "morning_meetings", value: String(analysis.morningMeetingCount) },
            ],
            payload: {
                kind: "calendar_today_summary",
                events,
                conflicts: analysis.conflicts,
                back_to_back: analysis.backToBack,
                morning_meeting_count: analysis.morningMeetingCount,
                afternoon_meeting_count: analysis.afternoonMeetingCount,
            },
        });

        return [intent];
    },
};
