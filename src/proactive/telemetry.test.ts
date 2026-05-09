// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../memory/sqlite.js";
import { TelemetryLogger, type ProactiveOutcome } from "./telemetry.js";

function mkLogger() {
    const raw = new BetterSqlite3(":memory:");
    initProactiveSchema(wrapDatabase(raw));
    return { raw, tl: new TelemetryLogger(raw) };
}

function outcome(overrides: Partial<ProactiveOutcome> = {}): ProactiveOutcome {
    return {
        intentId: "i1",
        source: "memory_anticipation",
        channel: "telegram",
        decision: "dispatched",
        ...overrides,
    };
}

describe("TelemetryLogger", () => {
    it("logs a row", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome());
        const count = (raw.prepare("SELECT COUNT(*) AS n FROM proactive_outcomes").get() as { n: number }).n;
        expect(count).toBe(1);
    });

    it("logs multiple rows for the same intent at different decisions", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome({ decision: "enqueued" }));
        tl.log(outcome({ decision: "released" }));
        tl.log(outcome({ decision: "dispatched", dispatchedAt: 12345 }));
        const count = (raw.prepare("SELECT COUNT(*) AS n FROM proactive_outcomes").get() as { n: number }).n;
        expect(count).toBe(3);
    });

    it("dropReason persists for dropped rows", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome({ decision: "dropped", dropReason: "dedup" }));
        const row = raw.prepare("SELECT drop_reason FROM proactive_outcomes").get() as { drop_reason: string };
        expect(row.drop_reason).toBe("dedup");
    });

    it("countByDecision returns zero-filled baseline when empty", () => {
        const { tl } = mkLogger();
        expect(tl.countByDecision()).toEqual({
            enqueued: 0, dropped: 0, released: 0, dispatched: 0, scheduled: 0,
        });
    });

    it("countByDecision counts + filters", () => {
        const { tl } = mkLogger();
        tl.log(outcome({ decision: "enqueued", source: "memory_anticipation" }));
        tl.log(outcome({ decision: "enqueued", source: "memory_anticipation" }));
        tl.log(outcome({ decision: "dispatched", source: "memory_anticipation" }));
        tl.log(outcome({ decision: "enqueued", source: "long_task_status" }));

        expect(tl.countByDecision()).toEqual({
            enqueued: 3, dropped: 0, released: 0, dispatched: 1, scheduled: 0,
        });
        expect(tl.countByDecision({ source: "memory_anticipation" })).toEqual({
            enqueued: 2, dropped: 0, released: 0, dispatched: 1, scheduled: 0,
        });
    });

    it("countByDecision filters by sinceMs", () => {
        const { raw, tl } = mkLogger();
        // Insert an old row directly
        raw.prepare(
            `INSERT INTO proactive_outcomes (intent_id, source, channel, decision, user_replied, created_at)
             VALUES ('old', 'x', 'y', 'enqueued', 0, 1)`,
        ).run();
        tl.log(outcome({ decision: "enqueued" }));
        const now = Date.now();
        expect(tl.countByDecision({ sinceMs: now - 1000 })).toEqual({
            enqueued: 1, dropped: 0, released: 0, dispatched: 0, scheduled: 0,
        });
    });

    it("rejectionRate returns 0 when no dispatched rows", () => {
        const { tl } = mkLogger();
        tl.log(outcome({ decision: "enqueued" }));
        expect(tl.rejectionRate("memory_anticipation", "telegram", 0)).toBe(0);
    });

    it("rejectionRate computes negative/dispatched", () => {
        const { tl } = mkLogger();
        tl.log(outcome({ decision: "dispatched", userReplySentiment: "positive" }));
        tl.log(outcome({ decision: "dispatched", userReplySentiment: "neutral" }));
        tl.log(outcome({ decision: "dispatched", userReplySentiment: "negative" }));
        tl.log(outcome({ decision: "dispatched", userMarkedUseful: false }));
        // 4 dispatched, 2 negative-ish (negative + marked-not-useful) = 0.5
        expect(tl.rejectionRate("memory_anticipation", "telegram", 0)).toBeCloseTo(0.5, 5);
    });

    it("statsBySourceChannel returns per-(source,channel) counts", () => {
        const { tl } = mkLogger();
        tl.log(outcome({ source: "memory_anticipation", channel: "telegram", decision: "enqueued" }));
        tl.log(outcome({ source: "memory_anticipation", channel: "telegram", decision: "dispatched" }));
        tl.log(outcome({ source: "long_task_status", channel: "whatsapp", decision: "enqueued" }));
        const stats = tl.statsBySourceChannel(0);
        expect(stats.length).toBe(2);
        const m = stats.find((s) => s.source === "memory_anticipation")!;
        expect(m.enqueued).toBe(1);
        expect(m.dispatched).toBe(1);
    });

    it("markReplied updates fields for dispatched row", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome({ decision: "dispatched", dispatchedAt: Date.now() - 10_000 }));
        tl.markReplied("i1", "positive", true);
        const row = raw.prepare("SELECT user_replied, user_reply_sentiment, user_marked_useful FROM proactive_outcomes WHERE intent_id = 'i1'").get() as {
            user_replied: number;
            user_reply_sentiment: string;
            user_marked_useful: number;
        };
        expect(row.user_replied).toBe(1);
        expect(row.user_reply_sentiment).toBe("positive");
        expect(row.user_marked_useful).toBe(1);
    });

    it("log is best-effort — a bad raw doesn't throw", () => {
        // Construct a "broken" db where prepare throws
        const broken = {
            prepare: () => { throw new Error("boom"); },
        } as unknown as BetterSqlite3.Database;
        const tl = new TelemetryLogger(broken);
        expect(() => tl.log(outcome())).not.toThrow();
    });

    it("batchIds persists as JSON and round-trips", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome({ decision: "dispatched", batchIds: ["a", "b"] }));
        const row = raw.prepare("SELECT batch_ids FROM proactive_outcomes").get() as { batch_ids: string };
        expect(JSON.parse(row.batch_ids)).toEqual(["a", "b"]);
    });

    it("scheduledFor persists as numeric epoch ms", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome({ decision: "scheduled", scheduledFor: 12345 }));
        const row = raw.prepare("SELECT scheduled_for FROM proactive_outcomes").get() as { scheduled_for: number };
        expect(row.scheduled_for).toBe(12345);
    });

    it("batchIds and scheduledFor default to null when not supplied", () => {
        const { raw, tl } = mkLogger();
        tl.log(outcome());
        const row = raw.prepare("SELECT batch_ids, scheduled_for FROM proactive_outcomes").get() as {
            batch_ids: null;
            scheduled_for: null;
        };
        expect(row.batch_ids).toBeNull();
        expect(row.scheduled_for).toBeNull();
    });

    it("getTelemetry/setTelemetry singleton access works", async () => {
        const { getTelemetry, setTelemetry } = await import("./telemetry.js");
        expect(getTelemetry()).toBeNull();
        const { tl } = mkLogger();
        setTelemetry(tl);
        expect(getTelemetry()).toBe(tl);
        setTelemetry(null);
    });
});
