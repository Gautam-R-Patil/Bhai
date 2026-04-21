// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SourceRegistry } from "./registry.js";
import type { IntentSourceModule } from "./source.js";
import type { ProactiveIntent } from "../intent.js";

function mkIntent(id: string, source: ProactiveIntent["source"] = "memory_anticipation"): ProactiveIntent {
    return {
        id,
        source,
        mode: "fyi",
        urgency: "normal",
        channelPreference: "any",
        topic: "t",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "x" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
}

describe("SourceRegistry", () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        for (const k of Object.keys(process.env)) {
            if (k.startsWith("ATLAS_PROACTIVE")) delete process.env[k];
        }
    });
    afterEach(() => { process.env = { ...originalEnv }; });

    it("collects intents from a registered source", async () => {
        const reg = new SourceRegistry();
        reg.register({
            name: "memory_anticipation",
            async collectIntents() { return [mkIntent("a")]; },
        });
        const intents = await reg.collectAll({ now: Date.now() });
        expect(intents.length).toBe(1);
        expect(intents[0].id).toBe("a");
    });

    it("collects from multiple sources", async () => {
        const reg = new SourceRegistry();
        reg.register({
            name: "memory_anticipation",
            async collectIntents() { return [mkIntent("a", "memory_anticipation")]; },
        });
        reg.register({
            name: "long_task_status",
            async collectIntents() { return [mkIntent("b", "long_task_status")]; },
        });
        const intents = await reg.collectAll({ now: Date.now() });
        expect(intents.length).toBe(2);
    });

    it("fail-isolates: one source throwing doesn't kill others", async () => {
        const reg = new SourceRegistry();
        reg.register({
            name: "memory_anticipation",
            async collectIntents() { throw new Error("boom"); },
        });
        reg.register({
            name: "long_task_status",
            async collectIntents() { return [mkIntent("b", "long_task_status")]; },
        });
        const intents = await reg.collectAll({ now: Date.now() });
        expect(intents.length).toBe(1);
        expect(intents[0].id).toBe("b");
    });

    it("respects per-source kill switch", async () => {
        process.env.ATLAS_PROACTIVE_DISABLE_SOURCES = "memory_anticipation";
        const reg = new SourceRegistry();
        reg.register({
            name: "memory_anticipation",
            async collectIntents() { return [mkIntent("a", "memory_anticipation")]; },
        });
        reg.register({
            name: "long_task_status",
            async collectIntents() { return [mkIntent("b", "long_task_status")]; },
        });
        const intents = await reg.collectAll({ now: Date.now() });
        expect(intents.length).toBe(1);
        expect(intents[0].id).toBe("b");
    });

    it("returns empty when no sources registered", async () => {
        const reg = new SourceRegistry();
        const intents = await reg.collectAll({ now: Date.now() });
        expect(intents).toEqual([]);
    });

    it("list() returns source names in registration order", () => {
        const reg = new SourceRegistry();
        reg.register({ name: "memory_anticipation", async collectIntents() { return []; } });
        reg.register({ name: "long_task_status", async collectIntents() { return []; } });
        expect(reg.list()).toEqual(["memory_anticipation", "long_task_status"]);
    });

    it("runs sources in parallel (not sequentially)", async () => {
        const reg = new SourceRegistry();
        let aStarted = 0;
        let bStarted = 0;
        reg.register({
            name: "memory_anticipation",
            async collectIntents() {
                aStarted = Date.now();
                await new Promise((r) => setTimeout(r, 50));
                return [];
            },
        });
        reg.register({
            name: "long_task_status",
            async collectIntents() {
                bStarted = Date.now();
                await new Promise((r) => setTimeout(r, 50));
                return [];
            },
        });
        const start = Date.now();
        await reg.collectAll({ now: Date.now() });
        const elapsed = Date.now() - start;
        // If sequential, would be ~100ms. In parallel, both start ~immediately and total is ~50ms.
        expect(Math.abs(aStarted - bStarted)).toBeLessThan(20);
        expect(elapsed).toBeLessThan(90);
    });
});
