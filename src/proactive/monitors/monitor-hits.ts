// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// MonitorHitBus — pub/sub for latent-topic matcher hits. Matcher calls on the
// channel receive paths (telegram.ts / whatsapp.ts) emit into this bus; the
// latent_topic_monitor IntentSource subscribes and drains on each Observer
// sweep. Mirrors the pattern in long-task-events.ts.

export type MonitorHitEvent = {
    ruleId: string;
    ruleUserPhrase: string;
    ruleTopic: string;
    ruleUrgency: "urgent" | "normal" | "ambient";
    ruleActionDefaultMode: "fyi" | "question" | "review";
    ruleSuggestedFollowup?: string;
    messageChannel: string;  // where the match happened
    messageSender: string;   // which sender triggered it
    messagePreview: string;  // first ~200 chars
    score: number;
    ts: number;
};

export class MonitorHitBus {
    private subs: Array<(e: MonitorHitEvent) => void> = [];

    subscribe(fn: (e: MonitorHitEvent) => void): () => void {
        this.subs.push(fn);
        return () => {
            this.subs = this.subs.filter((x) => x !== fn);
        };
    }

    emit(e: MonitorHitEvent): void {
        for (const s of this.subs) {
            try {
                s(e);
            } catch {
                // subscriber errors isolated
            }
        }
    }
}

export const globalMonitorHitBus = new MonitorHitBus();
