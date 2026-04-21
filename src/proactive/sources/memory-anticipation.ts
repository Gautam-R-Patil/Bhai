// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { makeIntentId, type ProactiveIntent } from "../intent.js";
import type { UserPresence } from "../activity.js";
import type { IntentSourceModule } from "./source.js";

type TickArgs = {
    presence: UserPresence;
    monitorAlerts: string | null;
    hourNow: number;
    lastAppTransition?: { from: string; to: string } | null;
};

export type MemoryAnticipationDeps = {
    tick: (ctx: TickArgs) => Promise<string | null>;
    embedText: (text: string) => Promise<Float32Array | number[]>;
    getPresence: () => Promise<UserPresence>;
};

export function makeMemoryAnticipationSource(
    deps: MemoryAnticipationDeps,
): IntentSourceModule {
    return {
        name: "memory_anticipation",
        async collectIntents(ctx) {
            const presence = await deps.getPresence();
            const thought = await deps.tick({
                presence,
                monitorAlerts: null,
                hourNow: new Date().getHours(),
            });
            if (!thought) return [];

            const rawEmb = await deps.embedText(thought);
            const embedding: number[] = Array.isArray(rawEmb) ? rawEmb : Array.from(rawEmb);

            const now = ctx.now;
            const intent: ProactiveIntent = {
                id: makeIntentId("memory_anticipation"),
                source: "memory_anticipation",
                mode: "fyi",
                urgency: "ambient",
                channelPreference: "any",
                topic: thought.slice(0, 80),
                topicEmbedding: embedding,
                evidence: [{ label: "trigger", value: "inner_thoughts_tick" }],
                payload: { kind: "memory_anticipation", hint: thought },
                createdAt: now,
                expiresAt: now + 60 * 60_000,
            };
            return [intent];
        },
    };
}
