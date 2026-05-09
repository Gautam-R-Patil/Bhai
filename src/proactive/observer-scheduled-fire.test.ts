// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Observer, setObserver } from "./observer.js";
import type { ProactiveIntent } from "./intent.js";
import * as native from "../../native/index.js";

function mkIntent(overrides: Partial<ProactiveIntent> = {}): ProactiveIntent {
    const now = Date.now();
    return {
        id: `t-${Math.random().toString(36).slice(2, 8)}`,
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "telegram",
        topic: "t" + Math.random(),
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "simple_note", note: "x" },
        createdAt: now,
        expiresAt: now + 3600_000,
        ...overrides,
    };
}

describe("Observer scheduled-fire routing", () => {
    let observer: Observer;

    beforeEach(() => {
        observer = new Observer({ llm: null, configPath: "/tmp/does-not-exist.json" });
        setObserver(observer);
    });

    it("accepts scheduledFor-future intent (lands in Rust pending heap)", () => {
        const future = Date.now() + 60 * 60_000;
        const intent = mkIntent({ scheduledFor: future, payloadKind: "meeting_prep" });
        const ok = observer.enqueue(intent);
        expect(ok).toBe(true);
    });

    it("accepts scheduledFor-zero intent (normal path)", () => {
        const intent = mkIntent({ scheduledFor: 0, payloadKind: "" });
        const ok = observer.enqueue(intent);
        expect(ok).toBe(true);
    });

    it("drainScheduled promotes pending intents after their fire time", async () => {
        // Spy on the native drain to verify tickAll calls it
        const drainSpy = vi.spyOn(native, "schedulerDrainScheduled");
        const fireAt = Date.now() + 50;
        const intent = mkIntent({
            scheduledFor: fireAt,
            payloadKind: "meeting_prep",
            channelPreference: "telegram",
        });
        observer.enqueue(intent);
        await new Promise((r) => setTimeout(r, 80));
        await observer.tickAll();
        // tickAll must have called schedulerDrainScheduled at least once per channel
        expect(drainSpy).toHaveBeenCalled();
        // The drain call for telegram should have returned the intent id
        const telegramCalls = drainSpy.mock.results.filter(
            (_, i) => drainSpy.mock.calls[i][0] === "telegram"
        );
        const promoted = telegramCalls.flatMap((r) => r.value as string[]);
        expect(promoted).toContain(intent.id);
        drainSpy.mockRestore();
    });
});
