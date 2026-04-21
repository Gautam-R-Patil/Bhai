// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { makeMemoryAnticipationSource } from "./memory-anticipation.js";
import type { UserPresence } from "../activity.js";

const fakePresence: UserPresence = {
    isActive: true,
    idleMinutes: 0,
    activeApps: [],
    frontmostApp: "Code",
    isJustServerProcesses: false,
    appTransitionHistory: [],
    activeAppDurationMinutes: new Map(),
};

describe("memory_anticipation source", () => {
    it("returns empty array when tick returns null", async () => {
        const src = makeMemoryAnticipationSource({
            tick: async () => null,
            embedText: async () => new Array(384).fill(0),
            getPresence: async () => fakePresence,
        });
        const out = await src.collectIntents({ now: Date.now() });
        expect(out).toEqual([]);
    });

    it("produces an intent when tick returns a thought string", async () => {
        const src = makeMemoryAnticipationSource({
            tick: async () => "You left the homepage mid-layout. Resume now?",
            embedText: async () => new Array(384).fill(0.01),
            getPresence: async () => fakePresence,
        });
        const out = await src.collectIntents({ now: Date.now() });
        expect(out.length).toBe(1);
    });

    it("intent has source=memory_anticipation, mode=fyi, urgency=ambient", async () => {
        const src = makeMemoryAnticipationSource({
            tick: async () => "test thought",
            embedText: async () => new Array(384).fill(0),
            getPresence: async () => fakePresence,
        });
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.source).toBe("memory_anticipation");
        expect(intent.mode).toBe("fyi");
        expect(intent.urgency).toBe("ambient");
    });

    it("embedding has length 384", async () => {
        const src = makeMemoryAnticipationSource({
            tick: async () => "test",
            embedText: async () => new Array(384).fill(0.5),
            getPresence: async () => fakePresence,
        });
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.topicEmbedding.length).toBe(384);
    });

    it("accepts Float32Array embedding and converts to number[]", async () => {
        const src = makeMemoryAnticipationSource({
            tick: async () => "test",
            embedText: async () => new Float32Array(384).fill(0.1),
            getPresence: async () => fakePresence,
        });
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.topicEmbedding.length).toBe(384);
        expect(Array.isArray(intent.topicEmbedding)).toBe(true);
    });

    it("topic is truncated to 80 chars", async () => {
        const longThought = "a".repeat(200);
        const src = makeMemoryAnticipationSource({
            tick: async () => longThought,
            embedText: async () => new Array(384).fill(0),
            getPresence: async () => fakePresence,
        });
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.topic.length).toBe(80);
    });

    it("tick receives presence and hourNow from getPresence + current time", async () => {
        const tickSpy = vi.fn().mockResolvedValue(null);
        const src = makeMemoryAnticipationSource({
            tick: tickSpy,
            embedText: async () => new Array(384).fill(0),
            getPresence: async () => fakePresence,
        });
        await src.collectIntents({ now: Date.now() });
        expect(tickSpy).toHaveBeenCalledWith(expect.objectContaining({
            presence: fakePresence,
            monitorAlerts: null,
            hourNow: expect.any(Number),
        }));
    });
});
