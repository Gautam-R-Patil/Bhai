// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { dbTimeMs, getMemoryDB } from "../../memory/sqlite.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 1800;
const HISTORY_DAYS = 14;
const RECENT_EVENT_DAYS = 1;

function labelTopic(content: string): string {
    const c = content.toLowerCase();
    if (c.includes("code") || c.includes("debug") || c.includes("build")) return "coding";
    if (c.includes("email") || c.includes("mail")) return "email";
    if (c.includes("research") || c.includes("search")) return "research";
    return "general";
}

export const HABIT_ANOMALY: IntentSourceModule = {
    name: "habit_anomaly",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("habit_anomaly", GATE_SEC);
        if (!gate.mayRun) return [];

        let habitEvents: native.TimestampedEvent[];
        let recentEvents: native.HabitEvent[];
        try {
            const db = getMemoryDB();
            const historyCutoff = new Date(ctx.now - HISTORY_DAYS * 86400_000).toISOString();
            const recentCutoff = new Date(ctx.now - RECENT_EVENT_DAYS * 86400_000).toISOString();

            const historyRows = db.exec(
                `SELECT content, created_at FROM conversation_messages WHERE role = 'user' AND datetime(created_at) > datetime(?) ORDER BY created_at LIMIT 500`,
                [historyCutoff]
            );
            habitEvents = (historyRows[0]?.values ?? []).map((r: unknown[]) => {
                const ts = new Date(dbTimeMs(r[1] as string));
                return {
                    timestampMs: ts.getTime(),
                    eventType: labelTopic(r[0] as string),
                    hourOfDay: ts.getHours() + ts.getMinutes() / 60,
                    dayOfWeek: ts.getDay(),
                };
            });

            const recentRows = db.exec(
                `SELECT content, created_at FROM conversation_messages WHERE role = 'user' AND datetime(created_at) > datetime(?) ORDER BY created_at LIMIT 100`,
                [recentCutoff]
            );
            recentEvents = (recentRows[0]?.values ?? []).map((r: unknown[]) => ({
                eventType: labelTopic(r[0] as string),
                tsMs: dbTimeMs(r[1] as string),
            }));
        } catch (err) {
            debugProactive("habit_anomaly_db_failed", { err: (err as Error).message });
            return [];
        }

        if (habitEvents.length < 10) return [];

        const habits = native.detectHabits(habitEvents, 3);
        if (habits.length === 0) return [];

        const anomalies = native.habitDetectAnomalies(habits, recentEvents, ctx.now);
        if (anomalies.length === 0) return [];

        const anomaly = anomalies[0];
        const intent = await buildIntent({
            source: "habit_anomaly",
            mode: "question",
            urgency: "normal",
            channelPreference: "any",
            payloadKind: "habit_anomaly",
            topic: `anomaly ${anomaly.eventType}`,
            evidence: [
                { label: "activity", value: anomaly.eventType },
                { label: "expected_hour", value: String(anomaly.expectedHour) },
                { label: "last_seen_days_ago", value: String(anomaly.lastSeenDaysAgo) },
            ],
            payload: {
                kind: "habit_anomaly",
                activity: anomaly.eventType,
                expectedHour: anomaly.expectedHour,
                lastSeenDaysAgo: anomaly.lastSeenDaysAgo,
                confidence: anomaly.confidence,
            },
        });
        return [intent];
    },
};
