// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observer } from "./observer.js";
import type { ProactiveIntent } from "./intent.js";

// Mock the native module so tests don't touch the Rust scheduler
vi.mock("../../native/index.js", () => ({
    schedulerConfigure: vi.fn(),
    schedulerEnqueue: vi.fn().mockReturnValue("enqueued"),
    schedulerMarkBoundary: vi.fn(),
    schedulerSetDnd: vi.fn(),
    schedulerReleaseGrouped: vi.fn().mockReturnValue({ morningBatch: [], singles: [], dropped: [] }),
    schedulerDrainScheduled: vi.fn().mockReturnValue([]),
    schedulerDebugState: vi.fn().mockReturnValue(""),
    schedulerRefund: vi.fn(),
}));

const validIntent = (): ProactiveIntent => ({
    id: "x1",
    source: "memory_anticipation",
    mode: "fyi",
    urgency: "normal",
    channelPreference: "telegram",
    topic: "test",
    topicEmbedding: new Array(384).fill(0),
    evidence: [],
    payload: { kind: "memory_anticipation", hint: "hello" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
});

describe("Observer", () => {
    let dir: string;
    let configPath: string;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atlas-obs-"));
        configPath = join(dir, "proactive-config.json");
        for (const k of Object.keys(process.env)) {
            if (k.startsWith("ATLAS_PROACTIVE")) delete process.env[k];
        }
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        process.env = { ...originalEnv };
    });

    it("enqueues a valid intent", () => {
        const obs = new Observer({ llm: null as never, configPath });
        expect(obs.enqueue(validIntent())).toBe(true);
        obs.stop();
    });

    it("rejects invalid intent (missing embedding length)", () => {
        const obs = new Observer({ llm: null as never, configPath });
        const bad = { ...validIntent(), topicEmbedding: [1, 2, 3] };
        expect(obs.enqueue(bad)).toBe(false);
        obs.stop();
    });

    it("rejects when ATLAS_PROACTIVE_DISABLE=true", () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const obs = new Observer({ llm: null as never, configPath });
        expect(obs.enqueue(validIntent())).toBe(false);
        obs.stop();
    });

    it("rejects when source is disabled", () => {
        process.env.ATLAS_PROACTIVE_DISABLE_SOURCES = "memory_anticipation";
        const obs = new Observer({ llm: null as never, configPath });
        expect(obs.enqueue(validIntent())).toBe(false);
        obs.stop();
    });

    it("start() subscribes to boundary bus; stop() unsubscribes", () => {
        const obs = new Observer({ llm: null as never, configPath });
        obs.start();
        // Can't easily observe the subscription count from outside; just assert stop() is safe.
        expect(() => obs.stop()).not.toThrow();
    });
});

describe("Observer.tuneSourceWeights", () => {
    let dir: string;
    let configPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atlas-obs-tune-"));
        configPath = join(dir, "proactive-config.json");
    });

    afterEach(async () => {
        const { setTelemetry } = await import("./telemetry.js");
        setTelemetry(null);
        rmSync(dir, { recursive: true, force: true });
    });

    it("leaves dynamicWeights unchanged when no telemetry", () => {
        const obs = new Observer({ llm: null as never, configPath });
        // no telemetry set
        expect(() => obs.tuneSourceWeights()).not.toThrow();
        // Dynamic weights should still equal base weights
        expect(obs._getDynamicWeight("memory_anticipation")).toBe(0.7);
        expect(obs._getDynamicWeight("latent_topic_monitor")).toBe(1.5);
        obs.stop();
    });

    it("lowers weight when rejection rate > 0", async () => {
        const { TelemetryLogger, setTelemetry } = await import("./telemetry.js");
        const BS = (await import("better-sqlite3")).default;
        const { wrapDatabase, initProactiveSchema } = await import("../memory/sqlite.js");
        const raw = new BS(":memory:");
        initProactiveSchema(wrapDatabase(raw));
        const tl = new TelemetryLogger(raw);
        setTelemetry(tl);

        // Simulate 10 dispatched memory_anticipation intents on telegram,
        // all marked not useful (rejection rate = 100%)
        for (let i = 0; i < 10; i++) {
            tl.log({
                intentId: `i${i}`,
                source: "memory_anticipation",
                channel: "telegram",
                decision: "dispatched",
                userMarkedUseful: false,
            });
        }

        const obs = new Observer({ llm: null as never, configPath });
        obs.tuneSourceWeights();
        // Base weight for memory_anticipation is 0.7. After 100% rejection,
        // (1-1.0) = 0 would drive to 0, but clamp floor is 0.2.
        const w = obs._getDynamicWeight("memory_anticipation");
        expect(w).toBeLessThan(0.7);
        expect(w).toBeGreaterThanOrEqual(0.2);

        obs.stop();
    });

    it("clamps weight to base when no signal and resets from out-of-range", () => {
        // Construct a scenario where weights would go up (they don't in the current formula,
        // since (1-R) maxes at 1.0 when R=0 — formula won't produce > base).
        const obs = new Observer({ llm: null as never, configPath });
        // Manually set an out-of-range dynamic weight, then re-run with no
        // telemetry — it should reset to base.
        obs._setDynamicWeightForTest("memory_anticipation", 5.0);
        obs.tuneSourceWeights();
        expect(obs._getDynamicWeight("memory_anticipation")).toBe(0.7);
        obs.stop();
    });
});

