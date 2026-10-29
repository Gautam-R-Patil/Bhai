// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { fetchCalendarToday } from "./_shared/calendar-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 900;
const FIRE_WINDOW_MS = 15 * 60_000;
const MAX_INTENTS = 2;

function getTzOffsetMin(): number {
    return -new Date().getTimezoneOffset();
}

export const DEEP_WORK_GAP: IntentSourceModule = {
    name: "deep_work_gap",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("deep_work_gap", GATE_SEC);
        if (!gate.mayRun) return [];

        let events;
        try {
            events = await fetchCalendarToday();
        } catch (err) {
            debugProactive("deep_work_gap_fetch_failed", { err: (err as Error).message });
            return [];
        }

        const analysis = native.calendarAnalyze(events, ctx.now, 9, 18, getTzOffsetMin());
        const { longGaps } = analysis;
        if (longGaps.length === 0) return [];

        const eventById = new Map(events.map(e => [e.id, e]));
        const intents: ProactiveIntent[] = [];

        for (const gap of longGaps) {
            if (intents.length >= MAX_INTENTS) break;
            const withinWindow = gap.startMs - FIRE_WINDOW_MS <= ctx.now && ctx.now <= gap.endMs;
            if (!withinWindow) continue;

            const prevEvent = gap.prevEventId ? eventById.get(gap.prevEventId) : undefined;
            const nextEvent = gap.nextEventId ? eventById.get(gap.nextEventId) : undefined;

            const intent = await buildIntent({
                source: "deep_work_gap",
                mode: "review",
                urgency: "ambient",
                channelPreference: "any",
                payloadKind: "focus_block_offer",
                topic: `gap ${gap.startMs}`,
                evidence: [
                    { label: "duration_min", value: String(gap.durationMin) },
                    { label: "starts_at", value: new Date(gap.startMs).toISOString() },
                ],
                payload: {
                    kind: "focus_block_offer",
                    durationMin: gap.durationMin,
                    prevEventTitle: prevEvent?.title ?? null,
                    nextEventTitle: nextEvent?.title ?? null,
                    gapStartMs: gap.startMs,
                },
                suggestedAction: {
                    toolCalls: [
                        {
                            toolName: "google_calendar",
                            args: {
                                action: "create",
                                title: "Focus block",
                                start_time: new Date(gap.startMs).toISOString(),
                                end_time: new Date(gap.endMs).toISOString(),
                            },
                        },
                    ],
                    summary: "block calendar for focus work",
                },
            });
            intents.push(intent);
        }
        return intents;
    },
};
