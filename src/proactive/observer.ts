// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Observer — coordinates the proactive subsystem:
//   intent sources → enqueue → Rust scheduler → release on boundary →
//   Composer → dispatch → channel.
// Task 2.3. Phase 3 will register source adapters.

import { statSync } from "node:fs";
import type { LLMClient } from "../llm.js";
import { validateIntent, type ProactiveIntent, type Channel, type IntentSource } from "./intent.js";
import {
    inWindow,
    loadProactiveConfig,
    getPosture,
    POSTURE_PARAMS,
    type ProactiveConfig,
    type Posture,
} from "./config.js";
import { compose, composeMorningBatch } from "./composer.js";
import { dispatchProactiveMessage } from "./dispatch.js";
import { globalBoundaryBus, type BoundaryEvent } from "./boundary-events.js";
import {
    isProactiveDisabled,
    isSourceDisabled,
    isChannelDisabled,
    debugProactive,
} from "./kill-switches.js";
import * as native from "../../native/index.js";
import { getToneReminder } from "../setup/personality-sync.js";
import { getChannelSender } from "../tools/channel-send.js";
import { SourceRegistry } from "./sources/registry.js";
import type { IntentSourceModule } from "./sources/source.js";
import { getInboxManager } from "./inbox/manager.js";
import { getTelemetry, type ProactiveOutcome } from "./telemetry.js";

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
    // V3
    calendar_prep: 1.4,
    tasks_deadline: 1.3,
    calendar_morning: 1.1,
    tasks_morning: 1.0,
    stale_email: 0.9,
    deep_work_gap: 0.8,
    goals_morning: 0.7,
    weather_morning: 0.6,
    news_morning: 0.5,
    // W3: onboarding graduation nudges — ambient priority, intentionally low.
    // They're soft, time-gated, and never urgent; the dispatcher should
    // hold them when anything else competes for the same channel slot.
    onboarding_graduation: 0.4,
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

const FALLBACK_CHANNELS: Channel[] = ["overlay", "telegram", "whatsapp", "discord", "slack", "matrix"];

/**
 * Where an intent can actually be delivered: its own channel when that has a
 * sender, else the user's Primary channel (Settings), else the first channel
 * that has one. Sources default to Telegram, which desktop-only users don't
 * have — every proactive message used to be dropped as dispatch_failed.
 */
export function resolveChannel(pref: Channel | "any"): Channel {
    if (pref !== "any" && getChannelSender(pref)) return pref;
    for (const c of [process.env.PRIMARY_CHANNEL as Channel | undefined, ...FALLBACK_CHANNELS]) {
        if (c && getChannelSender(c)) return c;
    }
    return pref === "any" ? "telegram" : pref;
}

export class Observer {
    private cfg: ProactiveConfig;
    private registry = new SourceRegistry();
    private intentsById = new Map<string, ProactiveIntent>();
    private recentSendsByChannel = new Map<Channel, string[]>();
    private unsubBoundary: (() => void) | null = null;
    private tickTimer: NodeJS.Timeout | null = null;
    private tuneTimer: NodeJS.Timeout | null = null;
    /** Phase 5.3: per-source weights tuned hourly from telemetry rejection rates. */
    private dynamicWeights: Record<string, number> = { ...SOURCE_WEIGHTS };

    private cfgMtime = 0;
    /**
     * Scheduled intents already queued, by source+topic+fire time → when they expire. Sources
     * re-emit the same future alert on every poll (calendar prep every 5 min, with a fresh id),
     * and the scheduler queued each copy: a 15:00 meeting seen from 09:00 fired ~69 times at 14:45.
     */
    private scheduledKeys = new Map<string, number>();

    constructor(private deps: ObserverDeps) {
        this.cfg = loadProactiveConfig(deps.configPath);
        // An earlier "shut up" still holds after a restart (the observer starts at boot).
        if (this.cfg.quiet) process.env.ATLAS_PROACTIVE_DISABLE = "true";
        this.configureAllPostures();
        this.cfgMtime = this.configMtime();
    }

    private configMtime(): number {
        try {
            return statSync(this.deps.configPath).mtimeMs;
        } catch {
            return 0;
        }
    }

