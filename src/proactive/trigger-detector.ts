// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Trigger Detector ─────────────────────────────
 * Aggregates activation signals from multiple sources to determine
 * when the Inner Thoughts Engine should form a new thought.
 *
 * Signal sources: monitors, activity changes, memory events,
 * time-based triggers, emotional shifts, prospective memory fires.
 *
 * Replaces the ad-hoc `checkCount % 6 === 0` gating in heartbeat.ts.
 */

import type { UserPresence } from "./activity.js";
import { trackAction, getRecommendations } from "./recommendations.js";
import * as nativeModule from "../../native/index.js";

// ── Types ─────────────────────────────────────

export interface TriggerSignal {
    source: string;        // "monitor" | "activity" | "memory" | "time" | "emotional" | "prospective" | "recommendation"
    signalType: string;    // Specific identifier within source
    weight: number;        // 0-1
    timestampMs: number;
    metadata: string;      // JSON extra context
}

export interface ActivationResult {
    shouldActivate: boolean;
    primaryTrigger: string;
    combinedWeight: number;
    signals: TriggerSignal[];
}

// ── State ─────────────────────────────────────

const lastActivationTimes = new Map<string, number>();
const recentSignals: TriggerSignal[] = [];
const MAX_SIGNAL_HISTORY = 100;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per source type

// ── Signal Collection ─────────────────────────

/**
 * Collect signals from the current heartbeat tick.
 * Called once per heartbeat with all available context.
 */
export function collectSignals(context: {
    presence: UserPresence;
    monitorAlerts: string | null;
    hourNow: number;
    recentEmotionalShift?: boolean;
    prospectiveTriggersFired?: string[];
    memoryEventsCount?: number;
    lastAppTransition?: { from: string; to: string } | null;
}): TriggerSignal[] {
    const now = Date.now();
    const signals: TriggerSignal[] = [];

    // ── Monitor alerts ──
    if (context.monitorAlerts) {
        signals.push({
            source: "monitor",
            signalType: "alert_fired",
            weight: 0.7,
            timestampMs: now,
            metadata: JSON.stringify({ alert: context.monitorAlerts.substring(0, 200) }),
        });
    }

    // ── Activity changes ──
    if (context.lastAppTransition) {
        const { from, to } = context.lastAppTransition;
        // Significant app transitions (e.g., switching to browser, leaving code editor)
        const significantApps = ["Safari", "Chrome", "Firefox", "Slack", "Discord", "Mail", "Messages"];
        const isSignificant = significantApps.some(app => to.includes(app) || from.includes(app));

        if (isSignificant) {
            signals.push({
                source: "activity",
                signalType: "app_transition",
                weight: 0.3,
                timestampMs: now,
                metadata: JSON.stringify({ from, to }),
            });
        }
    }

    // ── Activity state ──
    if (context.presence.isActive && !context.presence.isJustServerProcesses) {
        // User is genuinely active — a good time for proactive thoughts
        signals.push({
            source: "activity",
            signalType: "user_active",
            weight: 0.2,
            timestampMs: now,
            metadata: JSON.stringify({
                idle: context.presence.idleMinutes,
                app: context.presence.frontmostApp,
            }),
        });
    }

    // ── Time-based triggers ──
    // Key times: start of work day, lunch break, end of day
    const keyHours = [9, 13, 18, 22]; // IST hours that often trigger natural check-ins
    if (keyHours.includes(context.hourNow)) {
        signals.push({
            source: "time",
            signalType: "key_hour",
            weight: 0.4,
            timestampMs: now,
            metadata: JSON.stringify({ hour: context.hourNow }),
        });
    }

    // ── Emotional shift ──
    if (context.recentEmotionalShift) {
        signals.push({
            source: "emotional",
            signalType: "emotional_shift",
            weight: 0.5,
            timestampMs: now,
            metadata: "{}",
        });
    }

    // ── Prospective memory triggers ──
    if (context.prospectiveTriggersFired && context.prospectiveTriggersFired.length > 0) {
        signals.push({
            source: "prospective",
            signalType: "reminder_fired",
            weight: 0.8,
            timestampMs: now,
            metadata: JSON.stringify({ triggers: context.prospectiveTriggersFired }),
        });
    }

    // ── Memory events ──
    if (context.memoryEventsCount && context.memoryEventsCount > 3) {
        signals.push({
            source: "memory",
            signalType: "significant_activity",
            weight: 0.3,
            timestampMs: now,
            metadata: JSON.stringify({ events: context.memoryEventsCount }),
        });
    }

    // ── Recommendation signals ──
    const recs = getRecommendations();
    if (recs.length > 0 && recs[0].confidence > 0.5) {
        signals.push({
            source: "recommendation",
            signalType: "pattern_detected",
            weight: recs[0].confidence * 0.4,
            timestampMs: now,
            metadata: JSON.stringify({ recommendation: recs[0].text.substring(0, 200) }),
        });
    }

    // Store in history
    for (const signal of signals) {
        recentSignals.push(signal);
    }
    while (recentSignals.length > MAX_SIGNAL_HISTORY) {
        recentSignals.shift();
    }

    return signals;
}

// ── Activation Decision ───────────────────────

/**
 * Determine whether to activate the thought engine based on collected signals.
 * Uses the native Rust aggregate_triggers when available, falls back to JS.
 */
export function shouldActivate(signals: TriggerSignal[]): ActivationResult {
    if (signals.length === 0) {
        return { shouldActivate: false, primaryTrigger: "none", combinedWeight: 0, signals: [] };
    }

    // Try native module first
    try {
        const native = loadNative();
        if (native) {
            const nativeSignals = signals.map(s => ({
                source: s.source,
                signalType: s.signalType, // napi fields are camelCase
                weight: s.weight,
                timestampMs: s.timestampMs,
                metadata: s.metadata,
            }));

            const sources = [...lastActivationTimes.keys()];
            const times = sources.map(s => lastActivationTimes.get(s) || 0);

            const events = native.aggregateTriggers(nativeSignals, times, sources, 0.3);

            if (events.length > 0 && events[0].shouldActivate) {
                const primary = events[0];
                lastActivationTimes.set(primary.primaryTrigger, Date.now());
                return {
                    shouldActivate: true,
                    primaryTrigger: primary.primaryTrigger,
                    combinedWeight: primary.combinedWeight,
                    signals,
                };
            }

            return { shouldActivate: false, primaryTrigger: "none", combinedWeight: 0, signals };
        }
    } catch { /* native not available */ }

    // JS fallback: simple threshold check with cooldown
    const now = Date.now();
    let totalWeight = 0;
    let primaryTrigger = "none";
    let maxWeight = 0;

    for (const signal of signals) {
        const lastTime = lastActivationTimes.get(signal.source) || 0;
        if (now - lastTime < COOLDOWN_MS) continue; // Still in cooldown

        totalWeight += signal.weight;
        if (signal.weight > maxWeight) {
            maxWeight = signal.weight;
            primaryTrigger = signal.source;
        }
    }

    const combinedWeight = Math.min(totalWeight, 1);
    const shouldAct = combinedWeight >= 0.3;

    if (shouldAct) {
        lastActivationTimes.set(primaryTrigger, now);
    }

    return { shouldActivate: shouldAct, primaryTrigger, combinedWeight, signals };
}

// ── Native Module ─────────────────────────────


function loadNative(): any {
    // A static import: `require` doesn't exist in ESM (nor in the esbuild bundle),
    // so the old createRequire path always returned null and the native scorers
    // never ran.
    return nativeModule;
}
