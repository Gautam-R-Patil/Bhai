// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { makeIntentId, type ProactiveIntent } from "./intent.js";

// Adapts a raw heartbeat thought string into a ProactiveIntent so it can flow
// through the Observer / Composer pipeline. The embedding is a zero-vector
// placeholder; downstream consumers (Composer post-filter, dispatch) do not
// require a real embedding for heartbeat-sourced intents.
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