    /**
     * Re-read proactive-config.json when it changed. It was read once at boot, so "set whatsapp
     * to ambient" (or a hand edit) answered "Got it" but changed nothing until a restart.
     * Re-configuring keeps the scheduler's counters; only the posture limits change.
     */
    reloadConfigIfChanged(): void {
        const m = this.configMtime();
        if (m === this.cfgMtime) return;
        this.cfgMtime = m;
        this.cfg = loadProactiveConfig(this.deps.configPath);
        this.configureAllPostures();
        debugProactive("config_reloaded", {});
    }

    start(): void {
        this.unsubBoundary = globalBoundaryBus.subscribe((e) => this.onBoundary(e));
        this.tickTimer = setInterval(() => {
            this.tickAll().catch((err) =>
                debugProactive("observer_tick_err", { err: (err as Error).message })
            );
        }, SWEEP_INTERVAL_MS);
        this.tickTimer.unref?.();
        this.tuneTimer = setInterval(() => this.tuneSourceWeights(), 60 * 60_000);
        this.tuneTimer.unref?.();
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
        if (this.tuneTimer) {
            clearInterval(this.tuneTimer);
            this.tuneTimer = null;
        }
    }

    registerSource(src: IntentSourceModule): void {
        this.registry.register(src);
    }

    enqueue(intent: ProactiveIntent): boolean {
        // Pre-channel-known best-effort channel tag for early rejection telemetry.
        const prechan: string = intent.channelPreference === "any" ? "any" : intent.channelPreference;

        if (isProactiveDisabled()) {
            debugProactive("observer_enqueue_suppressed_global", { id: intent.id });
            this.telemetry().log({
                intentId: intent.id,
                source: intent.source,
                channel: prechan,
                decision: "dropped",
                dropReason: "disabled_global",
            });
            return false;
        }
        if (isSourceDisabled(intent.source)) {
            debugProactive("observer_enqueue_source_disabled", { id: intent.id, source: intent.source });
            this.telemetry().log({
                intentId: intent.id,
                source: intent.source,
                channel: prechan,
                decision: "dropped",
                dropReason: "source_disabled",
            });
            return false;
        }
        const scheduledKey =
            intent.scheduledFor !== undefined ? `${intent.source}|${intent.topic}|${intent.scheduledFor}` : null;
        if (scheduledKey) {
            const now = Date.now();
            for (const [k, exp] of this.scheduledKeys) if (exp <= now) this.scheduledKeys.delete(k);
            if (this.scheduledKeys.has(scheduledKey)) {
                debugProactive("observer_enqueue_duplicate_scheduled", { id: intent.id, topic: intent.topic });
                return false;
            }
        }
        const v = validateIntent(intent);
        if (!v.ok) {
            debugProactive("observer_enqueue_invalid", { id: intent.id, error: v.error });
            this.telemetry().log({
                intentId: intent.id,
                source: intent.source,
                channel: prechan,
                decision: "dropped",
                dropReason: "invalid",
            });
            return false;
        }

        const channel = resolveChannel(intent.channelPreference);
        if (isChannelDisabled(channel)) {
            debugProactive("observer_enqueue_channel_disabled", { id: intent.id, channel });
            this.telemetry().log({
                intentId: intent.id,
                source: intent.source,
                channel,
                decision: "dropped",
                dropReason: "channel_disabled",
            });
            return false;
        }

        const posture = getPosture(this.cfg, channel);
        const postureWeight = this.postureWeightFor(posture, intent.source);
        const sourceWeight = this.dynamicWeights[intent.source]
            ?? SOURCE_WEIGHTS[intent.source]
            ?? 1.0;

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
            scheduledFor: intent.scheduledFor ?? 0,
            payloadKind: intent.payloadKind ?? (intent.payload?.kind as string) ?? "",
        });
        debugProactive("observer_enqueued", { id: intent.id, channel, res });
        if (res !== "enqueued" && res !== "scheduled") {
            this.intentsById.delete(intent.id);
            this.telemetry().log({
                intentId: intent.id,
                source: intent.source,
                channel,
                decision: "dropped",
                dropReason: String(res),  // "dedup" | "no_posture_configured" | etc.
            });
            return false;
        }
        this.telemetry().log({
            intentId: intent.id,
            source: intent.source,
            channel,
            decision: res === "scheduled" ? "scheduled" : "enqueued",
            ...(res === "scheduled" && intent.scheduledFor ? { scheduledFor: intent.scheduledFor } : {}),
        });
        if (scheduledKey) this.scheduledKeys.set(scheduledKey, intent.expiresAt);
        return true;
    }

    /** Lazy telemetry fetch — returns a no-op logger when telemetry isn't initialized. */
    private telemetry(): { log: (o: ProactiveOutcome) => void } {
        const tl = getTelemetry();
        return tl ?? { log: () => {} };
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
        this.reloadConfigIfChanged();
        // 0. Drain wall-clock scheduled intents (V3)
        for (const ch of ALL_CHANNELS) {
            try {
                const promoted = native.schedulerDrainScheduled(ch);
                if (promoted.length > 0) {
                    debugProactive("observer_drained_scheduled", { ch, count: promoted.length });
                }
            } catch (err) {
                debugProactive("observer_drain_err", { ch, err: (err as Error).message });
            }
        }

        // 1. Collect new intents from all registered sources
        try {
            const intents = await this.registry.collectAll({ now: Date.now() });
            for (const intent of intents) {
                this.enqueue(intent);
            }
        } catch (err) {
            debugProactive("observer_collect_err", { err: (err as Error).message });
        }
        // 2. Quiet hours: the scheduler holds normal/ambient intents while DND is
        //    on and still lets urgent ones through. nightWindows was never read.
        const night = this.cfg.nightWindows?.default; // a hand-edited config may lack it
        const quiet = night ? inWindow(night) : false;
        for (const ch of ALL_CHANNELS) {
            try {
                native.schedulerSetDnd(ch, quiet);
            } catch {
                /* native scheduler unavailable */
            }
        }

        // 3. Release eligible intents per channel
        for (const ch of ALL_CHANNELS) {
            await this.releaseChannel(ch).catch((err) =>
                debugProactive("observer_release_err", { ch, err: (err as Error).message })
            );
        }
    }

    private async releaseChannel(channel: Channel): Promise<void> {
        const r = native.schedulerReleaseGrouped(channel);
        if (!r) return;

        for (const d of r.dropped) {
            debugProactive("observer_dropped", { id: d.id, reason: d.reason });
            const droppedIntent = this.intentsById.get(d.id);
            this.telemetry().log({
                intentId: d.id,
                source: droppedIntent?.source ?? "unknown",
                channel,
                decision: "dropped",
                dropReason: d.reason,
            });
            this.intentsById.delete(d.id);
        }

        const morningBatchIds: string[] = r.morningBatch ?? [];
        const singleIds: string[] = r.singles ?? [];

        const recent = this.recentSendsByChannel.get(channel) ?? [];

        if (morningBatchIds.length >= 2) {
            const intents: ProactiveIntent[] = [];
            for (const id of morningBatchIds) {
                const intent = this.intentsById.get(id);
                if (intent) intents.push(intent);
            }
            if (intents.length > 0) {
                try {
                    const composed = await composeMorningBatch(intents, channel, recent, { llm: this.deps.llm });
                    if (composed) {
                        await dispatchProactiveMessage(channel, composed.text, composed.modeTag);
                        this.telemetry().log({
                            intentId: intents[0].id,
                            source: intents[0].source,
                            channel,
                            decision: "dispatched",
                            dispatchedAt: Date.now(),
                            batchIds: intents.map((i) => i.id),
                        });
                        const updated = [composed.text, ...recent].slice(0, RECENT_SENDS_PER_CHANNEL);
                        this.recentSendsByChannel.set(channel, updated);
                    } else {
                        for (const intent of intents) {
                            this.telemetry().log({
                                intentId: intent.id,
                                source: intent.source,
                                channel,
                                decision: "dropped",
                                dropReason: "compose_failed",
                            });
                        }
                    }
                } catch (err) {
                    debugProactive("observer_morning_batch_failed", { channel, err: (err as Error).message });
                } finally {
                    for (const intent of intents) this.intentsById.delete(intent.id);
                }
            }
        }

        // Singles — compose + dispatch individually (V2 per-intent logic preserved)
        for (const id of singleIds) {
            const intent = this.intentsById.get(id);
            if (!intent) continue;
            this.telemetry().log({
                intentId: intent.id,
                source: intent.source,
                channel,
                decision: "released",
            });
            const intentRecent = this.recentSendsByChannel.get(channel) ?? [];
            try {
                const composed = await compose(intent, channel, { tone: getToneReminder() ?? "warm" }, intentRecent, {
                    llm: this.deps.llm,
                });
                if (!composed) {
                    this.telemetry().log({
                        intentId: intent.id,
                        source: intent.source,
                        channel,
                        decision: "dropped",
                        dropReason: "compose_failed",
                    });
                    continue;
                }

                // Phase 4 (Task 4.2): review-mode intents go to the inbox surface,
                // NOT to the chat channel — they require user approval first.
                if (intent.mode === "review") {
                    const inbox = getInboxManager();
                    if (inbox) {
                        inbox.enqueue(intent, composed.text);
                        debugProactive("observer_routed_to_inbox", { id: intent.id });
                        // Inbox-routed dispatch: log under "overlay" as the
                        // effective channel where the user sees the prompt.
                        this.telemetry().log({
                            intentId: intent.id,
                            source: intent.source,
                            channel: "overlay",
                            decision: "dispatched",
                            dispatchedAt: Date.now(),
                        });
                        // Intent ownership transferred to the inbox; skip dispatch and
                        // do NOT update recentSends (no chat message was sent).
                        continue;
                    }
                    // Fallback: no inbox manager registered — fall through to the
                    // existing dispatch path so the intent isn't silently dropped.
                    debugProactive("observer_inbox_absent_fallback", { id: intent.id });
                }

                await dispatchProactiveMessage(channel, composed.text, composed.modeTag);
                this.telemetry().log({
                    intentId: intent.id,
                    source: intent.source,
                    channel,
                    decision: "dispatched",
                    dispatchedAt: Date.now(),
                });
                const updated = [composed.text, ...(this.recentSendsByChannel.get(channel) ?? [])].slice(0, RECENT_SENDS_PER_CHANNEL);
                this.recentSendsByChannel.set(channel, updated);
            } catch (err) {
                debugProactive("observer_dispatch_failed", { id, channel, err: (err as Error).message });
                this.telemetry().log({
                    intentId: intent.id,
                    source: intent.source,
                    channel,
                    decision: "dropped",
                    dropReason: "dispatch_failed",
                });
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

    /**
     * Phase 5.3: recompute dynamicWeights based on recent rejection rates.
     * Runs hourly from start(). For each source, we average rejectionRate
     * across all configured channels that have any signal and apply
     *   adjusted = base × (1 − avg_rejection)
     * clamped to [0.2, 2.0]. Sources with no signal fall back to their base.
     * Missing telemetry is treated as "no signal" — every source resets to base.
     */
    tuneSourceWeights(): void {
        const tl = getTelemetry();
        const since = Date.now() - 7 * 86_400_000;  // 7-day window
        const channels = Object.keys(this.cfg.postures) as Channel[];

        for (const source of Object.keys(SOURCE_WEIGHTS) as IntentSource[]) {
            const rates = tl
                ? channels
                    .map((ch) => tl.rejectionRate(source, ch, since))
                    .filter((r) => r > 0)
                : [];
            if (rates.length === 0) {
                // No signal — reset to base weight
                this.dynamicWeights[source] = SOURCE_WEIGHTS[source];
                continue;
            }
            const avgRejection = rates.reduce((a, b) => a + b, 0) / rates.length;
            const base = SOURCE_WEIGHTS[source];
            const adjusted = base * (1 - avgRejection);
            const clamped = Math.max(0.2, Math.min(2.0, adjusted));
            this.dynamicWeights[source] = clamped;
            debugProactive("observer_tune", {
                source,
                base,
                rejection: avgRejection.toFixed(3),
                weight: clamped.toFixed(3),
            });
        }
    }

    /** Test-only: read a dynamic weight. */
    _getDynamicWeight(source: string): number {
        return this.dynamicWeights[source]
            ?? SOURCE_WEIGHTS[source as IntentSource]
            ?? 1.0;
    }

    /** Test-only: set a dynamic weight (bypasses normal tune flow). */
    _setDynamicWeightForTest(source: string, weight: number): void {
        this.dynamicWeights[source] = weight;
    }
}

let _observer: Observer | null = null;
export function getObserver(): Observer | null {
    return _observer;
}
export function setObserver(o: Observer | null): void {
    _observer = o;
}
