// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mergeStoredMessages, selectCorpusMessages } from "./reflection.js";

// Mirrors the conversations DDL from sqlite.ts:172-180 so we can assert that
// old (short) and new (full) messages_json rows coexist with no migration.
const CONVERSATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    summary TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`;

function makeHistory(n: number): Array<{ role: string; content: string }> {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message number ${i}`,
    }));
}

describe("selectCorpusMessages (P4.2 corpus persistence policy)", () => {
    it("persists the FULL history when max <= 0 (default behavior)", () => {
        const history = makeHistory(50);
        const stored = selectCorpusMessages(history, 0);
        expect(stored).toHaveLength(50);
        // Round-trips through JSON unchanged — this is what reflection persists.
        expect(JSON.parse(JSON.stringify(stored))).toHaveLength(50);
        expect(stored[0]).toBe(history[0]);
        expect(stored[49]).toBe(history[49]);
    });

    it("re-caps to the last N when max > 0 (legacy slice(-20) parity)", () => {
        const history = makeHistory(50);
        const stored = selectCorpusMessages(history, 20);
        expect(stored).toHaveLength(20);
        // Last 20 == messages 30..49.
        expect(stored[0]).toBe(history[30]);
        expect(stored[19]).toBe(history[49]);
    });

    it("treats negative / NaN max as full history", () => {
        const history = makeHistory(10);
        expect(selectCorpusMessages(history, -5)).toHaveLength(10);
        expect(selectCorpusMessages(history, Number.NaN)).toHaveLength(10);
    });

    it("is a no-op on an empty history", () => {
        expect(selectCorpusMessages([], 0)).toHaveLength(0);
        expect(selectCorpusMessages([], 20)).toHaveLength(0);
    });
});

describe("conversations messages_json backward-compat (no migration needed)", () => {
    it("stores and reads back both an old short row and a new full row", () => {
        const raw = new BetterSqlite3(":memory:");
        raw.exec(CONVERSATIONS_DDL);

        const oldRow = JSON.stringify(makeHistory(5)); // simulated legacy slice(-20) row
        const newRow = JSON.stringify(makeHistory(50)); // new full-history row

        const insert = raw.prepare("INSERT INTO conversations (session_id, messages_json, summary) VALUES (?, ?, ?)");
        insert.run("old-session", oldRow, "old summary");
        insert.run("new-session", newRow, "new summary");

        const rows = raw.prepare("SELECT session_id, messages_json FROM conversations ORDER BY id").all() as Array<{
            session_id: string;
            messages_json: string;
        }>;

        expect(rows).toHaveLength(2);
        // Both parse cleanly as JSON arrays — readers JSON.parse them identically.
        const parsedOld = JSON.parse(rows[0].messages_json);
        const parsedNew = JSON.parse(rows[1].messages_json);
        expect(Array.isArray(parsedOld)).toBe(true);
        expect(Array.isArray(parsedNew)).toBe(true);
        expect(parsedOld).toHaveLength(5);
        expect(parsedNew).toHaveLength(50);
        // The full stored content is preserved — not truncated by the column.
        expect(rows[1].messages_json).toBe(newRow);

        raw.close();
    });
});

describe("mergeStoredMessages (one transcript row per session)", () => {
    it("keeps earlier messages and appends only the new ones", () => {
        const stored = JSON.stringify(makeHistory(4));
        // History pruned since the last reflection: message 0 and 1 are gone.
        const later = [...makeHistory(4).slice(2), { role: "user", content: "message number 4" }];
        const merged = mergeStoredMessages(stored, later) as Array<{ content: string }>;
        expect(merged.map((m) => m.content)).toEqual([0, 1, 2, 3, 4].map((i) => `message number ${i}`));
    });

    it("replaces an unparseable row", () => {
        expect(mergeStoredMessages("not json", makeHistory(2))).toEqual(makeHistory(2));
    });
});
