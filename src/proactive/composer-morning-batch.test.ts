// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { composeMorningBatch } from "./composer.js";
import type { ProactiveIntent } from "./intent.js";
import type { LLMClient } from "../llm.js";

function mk(kind: string, topic: string, payload: Record<string, unknown>): ProactiveIntent {
    const now = Date.now();
    return {
        id: `m-${kind}`,
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "telegram",
        topic,
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind, ...payload },
        payloadKind: kind,
        createdAt: now,
        expiresAt: now + 3600_000,
    };
}

describe("composeMorningBatch", () => {
    it("produces a single message weaving multiple signals", async () => {
        const mockLlm: LLMClient = {
            chat: vi.fn(async () => ({
                choices: [{ message: { content: "morning — 3 on calendar, 2 tasks urgent, rain at 4pm." } }],
            })),
        } as unknown as LLMClient;

        const intents = [
            mk("calendar_today_summary", "morning calendar", { events: [], conflicts: [] }),
            mk("tasks_today", "tasks today", { urgent: [{ title: "ship PR" }], normal: [], overdue: [] }),
            mk("weather_today", "weather", { summary: "light rain", temp_c: 24, rain_prob: 0.4 }),
        ];

        const result = await composeMorningBatch(intents, "telegram", [], { llm: mockLlm });
        expect(result).not.toBeNull();
        expect(result!.text).toContain("calendar");
        expect(result!.modeTag).toBe("fyi");
        expect(mockLlm.chat).toHaveBeenCalledTimes(1);
    });

    it("returns null when no intents", async () => {
        const mockLlm = { chat: vi.fn() } as unknown as LLMClient;
        const result = await composeMorningBatch([], "telegram", [], { llm: mockLlm });
        expect(result).toBeNull();
    });

    it("returns null when llm is null", async () => {
        const intents = [mk("calendar_today_summary", "cal", {})];
        const result = await composeMorningBatch(intents, "telegram", [], { llm: null });
        expect(result).toBeNull();
    });

    it("rejects output with banned phrases", async () => {
        const mockLlm: LLMClient = {
            chat: vi.fn(async () => ({
                choices: [{ message: { content: "might be worth looking at your calendar today" } }],
            })),
        } as unknown as LLMClient;
        const intents = [mk("calendar_today_summary", "cal", {})];
        const result = await composeMorningBatch(intents, "telegram", [], { llm: mockLlm });
        expect(result).toBeNull();
    });

    it("rejects third-person output", async () => {
        const mockLlm: LLMClient = {
            chat: vi.fn(async () => ({
                choices: [{ message: { content: "the user has 3 meetings today" } }],
            })),
        } as unknown as LLMClient;
        const intents = [mk("calendar_today_summary", "cal", {})];
        const result = await composeMorningBatch(intents, "telegram", [], { llm: mockLlm });
        expect(result).toBeNull();
    });
});
