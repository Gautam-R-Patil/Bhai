// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { scrubSecretsAtRest } from "./at-rest-scrub.js";

const SECRET = "log into netflix, password: Tr0ub4dor&3x and pay with 4111 1111 1111 1111";

function oldDb(): BetterSqlite3.Database {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
        CREATE TABLE conversations (id INTEGER PRIMARY KEY, session_id TEXT, messages_json TEXT, summary TEXT);
        CREATE TABLE conversation_messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, session_id TEXT, msg_index INTEGER, role TEXT, content TEXT);
        CREATE VIRTUAL TABLE conversations_fts USING fts5(content, role UNINDEXED, session_id UNINDEXED);
        CREATE VIRTUAL TABLE conversations_fts_trigram USING fts5(content, role UNINDEXED, session_id UNINDEXED, tokenize='trigram');
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, current_goal TEXT, short_summary TEXT, recent_turns_json TEXT, last_compression_summary TEXT);
    `);
    db.prepare("INSERT INTO conversations VALUES (1, 's', ?, 'chat about netflix')").run(
        JSON.stringify([{ role: "user", content: SECRET }]),
    );
    db.prepare("INSERT INTO conversation_messages VALUES (7, 1, 's', 0, 'user', ?)").run(SECRET);
    for (const t of ["conversations_fts", "conversations_fts_trigram"])
        db.prepare(`INSERT INTO ${t}(rowid, content, role, session_id) VALUES (7, ?, 'user', 's')`).run(SECRET);
    db.prepare("INSERT INTO sessions VALUES ('s', '', '', ?, '')").run(
        JSON.stringify([{ role: "user", content: SECRET }]),
    );
    return db;
}

describe("one-time scrub of conversation text saved before at-rest masking", () => {
    it("masks the archive, both search indexes and the session buffer — once", () => {
        const db = oldDb();
        expect(scrubSecretsAtRest(db)).toEqual({ conversations: 1, conversation_messages: 1, sessions: 1 });
        const dump = JSON.stringify([
            db.prepare("SELECT * FROM conversations").all(),
            db.prepare("SELECT * FROM conversation_messages").all(),
            db.prepare("SELECT content FROM conversations_fts").all(),
            db.prepare("SELECT content FROM conversations_fts_trigram").all(),
            db.prepare("SELECT * FROM sessions").all(),
        ]);
        for (const v of ["Tr0ub4dor&3x", "4111 1111 1111 1111"]) expect(dump).not.toContain(v);
        expect(dump).toContain("log into netflix"); // the rest stays searchable
        expect(
            db.prepare("SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH 'netflix'").all(),
        ).toHaveLength(1);
        expect(scrubSecretsAtRest(db)).toBeNull(); // recorded: never runs twice
    });

    it("is harmless on a database without those tables", () => {
        expect(scrubSecretsAtRest(new BetterSqlite3(":memory:"))).toEqual({
            conversations: 0,
            conversation_messages: 0,
            sessions: 0,
        });
    });
});
