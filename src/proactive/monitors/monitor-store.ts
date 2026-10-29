// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// MonitorStore — SQLite persistence for user-defined latent-topic rules.
// Phase 3.9b of the proactive overhaul. Sits between the NL parser (3.9c)
// and the Rust matcher (3.9a).

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Channel } from "../intent.js";

export type MonitorRule = {
    id: string;
    userPhrase: string;
    topic: string;
    topicEmbedding: number[];
    scope: {
        channels: Channel[] | ["*"];
        groups?: string[];
        senders?: string[];
        excludeSelf: boolean;
    };
    urgency: "urgent" | "normal" | "ambient";
    action: {
        defaultMode: "fyi" | "question" | "review";
        suggestedFollowup?: string;
    };
    threshold: number;
    cooldownMinutes: number;
    active: boolean;
    lastFiredAt: number;
    expiresAt?: number;
    createdAt: number;
};

export type MonitorRuleInput = Omit<MonitorRule, "id" | "createdAt" | "active" | "lastFiredAt">;

export class MonitorStore {
    constructor(private db: Database.Database) {}

    insert(input: MonitorRuleInput): MonitorRule {
        const rule: MonitorRule = {
            ...input,
            id: randomUUID(),
            active: true,
            lastFiredAt: 0,
            createdAt: Date.now(),
        };
        const emb = Buffer.from(new Float32Array(rule.topicEmbedding).buffer);
        this.db
            .prepare(
                `INSERT INTO monitor_rules (
                    id, user_phrase, topic, topic_embedding, scope_json,
                    urgency, action_json, threshold, cooldown_minutes,
                    active, last_fired_at, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                rule.id,
                rule.userPhrase,
                rule.topic,
                emb,
                JSON.stringify(rule.scope),
                rule.urgency,
                JSON.stringify(rule.action),
                rule.threshold,
                rule.cooldownMinutes,
                rule.active ? 1 : 0,
                rule.lastFiredAt,
                rule.expiresAt ?? null,
                rule.createdAt,
            );
        return rule;
    }

    get(id: string): MonitorRule | null {
        const row = this.db.prepare(`SELECT * FROM monitor_rules WHERE id = ?`).get(id) as
            | MonitorRuleRow
            | undefined;
        if (!row) return null;
        return rowToRule(row);
    }

    list(onlyActive = true): MonitorRule[] {
        const sql = onlyActive
            ? `SELECT * FROM monitor_rules WHERE active = 1 ORDER BY created_at DESC`
            : `SELECT * FROM monitor_rules ORDER BY created_at DESC`;
        const rows = this.db.prepare(sql).all() as MonitorRuleRow[];
        return rows.map(rowToRule);
    }

    softDelete(id: string): void {
        this.db.prepare(`UPDATE monitor_rules SET active = 0 WHERE id = ?`).run(id);
    }

    hardDelete(id: string): void {
        this.db.prepare(`DELETE FROM monitor_rules WHERE id = ?`).run(id);
    }

    setActive(id: string, active: boolean): void {
        this.db.prepare(`UPDATE monitor_rules SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
    }

    markFired(id: string, ts: number): void {
        this.db.prepare(`UPDATE monitor_rules SET last_fired_at = ? WHERE id = ?`).run(ts, id);
    }
}

// ── Internal row shape (straight from SQLite) ──

type MonitorRuleRow = {
    id: string;
    user_phrase: string;
    topic: string;
    topic_embedding: Buffer;
    scope_json: string;
    urgency: string;
    action_json: string;
    threshold: number;
    cooldown_minutes: number;
    active: number;
    last_fired_at: number;
    expires_at: number | null;
    created_at: number;
};

function rowToRule(row: MonitorRuleRow): MonitorRule {
    const buf = row.topic_embedding;
    const embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    return {
        id: row.id,
        userPhrase: row.user_phrase,
        topic: row.topic,
        topicEmbedding: embedding,
        scope: JSON.parse(row.scope_json),
        urgency: row.urgency as MonitorRule["urgency"],
        action: JSON.parse(row.action_json),
        threshold: row.threshold,
        cooldownMinutes: row.cooldown_minutes,
        active: row.active === 1,
        lastFiredAt: row.last_fired_at,
        expiresAt: row.expires_at ?? undefined,
        createdAt: row.created_at,
    };
}
