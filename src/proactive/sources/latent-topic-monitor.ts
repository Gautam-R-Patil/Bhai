// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// latent_topic_monitor — drains the MonitorHitBus on each Observer sweep and
// emits one ProactiveIntent per hit. The mode + urgency come from the user's
// configured rule; the Composer's LLM path (no template for this payload
// kind) frames the alert conversationally.

import { makeIntentId, type ProactiveIntent, type Channel } from "../intent.js";
import type { IntentSourceModule } from "./source.js";
import { globalMonitorHitBus, type MonitorHitEvent } from "../monitors/monitor-hits.js";

export type LatentTopicMonitorDeps = {
    subscribeToHits: (fn: (e: MonitorHitEvent) => void) => () => void;
};

const VALID_CHANNELS: ReadonlyArray<Channel> = [
    "whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay",
];

function toChannel(ch: string): Channel | "any" {
    return (VALID_CHANNELS as readonly string[]).includes(ch) ? (ch as Channel) : "any";
}

export function makeLatentTopicMonitorSource(
    deps: LatentTopicMonitorDeps = {
        subscribeToHits: (fn) => globalMonitorHitBus.subscribe(fn),
    },
): IntentSourceModule {
    const pending: MonitorHitEvent[] = [];
    let unsub: (() => void) | null = null;

    const ensureSubscribed = () => {
        if (unsub) return;
        unsub = deps.subscribeToHits((e) => {
            pending.push(e);
        });
    };

    return {
        name: "latent_topic_monitor",
        async collectIntents(ctx) {
            ensureSubscribed();
            if (pending.length === 0) return [];
            const drained = pending.splice(0, pending.length);
            return drained.map((hit) => {
                const intent: ProactiveIntent = {
                    id: makeIntentId("latent_topic_monitor"),
                    source: "latent_topic_monitor",
                    mode: hit.ruleActionDefaultMode,
                    urgency: hit.ruleUrgency,
                    channelPreference: toChannel(hit.messageChannel),
                    topic: hit.ruleTopic.slice(0, 80),
                    // Dedup disabled for monitor hits — each match is a fresh event
                    // the user explicitly asked for. A zero embedding is the conventional
                    // sentinel for "skip semantic dedup" (matches long_task_status).
                    topicEmbedding: new Array(384).fill(0),
                    evidence: [
                        { label: "rule", value: hit.ruleUserPhrase },
                        { label: "matchedIn", value: hit.messageChannel },
                        { label: "sender", value: hit.messageSender },
                        { label: "score", value: hit.score.toFixed(3) },
                    ],
                    payload: {
                        kind: "latent_topic_monitor",
                        ruleId: hit.ruleId,
                        topic: hit.ruleTopic,
                        matchedText: hit.messagePreview,
                        channel: hit.messageChannel,
                        sender: hit.messageSender,
                        suggestedFollowup: hit.ruleSuggestedFollowup,
                    },
                    createdAt: ctx.now,
                    expiresAt: ctx.now + 60 * 60_000,  // 1-hour lifetime
                };
                return intent;
            });
        },
    };
}
