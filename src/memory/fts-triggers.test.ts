// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CONVERSATIONS_FTS_SYNC_SQL, MEMORIES_FTS_SYNC_SQL } from "./fts-triggers.js";

// node:sqlite (Node 22.5+) ships FTS5 with the trigram tokenizer; better-sqlite3's
// binding isn't loadable under this repo's test runner.
type Db = { exec(sql: string): void; prepare(sql: string): { get(...a: unknown[]): any } };
let DatabaseSync: (new (path: string) => Db) | undefined;
try {
    DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
    /* older Node */
}

const count = (db: Db, table: string) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

describe.skipIf(!DatabaseSync)("FTS sync triggers", () => {
    it("fixes an existing database: update and delete work and keep both FTS tables in sync", () => {
        const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
        db.exec(`
            CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, category TEXT, tags TEXT, importance INT);
            CREATE VIRTUAL TABLE memories_fts USING fts5(content, category, tags, tokenize='porter unicode61');
            CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(content, category, tags, tokenize='trigram');
            CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
              INSERT OR REPLACE INTO memories_fts(rowid, content, category, tags) VALUES (new.id, new.content, new.category, new.tags);
              INSERT OR REPLACE INTO memories_fts_trigram(rowid, content, category, tags) VALUES (new.id, new.content, new.category, new.tags);
            END;
            -- the old body that made every DELETE fail
            CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, content, category, tags) VALUES ('delete', old.id, old.content, old.category, old.tags);
            END;
            INSERT INTO memories VALUES (1, 'pineapple code word', 'fact', '', 1), (2, 'earphones under 5k', 'task', '', 1);
        `);
        expect(() => db.exec("DELETE FROM memories WHERE id = 2")).toThrow();

        db.exec(MEMORIES_FTS_SYNC_SQL);
        db.exec("UPDATE memories SET content = 'mango code word', importance = 3 WHERE id = 1");
        expect(db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'mango'").get()?.rowid).toBe(1);
        expect(db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'pineapple'").get()).toBeUndefined();

        db.exec("DELETE FROM memories WHERE id = 2");
        expect(count(db, "memories")).toBe(1);
        expect(count(db, "memories_fts")).toBe(1);
        expect(count(db, "memories_fts_trigram")).toBe(1);
    });

    it("deletes conversation messages and their FTS rows", () => {
        const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
        db.exec(`
            CREATE TABLE conversation_messages (id INTEGER PRIMARY KEY, content TEXT, role TEXT, session_id TEXT);
            CREATE VIRTUAL TABLE conversations_fts USING fts5(content, role, session_id UNINDEXED, tokenize='porter unicode61');
            CREATE VIRTUAL TABLE conversations_fts_trigram USING fts5(content, role, session_id UNINDEXED, tokenize='trigram');
            INSERT INTO conversation_messages VALUES (1, 'hello', 'user', 's');
            INSERT INTO conversations_fts(rowid, content, role, session_id) VALUES (1, 'hello', 'user', 's');
            INSERT INTO conversations_fts_trigram(rowid, content, role, session_id) VALUES (1, 'hello', 'user', 's');
        `);
        db.exec(CONVERSATIONS_FTS_SYNC_SQL);
        db.exec("DELETE FROM conversation_messages WHERE id = 1");
        expect(count(db, "conversations_fts") + count(db, "conversations_fts_trigram")).toBe(0);
    });
});
