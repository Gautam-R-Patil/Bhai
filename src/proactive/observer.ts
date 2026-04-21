// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Observer — coordinates the proactive subsystem:
//   intent sources → enqueue → Rust scheduler → release on boundary →
//   Composer → dispatch → channel.
// Task 2.3. Phase 3 will register source adapters.

import type { LLMClient } from "../llm.js";
import { validateIntent, type ProactiveIntent, type Channel, type IntentSource } from "./intent.js";
import {
    loadProactiveConfig,
    getPosture,
    POSTURE_PARAMS,
    type ProactiveConfig,
    type Posture,
} from "./config.js";
import { compose } from "./composer.js";
import { dispatchProactiveMessage } from "./dispatch.js";
import { globalBoundaryBus, type BoundaryEvent } from "./boundary-events.js";
import {
    isProactiveDisabled,
    isSourceDisabled,
    isChannelDisabled,
    debugProactive,
} from "./kill-switches.js";
import * as native from "../../native/index.js";
import { SourceRegistry } from "./sources/registry.js";
import type { IntentSourceModule } from "./sources/source.js";

const SOURCE_WEIGHTS: Record<IntentSource, number> = {
    latent_topic_monitor: 1.5,
    calendar_fact_check: 1.3,
    meeting_followup: 1.2,
    calendar_fusion: 1.0,
    long_task_status: 1.0,
    habit_anomaly: 0.9,
    stale_todo: 0.9,
    convex_notification: 0.8,
    env_context: 0.8,
    memory_anticipation: 0.7,
};

const BOUNDARY_WINDOW_MS = 120_000;          // 2-minute window after a boundary
const SWEEP_INTERVAL_MS = 30_000;            // slow sweep for gap/rate-based releases
const RECENT_SENDS_PER_CHANNEL = 10;
const ALL_CHANNELS: Channel[] = [
    "whatsapp", "telegram", "discord", "slack", "matrix", "email", "overlay",
];

export type ObserverDeps = {
    llm: LLMClient | null;
    configPath: string;
};

export class Observer {
    private cfg: ProactiveConfig;
    private registry = new SourceRegistry();
    private intentsById = new Map<string, ProactiveIntent>();
    private recentSendsByChannel = new Map<Channel, string[]>();
    private unsubBoundary: (() => void) | null = null;
    private tickTimer: NodeJS.Timeout | null = null;

    constructor(private deps: ObserverDeps) {
        this.cfg = loadProactiveConfig(deps.configPath);
        this.configureAllPostures();
    }

    start(): void {
        this.unsubBoundary = globalBoundaryBus.subscribe((e) => this.onBoundary(e));
        this.tickTimer = setInterval(() => {
            this.tickAll().catch((err) =>
                debugProactive("observer_tick_err", { err: (err as Error).message })
            );
        }, SWEEP_INTERVAL_MS);
    }

    stop(): void {
        if (this.unsubBoundary) {
            this.unsubBoundary();
            this.unsubBoundary = null;
        }
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    registerSource(src: IntentSourceModule): void {
        this.registry.register(src);
    }

    enqueue(intent: ProactiveIntent): boolean {
        if (isProactiveDisabled()) {
            debugProactive("observer_enqueue_suppressed_global", { id: intent.id });
            return false;
        }
        if (isSourceDisabled(intent.source)) {
            debugProactive("observer_enqueue_source_disabled", { id: intent.id, source: intent.source });
            return false;
        }
        const v = validateIntent(intent);
        if (!v.ok) {
            debugProactive("observer_enqueue_invalid", { id: intent.id, error: v.error });
            return false;
        }

        const channel: Channel = intent.channelPreference === "any" ? "telegram" : intent.channelPreference;
        if (isChannelDisabled(channel)) {
            debugProactive("observer_enqueue_channel_disabled", { id: intent.id, channel });
            return false;
        }

        const posture = getPosture(this.cfg, channel);
        const postureWeight = this.postureWeightFor(posture, intent.source);
        const sourceWeight = SOURCE_WEIGHTS[intent.source] ?? 1.0;

        this.intentsById.set(intent.id, intent);

        const res = native.schedulerEnqueue({
            id: intent.id,
            source: intent.source,
            mode: intent.mode,
            urgency: intent.urgency,
            channel,
            topicEmbedding: intent.topicEmbedding.map((n) => Number(n)),
            createdAt: intent.createdAt,
            expiresAt: intent.expiresAt,
            postureWeight,
            sourceWeight,
        });
        debugProactive("observer_enqueued", { id: intent.id, channel, res });
        if (res !== "enqueued") {
            this.intentsById.delete(intent.id);
            return false;
        }
        return true;
    }

    onBoundary(e: BoundaryEvent): void {
        debugProactive("observer_boundary", { kind: e.kind, ts: e.ts });
        for (const ch of ALL_CHANNELS) {
            native.schedulerMarkBoundary(ch, BOUNDARY_WINDOW_MS);
        }
        this.tickAll().catch((err) =>
            debugProactive("observer_tick_err_boundary", { err: (err as Error).message })
        );
    }

    async tickAll(): Promise<void> {
        // 1. Collect new intents from all registered sources
        try {
            const intents = await this.registry.collectAll({ now: Date.now() });
            for (const intent of intents) {
                this.enqueue(intent);
            }
        } catch (err) {
            debugProactive("observer_collect_err", { err: (err as Error).message });
        }
        // 2. Release eligible intents per channel
        for (const ch of ALL_CHANNELS) {
            await this.releaseChannel(ch).catch((err) =>
                debugProactive("observer_release_err", { ch, err: (err as Error).message })
            );
        }
    }

    private async releaseChannel(channel: Channel): Promise<void> {
        const r = native.schedulerTryRelease(channel);
        if (!r) return;
        for (const d of r.dropped) {
            debugProactive("observer_dropped", { id: d.id, reason: d.reason });
            this.intentsById.delete(d.id);
        }
        for (const id of r.released) {
            const intent = this.intentsById.get(id);
            if (!intent) continue;
            const recent = this.recentSendsByChannel.get(channel) ?? [];
            try {
                const composed = await compose(intent, channel, { tone: "warm" }, recent, { llm: this.deps.llm });
                if (!composed) continue;
                await dispatchProactiveMessage(channel, composed.text, composed.modeTag);
                const updated = [composed.text, ...recent].slice(0, RECENT_SENDS_PER_CHANNEL);
                this.recentSendsByChannel.set(channel, updated);
            } catch (err) {
                debugProactive("observer_dispatch_failed", { id, channel, err: (err as Error).message });
            } finally {
                this.intentsById.delete(id);
            }
        }
    }

    private configureAllPostures(): void {
        for (const ch of ALL_CHANNELS) {
            const p = POSTURE_PARAMS[getPosture(this.cfg, ch)];
            native.schedulerConfigure({
                channel: ch,
                maxPerDay: p.maxPerDay,
                minGapMin: p.minGapMin,
                heartbeatMin: p.heartbeatMin,
                boundaryOnly: p.boundaryOnly,
                urgentBypass: p.urgentBypass,
            });
        }
    }

    private postureWeightFor(posture: Posture, source: IntentSource): number {
        if (posture === "ambient") {
            return source === "latent_topic_monitor" ? 1.0 : 0.3;
        }
        if (posture === "calm") return 0.7;
        return 1.0;
    }
}

let _observer: Observer | null = null;
export function getObserver(): Observer | null {
    return _observer;
}
export function setObserver(o: Observer | null): void {
    _observer = o;
}
