// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SCHEMA_VERSION = 1;

const DEFAULT_DB_PATH = join(homedir(), ".atlas", "data", "skill-library.db");

let _db: Database.Database | null = null;
let _path: string | null = null;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS tools (
    slug         TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    schema_json  TEXT NOT NULL,
    handler_hash TEXT NOT NULL,
    embedding    BLOB NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('synchronous','dream_replay','sideloaded','migrated')),
    origin_intent TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    graduated_at INTEGER,
    published_at INTEGER,
    archived_at  INTEGER
);

CREATE TABLE IF NOT EXISTS tests (
    slug TEXT NOT NULL,
    test_id INTEGER NOT NULL,
    input_json TEXT NOT NULL,
    expected_kind TEXT NOT NULL,
    expected_value TEXT,
    last_pass INTEGER,
    last_fail INTEGER,
    PRIMARY KEY (slug, test_id),
    FOREIGN KEY (slug) REFERENCES tools(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS executions (
    slug TEXT NOT NULL,
    ts INTEGER NOT NULL,
    success INTEGER NOT NULL CHECK (success IN (0,1)),
    duration_ms INTEGER NOT NULL,
    error_kind TEXT,
    input_hash TEXT,
    session_id TEXT,
    FOREIGN KEY (slug) REFERENCES tools(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_aliases (
    alias_slug TEXT PRIMARY KEY,
    canonical_slug TEXT NOT NULL,
    similarity REAL NOT NULL,
    merged_at INTEGER NOT NULL,
    FOREIGN KEY (canonical_slug) REFERENCES tools(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dedup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    candidate_description TEXT NOT NULL,
    matched_slug TEXT,
    similarity REAL,
    action TEXT NOT NULL CHECK (action IN ('merged','warned','distinct'))
);

CREATE TABLE IF NOT EXISTS library_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
    slug UNINDEXED, description, schema_keys, content=''
);

CREATE INDEX IF NOT EXISTS idx_executions_slug_ts ON executions(slug, ts);
CREATE INDEX IF NOT EXISTS idx_tools_source ON tools(source);
CREATE INDEX IF NOT EXISTS idx_tools_active ON tools(slug) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tools_archived ON tools(archived_at) WHERE archived_at IS NOT NULL;
`;

export function openLibrary(path: string = DEFAULT_DB_PATH): Database.Database {
    if (_db && _path === path) return _db;
    if (_db) closeLibrary();

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    _db = new Database(path);
    _path = path;
    try {
        // Fail-open per pragma — SQLite builds without WAL or with restricted features
        // shouldn't crash; we accept the default behavior.
        try { _db.pragma("journal_mode = wal"); } catch { /* fail-open */ }
        try { _db.pragma("synchronous = normal"); } catch { /* fail-open */ }
        try { _db.pragma("foreign_keys = on"); } catch { /* fail-open */ }

        _db.exec(SCHEMA_DDL);

        const existing = _db.prepare(`SELECT value FROM library_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
        if (!existing) {
            _db.prepare(`INSERT INTO library_meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
        }
        return _db;
    } catch (err) {
        closeLibrary();
        throw err;
    }
}

export function closeLibrary(): void {
    if (_db) {
        _db.close();
        _db = null;
        _path = null;
    }
}

export function getLibrarySchemaVersion(): number {
    if (!_db) throw new Error("library not open");
    const row = _db.prepare(`SELECT value FROM library_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
}

export function getLibrary(): Database.Database {
    if (!_db) throw new Error("library not open");
    return _db;
}
