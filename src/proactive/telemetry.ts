// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// TelemetryLogger — SQLite writer for proactive_outcomes rows.
// Phase 5.2 of the proactive overhaul.
//
// Each decision point in the Observer (enqueue happy path + every rejection
// branch, release, dispatched, compose_failed, dispatch_failed) writes a
// separate append-only row to proactive_outcomes. Aggregations (drop rate,
// dispatch rate, rejection rate) run as plain SQL against (source, channel,
// created_at).
//
// All writes are best-effort — a failed insert is swallowed so telemetry
// can never block a user-visible action.

import type Database from "better-sqlite3";
import type { IntentSource, Channel } from "./intent.js";

export type Decision = "enqueued" | "dropped" | "released" | "dispatched";
export type Sentiment = "positive" | "neutral" | "negative";

export type ProactiveOutcome = {
    intentId: string;
    source: IntentSource | string;
    channel: Channel | string;
    decision: Decision;
    dropReason?: string;
    dispatchedAt?: number;
    userReplied?: boolean;
    userReplyLatencyMs?: number;
    userReplySentiment?: Sentiment;
    userMarkedUseful?: boolean;
};

export type SourceChannelStats = {
    source: string;
    channel: string;
    enqueued: number;
    dropped: number;
    released: number;
    dispatched: number;
    dropRate: number;            // dropped / (enqueued || 1)
    dispatchRate: number;        // dispatched / (released || 1)
    rejectionRate: number;       // negative/not-useful replies / dispatched
};

export class TelemetryLogger {
    constructor(private db: Database.Database) {}

    log(o: ProactiveOutcome): void {
        try {
            this.db
                .prepare(
                    `INSERT INTO proactive_outcomes (
                        intent_id, source, channel, decision, drop_reason,
                        dispatched_at, user_replied, user_reply_latency_ms,
                        user_reply_sentiment, user_marked_useful, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    o.intentId,
                    o.source,
                    o.channel,
                    o.decision,
                    o.dropReason ?? null,
                    o.dispatchedAt ?? null,
                    o.userReplied ? 1 : 0,
                    o.userReplyLatencyMs ?? null,
                    o.userReplySentiment ?? null,
                    o.userMarkedUseful == null ? null : (o.userMarkedUseful ? 1 : 0),
                    Date.now(),
                );
        } catch {
            // Best-effort — never break the caller.
        }
    }

    /** Count rows matching the filter, grouped by decision. */
    countByDecision(filters: { source?: string; channel?: string; sinceMs?: number } = {}): Record<Decision, number> {
        const where: string[] = [];
        const args: unknown[] = [];
        if (filters.source) { where.push("source = ?"); args.push(filters.source); }
        if (filters.channel) { where.push("channel = ?"); args.push(filters.channel); }
        if (filters.sinceMs) { where.push("created_at >= ?"); args.push(filters.sinceMs); }
        const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const rows = this.db
            .prepare(
                `SELECT decision, COUNT(*) AS n
                 FROM proactive_outcomes
                 ${clause}
                 GROUP BY decision`,
            )
            .all(...args) as Array<{ decision: string; n: number }>;

        const result: Record<Decision, number> = {
            enqueued: 0, dropped: 0, released: 0, dispatched: 0,
        };
        for (const r of rows) {
            if (r.decision === "enqueued" || r.decision === "dropped" ||
                r.decision === "released" || r.decision === "dispatched") {
                result[r.decision] = r.n;
            }
        }
        return result;
    }

    /** Rejection rate for a given source+channel, over rows newer than sinceMs. */
    rejectionRate(source: string, channel: string, sinceMs: number): number {
        const row = this.db
            .prepare(
                `SELECT
                    SUM(CASE
                        WHEN user_reply_sentiment='negative' OR user_marked_useful=0 THEN 1
                        ELSE 0
                    END) AS neg,
                    SUM(CASE WHEN decision='dispatched' THEN 1 ELSE 0 END) AS dispatched
                 FROM proactive_outcomes
                 WHERE source = ? AND channel = ? AND created_at >= ?`,
            )
            .get(source, channel, sinceMs) as { neg: number | null; dispatched: number | null };
        const dispatched = row?.dispatched ?? 0;
        if (!dispatched) return 0;
        return (row?.neg ?? 0) / dispatched;
    }

    /** Stats per source+channel, grouped. */
    statsBySourceChannel(sinceMs: number): SourceChannelStats[] {
        const rows = this.db
            .prepare(
                `SELECT source, channel,
                    SUM(CASE WHEN decision='enqueued' THEN 1 ELSE 0 END) AS enqueued,
                    SUM(CASE WHEN decision='dropped' THEN 1 ELSE 0 END) AS dropped,
                    SUM(CASE WHEN decision='released' THEN 1 ELSE 0 END) AS released,
                    SUM(CASE WHEN decision='dispatched' THEN 1 ELSE 0 END) AS dispatched,
                    SUM(CASE
                        WHEN user_reply_sentiment='negative' OR user_marked_useful=0 THEN 1
                        ELSE 0
                    END) AS neg
                 FROM proactive_outcomes
                 WHERE created_at >= ?
                 GROUP BY source, channel
                 ORDER BY source, channel`,
            )
            .all(sinceMs) as Array<{
                source: string;
                channel: string;
                enqueued: number | null;
                dropped: number | null;
                released: number | null;
                dispatched: number | null;
                neg: number | null;
            }>;

        return rows.map((r) => {
            const enqueued = r.enqueued ?? 0;
            const dropped = r.dropped ?? 0;
            const released = r.released ?? 0;
            const dispatched = r.dispatched ?? 0;
            const neg = r.neg ?? 0;
            return {
                source: r.source,
                channel: r.channel,
                enqueued,
                dropped,
                released,
                dispatched,
                dropRate: enqueued > 0 ? dropped / enqueued : 0,
                dispatchRate: released > 0 ? dispatched / released : 0,
                rejectionRate: dispatched > 0 ? neg / dispatched : 0,
            };
        });
    }

    /**
     * Mark a dispatched intent as replied-to (for rejection-rate learning).
     * Future callers wire this when user-reply tracking is added.
     */
    markReplied(intentId: string, sentiment: Sentiment, markedUseful: boolean | null = null): void {
        try {
            this.db
                .prepare(
                    `UPDATE proactive_outcomes
                     SET user_replied = 1,
                         user_reply_latency_ms = ? - dispatched_at,
                         user_reply_sentiment = ?,
                         user_marked_useful = ?
                     WHERE intent_id = ? AND decision = 'dispatched'`,
                )
                .run(
                    Date.now(),
                    sentiment,
                    markedUseful == null ? null : (markedUseful ? 1 : 0),
                    intentId,
                );
        } catch {
            /* best-effort */
        }
    }
}

// Singleton accessor — mirrors the rest of the proactive singletons.
let _telemetry: TelemetryLogger | null = null;
export function getTelemetry(): TelemetryLogger | null { return _telemetry; }
export function setTelemetry(t: TelemetryLogger | null): void { _telemetry = t; }
