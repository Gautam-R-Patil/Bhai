// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { fetchCalendarToday } from "./_shared/calendar-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 300;

export const MEETING_FOLLOWUP: IntentSourceModule = {
    name: "meeting_followup",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("meeting_followup", GATE_SEC);
        if (!gate.mayRun) return [];

        let events;
        try {
            events = await fetchCalendarToday();
        } catch (err) {
            debugProactive("meeting_followup_fetch_failed", { err: (err as Error).message });
            return [];
        }
        if (events.length === 0) return [];

        const followups = native.calendarPrepIntents(events, ctx.now, -10);
        if (followups.length === 0) return [];

        const intents: ProactiveIntent[] = [];
        for (const prep of followups) {
            const intent = await buildIntent({
                source: "meeting_followup",
                mode: "question",
                urgency: "normal",
                channelPreference: "telegram",
                payloadKind: "meeting_debrief",
                topic: `debrief ${prep.eventId}`,
                scheduledFor: prep.fireAtMs,
                expiresAtMs: prep.eventStartMs + 60 * 60_000,
                evidence: [
                    { label: "event", value: prep.title },
                    { label: "ended_at", value: new Date(prep.eventStartMs).toISOString() },
                ],
                payload: {
                    kind: "meeting_debrief",
                    eventId: prep.eventId,
                    title: prep.title,
                    endedAt: prep.eventStartMs,
                },
            });
            intents.push(intent);
        }
        return intents;
    },
};
