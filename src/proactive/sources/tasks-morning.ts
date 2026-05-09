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

const GATE_SEC = 900;

function getTzOffsetMin(): number {
    return -new Date().getTimezoneOffset();
}

export const TASKS_MORNING: IntentSourceModule = {
    name: "tasks_morning",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("tasks_morning", GATE_SEC);
        if (!gate.mayRun) return [];

        let tasks: TaskEntry[];
        try {
            tasks = await fetchTasksToday();
        } catch (err) {
            debugProactive("tasks_morning_fetch_failed", { err: (err as Error).message });
            return [];
        }
        if (tasks.length === 0) return [];

        const result = native.tasksScore(tasks, ctx.now, getTzOffsetMin());
        const { urgentToday, normalToday, overdue } = result;

        if (urgentToday.length + normalToday.length + overdue.length === 0) return [];

        const byId = new Map<string, TaskEntry>(tasks.map(t => [t.id, t]));
        const urgent = urgentToday.map(id => byId.get(id)).filter(Boolean) as TaskEntry[];
        const normal = normalToday.map(id => byId.get(id)).filter(Boolean) as TaskEntry[];
        const overdueItems = overdue.map(id => byId.get(id)).filter(Boolean) as TaskEntry[];

        const dateStr = new Date(ctx.now).toISOString().slice(0, 10);
        const intent = await buildIntent({
            source: "tasks_morning",
            mode: "fyi",
            urgency: "normal",
            channelPreference: "any",
            payloadKind: "tasks_today",
            topic: `morning tasks ${dateStr}`,
            evidence: [
                { label: "urgent", value: String(urgent.length) },
                { label: "normal", value: String(normal.length) },
                { label: "overdue", value: String(overdueItems.length) },
            ],
            payload: {
                kind: "tasks_today",
                urgent,
                normal,
                overdue: overdueItems,
            },
        });
        return [intent];
    },
};
