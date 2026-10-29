// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getRawDb } from "../../memory/sqlite.js";
import { makeIntentId, type ProactiveIntent } from "../intent.js";
import type { IntentSourceModule } from "./source.js";

const LEAD_MS = 30 * 60_000; // nudge from half an hour before it's due
const GRACE_MS = 12 * 60 * 60_000; // one held by quiet hours can still go out the next morning

const RETRY_MS = 60 * 60_000; // each intent lives this long; one never sent is collected again after

// When each was last enqueued; fired_at (set once it reaches the owner) stops it for good, across restarts.
const queued = new Map<number, number>();

/** The owner's commitments (memory_store due_at), each nudged once near its due time. */
export const COMMITMENT_DUE: IntentSourceModule = {
    name: "commitment_due",
    async collectIntents(ctx) {
        const rows = (getRawDb()
            ?.prepare(
                `SELECT id, content, due_at FROM memories
                 WHERE category = 'commitment' AND fired_at IS NULL AND consolidated_into IS NULL
                   AND due_at <= ? AND due_at > ?`,
            )
            .all(new Date(ctx.now + LEAD_MS).toISOString(), new Date(ctx.now - GRACE_MS).toISOString()) ??
            []) as Array<{ id: number; content: string; due_at: string }>;
        return rows
            .filter((r) => ctx.now > (queued.get(r.id) ?? 0) + RETRY_MS)
            .map((r): ProactiveIntent => {
                queued.set(r.id, ctx.now);
                const dueMs = Date.parse(r.due_at);
                return {
                    id: makeIntentId("commitment_due"),
                    source: "commitment_due",
                    mode: "question",
                    urgency: "normal", // held by quiet hours and posture like any nudge
                    channelPreference: "any",
                    topic: r.content.slice(0, 80),
                    topicEmbedding: new Array(384).fill(0), // never dedup one commitment against another
                    evidence: [{ label: "due", value: r.due_at }],
                    payload: { kind: "commitment_due", memoryId: r.id, content: r.content, dueMs },
                    createdAt: ctx.now,
                    // Expired before the retry, so a held or dropped nudge never has a live twin.
                    expiresAt: Math.min(ctx.now + RETRY_MS, dueMs + GRACE_MS),
                };
            });
    },
    onDispatched(intent) {
        getRawDb()
            ?.prepare("UPDATE memories SET fired_at = datetime('now') WHERE id = ?")
            .run(Number(intent.payload.memoryId));
    },
};
