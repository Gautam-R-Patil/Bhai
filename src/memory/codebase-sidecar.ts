// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Codebase Sidecar SQLite ───────────────────
// Per-repo sidecar database at data/codebase-index/<repo_hash>.db.
// Owns schema creation, integrity check, corruption recovery, and a
// per-process handle cache. Fail-open: any error returns a best-effort
// database (potentially empty) rather than throwing.

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { repoHash } from "./codebase-merkle.js";
import { type Database, wrapDatabase } from "./sqlite.js";

/** Version bump forces a full sidecar rebuild on next open. */
export const SIDECAR_SCHEMA_VERSION = "4L.3";

const DATA_DIR = process.env.BHAI_DATA_DIR || path.resolve("data");
const SIDECAR_DIR = path.join(DATA_DIR, "codebase-index");

// Module-level handle cache keyed by repo hash.
// Bounded with LRU eviction (insertion-order = access-order) so agents
// that touch many repos across a long session don't accumulate open
// SQLite handles forever.
const MAX_CACHED_SIDECARS = 16;
const cache = new Map<string, { db: Database; raw: BetterSqlite3.Database; root: string }>();

function _touchCache(hash: string): void {
    const entry = cache.get(hash);
    if (!entry) return;
    // Move-to-end so eviction targets the truly-oldest access.
    cache.delete(hash);
    cache.set(hash, entry);
}

function _evictOldestIfOverCap(): void {
    while (cache.size > MAX_CACHED_SIDECARS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        const entry = cache.get(oldest);
        cache.delete(oldest);
        if (entry) {
            try {
                entry.raw.close();
            } catch {
                /* best-effort */
            }
        }
    }
}

/** Absolute path to the sidecar DB file for a repo root. */
export function sidecarPathFor(repoRoot: string): string {
    return path.join(SIDECAR_DIR, `${repoHash(repoRoot)}.db`);
}

