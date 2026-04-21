// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { makeIntentId, type ProactiveIntent } from "./intent.js";

// Bridge from the legacy heartbeat thought string to the new ProactiveIntent
// shape. The embedding is a placeholder — Phase 2 will inject a real one from
// the embeddings module. For Phase 1 the Composer doesn't use the embedding
// (no dedup yet), so a zero vector is acceptable.
export function intentFromThought(
    rawThought: string,
    ctx: { hourNow: number },
): ProactiveIntent {
    const now = Date.now();
    return {
        id: makeIntentId("memory_anticipation"),
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "any",
        topic: rawThought.slice(0, 80),
        topicEmbedding: new Array(384).fill(0),
        evidence: [{ label: "hourNow", value: String(ctx.hourNow) }],
        payload: { kind: "memory_anticipation", hint: rawThought },
        createdAt: now,
        expiresAt: now + 60 * 60_000, // 1 hour lifetime
    };
}
