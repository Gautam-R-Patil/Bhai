// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── WhatsApp per-JID TTL sweep ──────────────────────────────────
// Extracted from whatsapp.ts so the expiration logic can be unit
// tested with synthetic maps + a fake clock instead of booting the
// whole Baileys socket + agent stack.
//
// Three expiries apply independently:
//   1. messageCounts   — rate-limit windows older than rateLimitWindowMs
//                        are dropped (they can no longer affect enforcement).
//   2. ownerConversations — JIDs with lastConvoActivity older than
//                        ownerConvoTtlMs are dropped, together with
//                        their lastConvoActivity entry (the two maps
//                        are maintained as a pair).
//   3. activeTasks     — per-JID arrays where every task was started
//                        more than activeTaskAbandonedMs ago are
//                        treated as orphaned and dropped. If some
//                        tasks are fresh and others stale, the stale
//                        ones are filtered out in place.
//
// All expiries use strict `>` against (now - threshold) so a task
// started exactly at the threshold boundary is kept.

export interface WhatsAppSweepConfig {
    rateLimitWindowMs: number;
    ownerConvoTtlMs: number;
    activeTaskAbandonedMs: number;
}

/** Shape of a single active task — only startedAt is read by the sweep. */
export interface HasStartedAt {
    startedAt: number;
}

/**
 * In-place sweep of the three per-JID maps. Mutates the maps to drop
 * expired entries; returns void. The caller must hold the single
 * reference to each map (no snapshot needed).
 */
export function sweepStaleWhatsAppMaps<T extends HasStartedAt>(
    now: number,
    config: WhatsAppSweepConfig,
    messageCounts: Map<string, { count: number; windowStart: number }>,
    ownerConversations: Map<string, unknown>,
    lastConvoActivity: Map<string, number>,
    activeTasks: Map<string, T[]>,
): void {
    for (const [jid, entry] of messageCounts) {
        if (now - entry.windowStart > config.rateLimitWindowMs) {
            messageCounts.delete(jid);
        }
    }

    for (const [jid, lastActivity] of lastConvoActivity) {
        if (now - lastActivity > config.ownerConvoTtlMs) {
            ownerConversations.delete(jid);
            lastConvoActivity.delete(jid);
        }
    }

    for (const [jid, tasks] of activeTasks) {
        const stillAlive = tasks.filter((t) => now - t.startedAt < config.activeTaskAbandonedMs);
        if (stillAlive.length === 0) {
            activeTasks.delete(jid);
        } else if (stillAlive.length !== tasks.length) {
            activeTasks.set(jid, stillAlive);
        }
    }
}
