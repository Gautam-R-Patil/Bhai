// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { makeIntentId, type ProactiveIntent } from "../intent.js";
import type { IntentSourceModule } from "./source.js";
import { globalLongTaskBus, type LongTaskCompletionEvent } from "../long-task-events.js";

export type LongTaskStatusDeps = {
    subscribeToCompletion: (fn: (e: LongTaskCompletionEvent) => void) => () => void;
};

// Default wiring uses the global bus. Tests inject their own.
export function makeLongTaskStatusSource(
    deps: LongTaskStatusDeps = {
        subscribeToCompletion: (fn) => globalLongTaskBus.subscribe(fn),
    },
): IntentSourceModule {
    const pending: LongTaskCompletionEvent[] = [];
    let unsub: (() => void) | null = null;

    const ensureSubscribed = () => {
        if (unsub) return;
        unsub = deps.subscribeToCompletion((e) => {
            pending.push(e);
        });
    };

    return {
        name: "long_task_status",
        async collectIntents(ctx) {
            ensureSubscribed();
            if (pending.length === 0) return [];
            const drained = pending.splice(0, pending.length);
            const now = ctx.now;
            return drained.map((e) => {
                const intent: ProactiveIntent = {
                    id: makeIntentId("long_task_status"),
                    source: "long_task_status",
                    mode: "fyi",
                    urgency: "normal",
                    channelPreference: "any",
                    topic: e.task.slice(0, 80),
                    topicEmbedding: new Array(384).fill(0),
                    evidence: [
                        { label: "taskId", value: e.taskId },
                        { label: "durationSec", value: String(e.durationSec) },
                    ],
                    payload: {
                        kind: "long_task_status",
                        task: e.task,
                        summary: e.summary,
                    },
                    createdAt: now,
                    expiresAt: now + 6 * 60 * 60_000,  // 6-hour lifetime; completion is durable
                };
                return intent;
            });
        },
    };
}
