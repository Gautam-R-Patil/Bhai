// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { consumeNextPendingCandidate, isForgeReady, synthesizeTool } from "./orchestrator.js";
import { emitForgeEvent } from "./telemetry.js";
import type { SynthesisResult } from "./types.js";

// F6: absolute rate cap. Synthesis is expensive AND attack-surface; cap at
// one consumed candidate per 60s window across the whole process. Tests that
// need to exercise the underlying queue go through consumeNextPendingCandidate
// directly; only this user-facing wrapper enforces the cap.
const CONSUME_RATE_MS = 60_000;
let _lastConsumedAt = 0;

export function _resetConsumeRateLimitForTests(): void {
    _lastConsumedAt = 0;
}

export async function consumeOnePending(): Promise<SynthesisResult | null> {
    if (!isForgeReady()) return null;
    if (process.env.BHAI_NO_FORGE_VERIFIER === "true") return null;

    const now = Date.now();
    if (now - _lastConsumedAt < CONSUME_RATE_MS) return null;

    const next = consumeNextPendingCandidate();
    if (!next) return null;
    _lastConsumedAt = now;

    emitForgeEvent({
        event: "synthesis_started",
        ts: Date.now(),
        slug: next.name,
        source: next.source,
        track: "A",
    });

    try {
        const result = await synthesizeTool(next);
        if (result.kind === "synthesized") {
            emitForgeEvent({
                event: "synthesis_completed",
                ts: Date.now(),
                slug: result.slug,
                attempts: result.attempts,
                durationMs: 0,
            });
        } else if (result.kind === "failed") {
            emitForgeEvent({
                event: "synthesis_failed",
                ts: Date.now(),
                slug: next.name,
                attempts: result.report.attempts,
                reason: result.report.failureReason,
            });
        }
        return result;
    } catch (err) {
        emitForgeEvent({
            event: "synthesis_failed",
            ts: Date.now(),
            slug: next.name,
            attempts: 0,
            reason: (err as Error).message,
        });
        return null;
    }
}

let _hookFn: (() => void) | null = null;

export function setPendingHook(fn: () => void): void {
    _hookFn = fn;
}

export function triggerPendingHook(): void {
    if (_hookFn) {
        try {
            _hookFn();
        } catch {
            /* ignore */
        }
    }
}
