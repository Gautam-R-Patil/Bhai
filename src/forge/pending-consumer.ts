// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { consumeNextPendingCandidate, isForgeReady, synthesizeTool } from "./orchestrator.js";
import { emitForgeEvent } from "./telemetry.js";
import type { SynthesisResult } from "./types.js";

export async function consumeOnePending(): Promise<SynthesisResult | null> {
    if (!isForgeReady()) return null;
    if (process.env.ATLAS_NO_FORGE_VERIFIER === "true") return null;

    const next = consumeNextPendingCandidate();
    if (!next) return null;

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
