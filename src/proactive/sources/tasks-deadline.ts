// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import type { TaskEntry } from "../../../native/index.js";
import * as native from "../../../native/index.js";
import { fetchTasksToday } from "./_shared/tasks-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 300;

function getTzOffsetMin(): number {
    return -new Date().getTimezoneOffset();
}

export const TASKS_DEADLINE: IntentSourceModule = {
    name: "tasks_deadline",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("tasks_deadline", GATE_SEC);
        if (!gate.mayRun) return [];

        let tasks: TaskEntry[];
        try {
            tasks = await fetchTasksToday();
        } catch (err) {
            debugProactive("tasks_deadline_fetch_failed", { err: (err as Error).message });
            return [];
        }
        if (tasks.length === 0) return [];

        const result = native.tasksScore(tasks, ctx.now, getTzOffsetMin());
        const nudges = result.deadlineNudges;
        if (nudges.length === 0) return [];

        const intents: ProactiveIntent[] = [];
        for (const nudge of nudges) {
            const intent = await buildIntent({
                source: "tasks_deadline",
                mode: "question",
                urgency: "urgent",
                channelPreference: "any",
                payloadKind: "deadline_imminent",
                topic: `deadline ${nudge.taskId}`,
                scheduledFor: nudge.fireAtMs,
                expiresAtMs: nudge.dueMs + 30 * 60_000,
                evidence: [
                    { label: "task", value: nudge.title },
                    { label: "due", value: new Date(nudge.dueMs).toISOString() },
                ],
                payload: {
                    kind: "deadline_imminent",
                    taskId: nudge.taskId,
                    title: nudge.title,
                    dueMs: nudge.dueMs,
                },
            });
            intents.push(intent);
        }
        return intents;
    },
};