describe("resolveChannel", () => {
    it("routes to a channel that can deliver: preference, then Primary channel, then overlay", async () => {
        const { resolveChannel } = await import("./observer.js");
        const { registerChannelSender } = await import("../tools/channel-send.js");
        expect(resolveChannel("any")).toBe("telegram"); // nothing registered: unchanged
        registerChannelSender("overlay", async () => true as never);
        expect(resolveChannel("telegram")).toBe("overlay"); // desktop-only user
        registerChannelSender("whatsapp", async () => true as never);
        process.env.PRIMARY_CHANNEL = "whatsapp";
        expect(resolveChannel("any")).toBe("whatsapp");
        expect(resolveChannel("overlay")).toBe("overlay"); // a deliverable preference wins
        delete process.env.PRIMARY_CHANNEL;
    });
});

describe("quiet hours", () => {
    it("inWindow handles windows that cross midnight", async () => {
        const { inWindow } = await import("./config.js");
        const night = { start: "22:30", end: "07:00" };
        const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m);
        expect(inWindow(night, at(23))).toBe(true);
        expect(inWindow(night, at(3))).toBe(true);
        expect(inWindow(night, at(7))).toBe(false);
        expect(inWindow(night, at(22, 29))).toBe(false);
        expect(inWindow({ start: "05:00", end: "12:00" }, at(9))).toBe(true);
    });

    it("morning sources don't run at 3 AM", async () => {
        const { SourceRegistry } = await import("./sources/registry.js");
        const reg = new SourceRegistry();
        let ran = 0;
        reg.register({ name: "news_morning", collectIntents: async () => (ran++, []) } as never);
        await reg.collectAll({ now: new Date(2026, 9, 28, 3).getTime() } as never);
        expect(ran).toBe(0);
        await reg.collectAll({ now: new Date(2026, 9, 28, 8).getTime() } as never);
        expect(ran).toBe(1);
    });
});

describe("owner-memory nudges", () => {
    it("go to the owners only and give the slot back when the sender refuses", async () => {
        const native = await import("../../native/index.js");
        const { registerChannelSender } = await import("../tools/channel-send.js");
        const dir = mkdtempSync(join(tmpdir(), "atlas-obs-own-"));
        const calls: unknown[][] = [];
        registerChannelSender("telegram", async (...args) => {
            calls.push(args);
            return false; // Smart DND
        });
        const obs = new Observer({ llm: null as never, configPath: join(dir, "c.json") });
        const intent: ProactiveIntent = {
            ...validIntent(),
            id: "c1",
            source: "commitment_due",
            mode: "question",
            payload: { kind: "commitment_due", memoryId: 1, content: "Send the deck", dueMs: Date.now(), ownerOnly: true },
        };
        expect(obs.enqueue(intent)).toBe(true);
        const none = { morningBatch: [], singles: [], dropped: [] };
        vi.mocked(native.schedulerReleaseGrouped).mockImplementation((ch) =>
            ch === "telegram" ? { ...none, singles: ["c1"] } : none,
        );
        await obs.tickAll();
        expect(calls).toHaveLength(1);
        expect(calls[0][3]).toBe(true); // ownerOnly
        expect(native.schedulerRefund).toHaveBeenCalledWith("telegram", 1);
        obs.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    it("a morning batch that doesn't go out gives back its one slot, once, with every topic", async () => {
        const native = await import("../../native/index.js");
        const dir = mkdtempSync(join(tmpdir(), "atlas-obs-batch-"));
        const obs = new Observer({ llm: null as never, configPath: join(dir, "c.json") });
        for (const id of ["m1", "m2"]) {
            expect(obs.enqueue({ ...validIntent(), id, payload: { kind: "tasks_today", text: id } })).toBe(true);
        }
        vi.mocked(native.schedulerRefund).mockClear();
        const none = { morningBatch: [], singles: [], dropped: [] };
        vi.mocked(native.schedulerReleaseGrouped).mockImplementation((ch) =>
            ch === "telegram" ? { ...none, morningBatch: ["m1", "m2"] } : none,
        );
        await obs.tickAll();
        expect(native.schedulerRefund).toHaveBeenCalledTimes(1);
        expect(native.schedulerRefund).toHaveBeenCalledWith("telegram", 2);
        obs.stop();
        rmSync(dir, { recursive: true, force: true });
    });
});
