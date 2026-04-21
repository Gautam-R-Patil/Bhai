// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { makeLatentTopicMonitorSource } from "./latent-topic-monitor.js";
import type { MonitorHitEvent } from "../monitors/monitor-hits.js";

function makeFakeBus() {
    const subs: Array<(e: MonitorHitEvent) => void> = [];
    return {
        emit: (e: MonitorHitEvent) => subs.forEach((f) => f(e)),
        subscribeToHits: (fn: (e: MonitorHitEvent) => void) => {
            subs.push(fn);
            return () => {
                const i = subs.indexOf(fn);
                if (i >= 0) subs.splice(i, 1);
            };
        },
    };
}

const hit = (
    ruleId: string,
    overrides: Partial<MonitorHitEvent> = {},
): MonitorHitEvent => ({
    ruleId,
    ruleUserPhrase: "ping me if anyone mentions Lambda",
    ruleTopic: "Lambda mentions",
    ruleUrgency: "normal",
    ruleActionDefaultMode: "fyi",
    ruleSuggestedFollowup: undefined,
    messageChannel: "telegram",
    messageSender: "12345",
    messagePreview: "hey, did you see the new Lambda release?",
    score: 0.91,
    ts: Date.now(),
    ...overrides,
});

describe("latent_topic_monitor source", () => {
    it("returns empty when no hits have fired", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        const out = await src.collectIntents({ now: Date.now() });
        expect(out).toEqual([]);
    });

    it("one hit → one intent with source='latent_topic_monitor'", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() }); // subscribe
        bus.emit(hit("r1"));
        const out = await src.collectIntents({ now: Date.now() });
        expect(out.length).toBe(1);
        expect(out[0].source).toBe("latent_topic_monitor");
    });

    it("intent copies mode + urgency from the rule's configured action", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() });
        bus.emit(hit("r1", { ruleUrgency: "urgent", ruleActionDefaultMode: "question" }));
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.urgency).toBe("urgent");
        expect(intent.mode).toBe("question");
    });

    it("payload includes ruleId, topic, matchedText, channel, sender", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() });
        bus.emit(hit("rule-abc", {
            ruleTopic: "AWS lambda updates",
            messagePreview: "lambda got a new runtime",
            messageChannel: "whatsapp",
            messageSender: "12345@s.whatsapp.net",
        }));
        const [intent] = await src.collectIntents({ now: Date.now() });
        const p = intent.payload as unknown as {
            kind: string;
            ruleId: string;
            topic: string;
            matchedText: string;
            channel: string;
            sender: string;
        };
        expect(p.kind).toBe("latent_topic_monitor");
        expect(p.ruleId).toBe("rule-abc");
        expect(p.topic).toBe("AWS lambda updates");
        expect(p.matchedText).toBe("lambda got a new runtime");
        expect(p.channel).toBe("whatsapp");
        expect(p.sender).toBe("12345@s.whatsapp.net");
    });

    it("multiple hits → multiple intents in emit order", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() });
        bus.emit(hit("a"));
        bus.emit(hit("b"));
        bus.emit(hit("c"));
        const out = await src.collectIntents({ now: Date.now() });
        expect(out.length).toBe(3);
        const ruleIds = out.map((i) => (i.payload as unknown as { ruleId: string }).ruleId);
        expect(ruleIds).toEqual(["a", "b", "c"]);
    });

    it("drain is destructive — second sweep with no emits returns empty", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() });
        bus.emit(hit("x"));
        const first = await src.collectIntents({ now: Date.now() });
        expect(first.length).toBe(1);
        const second = await src.collectIntents({ now: Date.now() });
        expect(second).toEqual([]);
    });

    it("embedding is 384-length zero vector (dedup disabled for monitor hits)", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() });
        bus.emit(hit("y"));
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.topicEmbedding.length).toBe(384);
        expect(intent.topicEmbedding.every((v) => v === 0)).toBe(true);
    });

    it("maps known channel → channelPreference; unknown → 'any'", async () => {
        const bus = makeFakeBus();
        const src = makeLatentTopicMonitorSource({ subscribeToHits: bus.subscribeToHits });
        await src.collectIntents({ now: Date.now() });
        bus.emit(hit("k1", { messageChannel: "telegram" }));
        bus.emit(hit("k2", { messageChannel: "mystery" }));
        const out = await src.collectIntents({ now: Date.now() });
        expect(out[0].channelPreference).toBe("telegram");
        expect(out[1].channelPreference).toBe("any");
    });
});