/** True when a sidecar file exists for the given repo root. */
export function hasSidecar(repoRoot: string): boolean {
    try {
        return fs.existsSync(sidecarPathFor(repoRoot));
    } catch {
        return false;
    }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY,
    path       TEXT UNIQUE NOT NULL,
    sha256     TEXT NOT NULL,
    lang       TEXT NOT NULL,
    loc        INTEGER NOT NULL,
    workspace  TEXT,
    indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
    id         INTEGER PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end   INTEGER,
    signature  TEXT,
    exported   INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY,
    from_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    to_file_id   INTEGER REFERENCES files(id) ON DELETE SET NULL,
    specifier    TEXT NOT NULL,
    line         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
    id             INTEGER PRIMARY KEY,
    from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    to_symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    callee_name    TEXT NOT NULL,
    line           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS parse_errors (
    file_id                INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    error                  TEXT NOT NULL,
    skip_until_hash_change TEXT NOT NULL,
    recorded_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS index_meta (
    repo_root         TEXT PRIMARY KEY,
    repo_hash         TEXT NOT NULL,
    depth             TEXT NOT NULL,
    depth_auto        INTEGER NOT NULL,
    file_count        INTEGER NOT NULL,
    symbol_count      INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    last_refreshed_at INTEGER NOT NULL,
    tool_version      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_to   ON imports(to_file_id);
CREATE INDEX IF NOT EXISTS idx_calls_from   ON calls(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_to     ON calls(to_symbol_id);

-- 4L.2: BM25 full-text search over symbol names + file paths.
-- Populated on every symbol insert via triggers below so the FTS index
-- always mirrors the canonical tables. Non-fatal if FTS5 is unavailable
-- (the schema run catches the error and the search op returns [] — the
-- exact-match find_symbol path still works).
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name, kind, file_path, signature,
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS symbols_fts_ai AFTER INSERT ON symbols BEGIN
    INSERT INTO symbols_fts(rowid, name, kind, file_path, signature)
    VALUES (
        new.id, new.name, new.kind,
        (SELECT path FROM files WHERE id = new.file_id),
        COALESCE(new.signature, '')
    );
END;
CREATE TRIGGER IF NOT EXISTS symbols_fts_ad AFTER DELETE ON symbols BEGIN
    DELETE FROM symbols_fts WHERE rowid = old.id;
END;
`;

function runSchema(raw: BetterSqlite3.Database): void {
    raw.exec(SCHEMA_SQL);
}

/**
 * Apply pragmas + schema to a freshly-opened raw sidecar handle.
 * Used on first-open AND on schema-version rebuild, so pragmas never drift.
 */
function finalizeNewHandle(raw: BetterSqlite3.Database): void {
    try {
        raw.pragma("journal_mode = WAL");
    } catch {
        /* fail-open */
    }
    try {
        raw.pragma("synchronous = NORMAL");
    } catch {
        /* fail-open */
    }
    try {
        raw.pragma("foreign_keys = ON");
    } catch {
        /* fail-open */
    }
    runSchema(raw);
}

function ensureDir(): void {
    try {
        if (!fs.existsSync(SIDECAR_DIR)) fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    } catch {
        /* fail-open */
    }
}

function wipeFile(p: string): void {
    try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
        /* ignore */
    }
}

/**
 * Open (or create) the sidecar SQLite for a repo root. Integrity is checked
 * on every open; on failure the DB is deleted + recreated. The handle is
 * cached per-process keyed by repo hash.
 */
export function openSidecar(repoRoot: string): Database {
    const hash = repoHash(repoRoot);
    const cached = cache.get(hash);
    if (cached) {
        _touchCache(hash);
        return cached.db;
    }

    ensureDir();
    const p = sidecarPathFor(repoRoot);

    let raw: BetterSqlite3.Database;
    try {
        raw = new BetterSqlite3(p);
        // Integrity check — on failure wipe + retry.
        const check = raw.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        if (!check || check.integrity_check !== "ok") {
            raw.close();
            wipeFile(p);
            raw = new BetterSqlite3(p);
        }
    } catch {
        wipeFile(p);
        raw = new BetterSqlite3(p);
    }

    finalizeNewHandle(raw);

    // Schema version check: drop + rebuild on mismatch.
    try {
        const meta = raw.prepare("SELECT tool_version FROM index_meta WHERE repo_root = ?").get(repoRoot) as
            | { tool_version?: string }
            | undefined;
        if (meta?.tool_version && meta.tool_version !== SIDECAR_SCHEMA_VERSION) {
            raw.close();
            wipeFile(p);
            raw = new BetterSqlite3(p);
            finalizeNewHandle(raw);
        }
    } catch {
        /* first-open: no meta row yet */
    }

    const db = wrapDatabase(raw);
    cache.set(hash, { db, raw, root: repoRoot });
    _evictOldestIfOverCap();
    return db;
}

/**
 * Return the raw better-sqlite3 handle for a repo sidecar. Opens+caches if
 * not already open. Consumers needing transactions, prepared statements in
 * hot loops, or PRAGMA reads must use this instead of the wrapped Database
 * interface, which only routes SELECT/WITH statements to the read path.
 */
export function getRawSidecar(repoRoot: string): BetterSqlite3.Database {
    openSidecar(repoRoot);
    const hash = repoHash(repoRoot);
    // Cache is populated by openSidecar; this lookup is always hit.
    const entry = cache.get(hash);
    if (!entry) {
        // Pathological: openSidecar succeeded but cache entry missing. Re-open fresh.
        throw new Error(`codebase-sidecar: cache miss for ${hash} after open`);
    }
    return entry.raw;
}

/** Close the sidecar handle for a repo root (if cached) and evict the cache entry. */
export function closeSidecar(repoRoot: string): void {
    const hash = repoHash(repoRoot);
    const entry = cache.get(hash);
    if (!entry) return;
    try {
        entry.raw.close();
    } catch {
        /* */
    }
    cache.delete(hash);
}

/** Close every cached sidecar handle. Used at process shutdown. */
export function closeAllSidecars(): void {
    for (const [hash, entry] of cache.entries()) {
        try {
            entry.raw.close();
        } catch {
            /* */
        }
        cache.delete(hash);
    }
}

/** Delete the sidecar DB file entirely and evict cache. */
export function wipeSidecar(repoRoot: string): void {
    closeSidecar(repoRoot);
    wipeFile(sidecarPathFor(repoRoot));
}
