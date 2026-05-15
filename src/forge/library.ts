// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { ToolLifecycleState, ToolMetadata, ToolSource } from "./types.js";

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
        try {
            _db.pragma("journal_mode = wal");
        } catch {
            /* fail-open */
        }
        try {
            _db.pragma("synchronous = normal");
        } catch {
            /* fail-open */
        }
        try {
            _db.pragma("foreign_keys = on");
        } catch {
            /* fail-open */
        }

        _db.exec(SCHEMA_DDL);

        const existing = _db.prepare(`SELECT value FROM library_meta WHERE key = 'schema_version'`).get() as
            | { value: string }
            | undefined;
        if (!existing) {
            _db.prepare(`INSERT INTO library_meta (key, value) VALUES ('schema_version', ?)`).run(
                String(SCHEMA_VERSION),
            );
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
    const row = _db.prepare(`SELECT value FROM library_meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
    return row ? parseInt(row.value, 10) : 0;
}

export function getLibrary(): Database.Database {
    if (!_db) throw new Error("library not open");
    return _db;
}

export interface InsertToolOptions {
    slug: string;
    description: string;
    schemaJson: string;
    handlerHash: string;
    embedding: Float32Array;
    source: ToolSource;
    originIntent?: string;
    createdAt: number;
}

function embeddingToBuffer(emb: Float32Array): Buffer {
    return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

function bufferToEmbedding(buf: Buffer): Float32Array {
    // Defensive copy: the Float32Array view would alias the Buffer's underlying
    // ArrayBuffer. Future batch callers might mutate one result and silently
    // corrupt the other. .slice() returns a new typed array with its own backing.
    const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return view.slice();
}

function extractSchemaKeys(schemaJson: string): string {
    try {
        const schema = JSON.parse(schemaJson);
        if (schema?.properties) return Object.keys(schema.properties).join(" ");
    } catch {
        /* fall through */
    }
    return "";
}

export function insertTool(opts: InsertToolOptions): void {
    const db = getLibrary();
    const insertStmt = db.prepare(`
        INSERT INTO tools (slug, description, schema_json, handler_hash, embedding, source, origin_intent, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = db.prepare(`INSERT INTO tools_fts (slug, description, schema_keys) VALUES (?, ?, ?)`);

    const tx = db.transaction(() => {
        insertStmt.run(
            opts.slug,
            opts.description,
            opts.schemaJson,
            opts.handlerHash,
            embeddingToBuffer(opts.embedding),
            opts.source,
            opts.originIntent ?? null,
            opts.createdAt,
            opts.createdAt,
        );
        ftsStmt.run(opts.slug, opts.description, extractSchemaKeys(opts.schemaJson));
    });
    tx();
}

interface ToolRow {
    slug: string;
    description: string;
    schema_json: string;
    handler_hash: string;
    embedding: Buffer;
    source: string;
    origin_intent: string | null;
    created_at: number;
    updated_at: number;
    graduated_at: number | null;
    published_at: number | null;
    archived_at: number | null;
}

function rowToMetadata(row: ToolRow): ToolMetadata {
    let state: ToolLifecycleState = "active";
    if (row.archived_at) state = "archived";
    else if (row.published_at) state = "published";
    else if (row.graduated_at) state = "graduated";

    let schema: ToolMetadata["schema"];
    try {
        schema = JSON.parse(row.schema_json);
    } catch (e) {
        throw new Error(`corrupt schema_json for slug "${row.slug}": ${(e as Error).message}`);
    }

    return {
        slug: row.slug,
        description: row.description,
        schema,
        source: row.source as ToolSource,
        originIntent: row.origin_intent,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        graduatedAt: row.graduated_at,
        publishedAt: row.published_at,
        archivedAt: row.archived_at,
        // Phase 1: executions table is empty. Phase 3 reintroduces the real query.
        invocationCount: 0,
        successCount: 0,
        lifecycleState: state,
    };
}

export function getToolBySlug(slug: string): ToolMetadata | null {
    const db = getLibrary();
    const row = db.prepare(`SELECT * FROM tools WHERE slug = ?`).get(slug) as ToolRow | undefined;
    return row ? rowToMetadata(row) : null;
}

export function getToolEmbedding(slug: string): Float32Array | null {
    const db = getLibrary();
    const row = db.prepare(`SELECT embedding FROM tools WHERE slug = ?`).get(slug) as { embedding: Buffer } | undefined;
    return row ? bufferToEmbedding(row.embedding) : null;
}

export interface ListToolsOptions {
    source?: ToolSource;
    includeArchived?: boolean;
}

export function listTools(opts: ListToolsOptions = {}): ToolMetadata[] {
    const db = getLibrary();
    const conds: string[] = [];
    const args: any[] = [];

    if (!opts.includeArchived) conds.push("archived_at IS NULL");
    if (opts.source) {
        conds.push("source = ?");
        args.push(opts.source);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM tools ${where} ORDER BY slug ASC`).all(...args) as ToolRow[];
    return rows.map(rowToMetadata);
}

export interface ToolCounts {
    total: number;
    active: number;
    archived: number;
    graduated: number;
    published: number;
}

export function countTools(): ToolCounts {
    const db = getLibrary();
    const row = db
        .prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN archived_at IS NULL AND graduated_at IS NULL AND published_at IS NULL THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
            SUM(CASE WHEN graduated_at IS NOT NULL AND published_at IS NULL THEN 1 ELSE 0 END) AS graduated,
            SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS published
        FROM tools
    `)
        .get() as {
        total: number;
        active: number | null;
        archived: number | null;
        graduated: number | null;
        published: number | null;
    };
    return {
        total: row.total,
        active: row.active ?? 0,
        archived: row.archived ?? 0,
        graduated: row.graduated ?? 0,
        published: row.published ?? 0,
    };
}

export interface FTSSearchResult {
    slug: string;
    bm25Score: number;
}

export function searchByFTS(query: string, limit: number = 20): FTSSearchResult[] {
    const db = getLibrary();
    // Sanitize: strip quote chars and FTS5 operator punctuation, collapse whitespace.
    // Then append `*` to each token so `table` matches `tables`, `extract` matches
    // `extracting`, etc. — important because the unicode61 tokenizer does not stem.
    const tokens = query
        .replace(/['"():^*+\-]/g, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => `${t}*`);
    if (tokens.length === 0) return [];
    const cleaned = tokens.join(" ");

    // bm25() returns negative magnitudes; smaller = better.
    // Contentless FTS5 (content='') returns NULL for any column except rowid, so
    // we JOIN on rowid and pull `slug` from the main `tools` table. The two rowids
    // align because Phase 1's insertTool writes both rows in the same transaction
    // and we never hard-delete from `tools` (archive is soft via archived_at).
    const rows = db
        .prepare(`
        SELECT tools.slug AS slug, bm25(tools_fts) AS score
        FROM tools_fts
        JOIN tools ON tools.rowid = tools_fts.rowid
        WHERE tools_fts MATCH ? AND tools.archived_at IS NULL
        ORDER BY score ASC
        LIMIT ?
    `)
        .all(cleaned, limit) as { slug: string; score: number }[];

    return rows.map((r) => ({ slug: r.slug, bm25Score: r.score }));
}
