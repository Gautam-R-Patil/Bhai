// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { buildIntent } from "./build-intent.js";

vi.mock("../../../memory/embeddings.js", () => ({
    embedText: vi.fn(async (_text: string) => new Array(384).fill(0.1)),
}));

describe("buildIntent", () => {
    it("returns a ProactiveIntent with 384-dim embedding", async () => {
        const intent = await buildIntent({
            source: "memory_anticipation",
            mode: "fyi",
            urgency: "normal",
            channelPreference: "telegram",
            payloadKind: "calendar_today_summary",
            topic: "morning calendar",
            evidence: [{ label: "events", value: "3" }],
            payload: { kind: "calendar_today_summary", events: [] },
        });
        expect(intent.id).toMatch(/^memory_anticipation_/);
        expect(intent.topicEmbedding).toHaveLength(384);
        expect(intent.payload.kind).toBe("calendar_today_summary");
        expect(intent.payloadKind).toBe("calendar_today_summary");
        expect(intent.expiresAt).toBeGreaterThan(intent.createdAt);
    });

    it("carries scheduledFor when provided", async () => {
        const fireAt = Date.now() + 60_000;
        const intent = await buildIntent({
            source: "memory_anticipation",
            mode: "fyi",
            urgency: "urgent",
            channelPreference: "telegram",
            payloadKind: "meeting_prep",
            topic: "prep evt123",
            evidence: [],
            payload: { kind: "meeting_prep", eventId: "evt123" },
            scheduledFor: fireAt,
        });
        expect(intent.scheduledFor).toBe(fireAt);
    });
});
