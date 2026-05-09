// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { fetchCalendarToday } from "./_shared/calendar-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 300;

export const CALENDAR_PREP: IntentSourceModule = {
    name: "calendar_prep",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("calendar_prep", GATE_SEC);
        if (!gate.mayRun) return [];

        let events;
        try {
            events = await fetchCalendarToday();
        } catch (err) {
            debugProactive("calendar_prep_fetch_failed", { err: (err as Error).message });
            return [];
        }
        if (events.length === 0) return [];

        const preps = native.calendarPrepIntents(events, ctx.now, 15);
        if (preps.length === 0) return [];

        const intents: ProactiveIntent[] = [];
        for (const prep of preps) {
            const evidence: Array<{ label: string; value: string }> = [
                { label: "event", value: prep.title },
                { label: "at", value: new Date(prep.eventStartMs).toISOString() },
            ];
            if (prep.location) evidence.push({ label: "where", value: prep.location });

            const intent = await buildIntent({
                source: "calendar_prep",
                mode: "fyi",
                urgency: "urgent",
                channelPreference: "telegram",
                payloadKind: "meeting_prep",
                topic: `prep ${prep.eventId}`,
                scheduledFor: prep.fireAtMs,
                expiresAtMs: prep.eventStartMs + 10 * 60_000,
                evidence,
                payload: {
                    kind: "meeting_prep",
                    eventId: prep.eventId,
                    title: prep.title,
                    startMs: prep.eventStartMs,
                    location: prep.location,
                    hasAttendees: prep.hasAttendees,
                },
            });
            intents.push(intent);
        }
        return intents;
    },
};
