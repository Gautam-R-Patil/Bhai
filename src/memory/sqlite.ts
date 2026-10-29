// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { getDimensionValue } from "../harness/registry.js";
import type { LLMClient } from "../llm.js";
import {
    bufferToEmbedding,
    cosineSimilarity,
    embeddingToBuffer,
    embedText,
    getEffectiveDimension,
    isReady as isEmbeddingReady,
    warmup as warmupEmbeddings,
} from "./embeddings.js";
import { getCurrentEmotionalIntensity } from "./emotional.js";
import { CONVERSATIONS_FTS_SYNC_SQL, MEMORIES_FTS_SYNC_SQL } from "./fts-triggers.js";
import { buildTrigramQuery, containsCjk, sanitizeFts5Query } from "./fts5-query.js";
import { logGateDecision } from "./gate-audit.js";
import { boostMemory } from "./self-evolving.js";
import { spreadActivation } from "./spreading-activation.js";
import { getTemporalCache } from "./temporal-cache.js";
import { gateVerdict, llmGate, threatReject } from "./value-gate.js";
// ── Brain-Inspired Module Imports ─────────────
import { buildIndexFromDB, getHNSWIndex } from "./vector-index.js";

// ── Constants ─────────────────────────────────

const DATA_DIR = process.env.ATLAS_DATA_DIR || path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "memory.db");

// ── Module-level LLM client for smart memory writes ──
// Set via setMemoryLLM() at boot; used by remember() when smartWrite=true.
let memoryLLM: LLMClient | null = null;

/** Inject the LLM client for smart memory write decisions (call once at boot). */
export function setMemoryLLM(llm: LLMClient): void {
    memoryLLM = llm;
}

// ── Compatibility wrapper ─────────────────────
// Wraps better-sqlite3 to expose the same .exec() / .run() interface
// that all memory modules expect (originally from sql.js).

export interface ExecResult {
    columns: string[];
    values: unknown[][];
}

export interface CompatDatabase {
    exec(sql: string, params?: unknown[]): ExecResult[];
    run(sql: string, params?: unknown[]): void;
    close(): void;
}

export function wrapDatabase(raw: BetterSqlite3.Database): CompatDatabase {
    return {
        exec(sql: string, params: unknown[] = []): ExecResult[] {
            const isRead =
                sql.trim().toUpperCase().startsWith("SELECT") ||
                sql.trim().toUpperCase().startsWith("WITH") ||
                sql.includes("last_insert_rowid") ||
                sql.includes("changes()");
            try {
                const stmt = raw.prepare(sql);
                if (isRead) {
                    const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
                    if (rows.length === 0) return [];
                    const columns = Object.keys(rows[0] as Record<string, unknown>);
                    const values = rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c]));
                    return [{ columns, values }];
                }
                if (params.length > 0) stmt.run(...params);
                else stmt.run();
                return [];
            } catch (err) {
                // Reads can return an empty set on failure — the caller checks
                // row length either way. WRITES cannot fail silently: user data
                // would be lost. Mirror run()'s semantics: swallow "already
                // exists" schema errors only, rethrow everything else.
                if (isRead) return [];
                const msg = (err as Error).message || "";
                if (msg.includes("already exists") || msg.includes("duplicate column")) {
                    return [];
                }
                throw err;
            }
        },
        run(sql: string, params: unknown[] = []): void {
            try {
                const stmt = raw.prepare(sql);
                if (params.length > 0) stmt.run(...params);
                else stmt.run();
            } catch (err) {
                // Silently handle "already exists" errors for CREATE TABLE IF NOT EXISTS
                const msg = (err as Error).message || "";
                if (!msg.includes("already exists") && !msg.includes("duplicate column")) {
                    throw err;
                }
            }
        },
        close(): void {
            raw.close();
        },
    };
}

// Re-export the wrapper type as "Database" for all other modules
export type Database = CompatDatabase;

// ── Singleton ─────────────────────────────────

let db: CompatDatabase | null = null;
let rawDb: BetterSqlite3.Database | null = null;

// ── Transaction Helpers ───────────────────────
// Wrap multi-statement loops in begin/commit for 10-50x speedup

export function beginTransaction(): void {
    if (rawDb) rawDb.exec("BEGIN");
}

export function commitTransaction(): void {
    if (rawDb) rawDb.exec("COMMIT");
}

export function rollbackTransaction(): void {
    if (rawDb) rawDb.exec("ROLLBACK");
}

// ── Initialize ────────────────────────────────

export async function initMemoryDB(): Promise<CompatDatabase> {
    if (db) return db;

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    rawDb = new BetterSqlite3(DB_PATH);

    // WAL mode for performance
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("synchronous = NORMAL"); // Safe with WAL, reduces fsync
    rawDb.pragma("cache_size = -64000"); // 64MB page cache (default is only 2MB)
    rawDb.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
    rawDb.pragma("temp_store = MEMORY"); // Temp tables in memory
    rawDb.pragma("journal_size_limit = 67108864"); // 64MB WAL file limit

    db = wrapDatabase(rawDb);

    // Create tables
    db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      tags TEXT DEFAULT '',
      importance INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now')),
      accessed_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      decay_score REAL DEFAULT 1.0
    )
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

    // ── Safe migrations ──
    try {
        db.run("ALTER TABLE memories ADD COLUMN cluster_id TEXT DEFAULT NULL");
    } catch {
        /* exists */
    }
    try {
        db.run("ALTER TABLE memories ADD COLUMN tier TEXT DEFAULT 'hot'");
    } catch {
        /* exists */
    }
    try {
        db.run("ALTER TABLE memories ADD COLUMN reconsolidation_tags TEXT DEFAULT '[]'");
    } catch {
        /* exists */
    }
    try {
        db.run("ALTER TABLE memories ADD COLUMN consolidated_into INTEGER DEFAULT NULL");
    } catch {
        /* exists */
    }
    // Provenance tracking — know where each memory came from
    try {
        db.run("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'user'");
    } catch {
        /* exists */
    }
    try {
        db.run("ALTER TABLE memories ADD COLUMN emotional_valence TEXT DEFAULT NULL");
    } catch {
        /* exists */
    }
    // Scope chains — memory visibility scoping (global, user:X, session:X, task:X)
    try {
        db.run("ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT 'global'");
    } catch {
        /* exists */
    }
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
    } catch {
        /* */
    }
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier)");
    } catch {
        /* */
    }
    // Memory Studio — pinned flag exempts a memory from decay/prune.
    try {
        db.run("ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0");
    } catch {
        /* exists */
    }
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1");
    } catch {
        /* */
    }
    // The old surprise gate stored decay_score up to 1.5, so routine
    // importance-5 rows outranked importance-7 ones. 1.0 is the cap.
    try {
        db.run("UPDATE memories SET decay_score = 1.0 WHERE decay_score > 1.0");
    } catch {
        /* */
    }
    // Memory Studio — append-only tombstone log so "forget with reason"
    // keeps an audit trail without forcing soft-delete filters everywhere.
    db.run(`
    CREATE TABLE IF NOT EXISTS memory_forget_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      original_id TEXT NOT NULL,
      content_snapshot TEXT,
      reason TEXT NOT NULL,
      source TEXT DEFAULT 'user',
      forgotten_at TEXT DEFAULT (datetime('now'))
    )
  `);
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_forget_log_kind ON memory_forget_log(kind, forgotten_at)");
    } catch {
        /* */
    }
    // Memory Studio — AI-derived insight cards. One row per kind per
    // computation; the renderer reads the latest of each kind.
    db.run(`
    CREATE TABLE IF NOT EXISTS memory_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      metric_value REAL,
      metric_unit TEXT,
      computed_at TEXT DEFAULT (datetime('now')),
      window_days INTEGER DEFAULT 7
    )
  `);
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_insights_computed ON memory_insights(computed_at DESC)");
    } catch {
        /* */
    }
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_insights_kind ON memory_insights(kind, computed_at DESC)");
    } catch {
        /* */
    }

    // ── Embeddings table (for semantic/vector search) ──
    db.run(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'all-MiniLM-L6-v2',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
    try {
        db.run("ALTER TABLE memory_embeddings ADD COLUMN context_embedding BLOB DEFAULT NULL");
    } catch {
        /* exists */
    }
    try {
        db.run("ALTER TABLE memory_embeddings ADD COLUMN embedding_version INTEGER DEFAULT 1");
    } catch {
        /* exists */
    }

    // ── Episodic & Conversation embeddings (vector-enhanced search) ──
    db.run(`
    CREATE TABLE IF NOT EXISTS episodic_embeddings (
      episode_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS conversation_embeddings (
      conversation_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
    try {
        db.run("ALTER TABLE conversation_embeddings ADD COLUMN embedding_version INTEGER DEFAULT 1");
    } catch {
        /* exists */
    }
    try {
        db.run("ALTER TABLE episodic_embeddings ADD COLUMN embedding_version INTEGER DEFAULT 1");
    } catch {
        /* exists */
    }

    // ── Embedding migration state (tracks v1→v2 upgrade progress) ──
    db.run(`
    CREATE TABLE IF NOT EXISTS embedding_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_version INTEGER NOT NULL DEFAULT 1,
      target_version INTEGER NOT NULL DEFAULT 2,
      total_memories INTEGER DEFAULT 0,
      migrated_memories INTEGER DEFAULT 0,
      total_conversations INTEGER DEFAULT 0,
      migrated_conversations INTEGER DEFAULT 0,
      total_episodes INTEGER DEFAULT 0,
      migrated_episodes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

    // ── Mesh Checkpoint table (for resumable DAG execution) ──
    db.run(`
    CREATE TABLE IF NOT EXISTS mesh_checkpoints (
      mesh_id TEXT PRIMARY KEY,
      task_description TEXT NOT NULL,
      completed_steps TEXT NOT NULL DEFAULT '[]',
      step_results TEXT NOT NULL DEFAULT '{}',
      pending_steps TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    // ── Performance indexes ──
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)");
    } catch {
        /* */
    }
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_bt_confidence ON behavioral_traits(confidence)");
    } catch {
        /* table may not exist yet */
    }

    // ── Additional performance indexes (optimization) ──
    // Index for decay-based queries (consolidation, cleanup)
    try {
        db.run(
            "CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_score) WHERE consolidated_into IS NULL",
        );
    } catch {
        /* */
    }
    // Composite index for user-specific temporal queries
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_episodic_user_ts ON episodic_memory(user_id, timestamp)");
    } catch {
        /* */
    }
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_emotional_user_ts ON emotional_memory(user_id, timestamp)");
    } catch {
        /* */
    }
    // Index for importance-based retrieval
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)");
    } catch {
        /* */
    }
    // Index for access patterns (LRU-style queries)
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at)");
    } catch {
        /* */
    }
    // Index for embedding model lookups
    try {
        db.run("CREATE INDEX IF NOT EXISTS idx_embeddings_model ON memory_embeddings(model)");
    } catch {
        /* */
    }

    // ── Living Continuity tables ──
    db.run(`
    CREATE TABLE IF NOT EXISTS self_state (
      user_id TEXT PRIMARY KEY,
      energy_level REAL DEFAULT 0.7,
      engagement_mode TEXT DEFAULT 'supportive',
      confidence_in_user_model REAL DEFAULT 0.3,
      relationship_depth REAL DEFAULT 0.1,
      recent_emotional_tone TEXT DEFAULT 'neutral',
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`
    CREATE TABLE IF NOT EXISTS emotional_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      emotion TEXT NOT NULL,
      context TEXT NOT NULL,
      intensity REAL DEFAULT 0.5,
      timestamp TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      importance_score REAL DEFAULT 0.5,
      timestamp TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`
    CREATE TABLE IF NOT EXISTS relationship_state (
      user_id TEXT PRIMARY KEY,
      trust_score REAL DEFAULT 0.3,
      engagement_streak INTEGER DEFAULT 0,
      depth_score REAL DEFAULT 0.1,
      last_interaction TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`
    CREATE TABLE IF NOT EXISTS trait_edges (
      trait_a TEXT NOT NULL,
      trait_b TEXT NOT NULL,
      weight REAL DEFAULT 0.1,
      correlation_count INTEGER DEFAULT 1,
      PRIMARY KEY(trait_a, trait_b)
    )`);

    db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      current_goal TEXT DEFAULT '',
      started_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      turn_count INTEGER DEFAULT 0,
      short_summary TEXT DEFAULT '',
      recent_turns_json TEXT DEFAULT '[]'
    )`);

    // Persist the last structured compression summary so the next prune
    // continues the numbered Completed Actions instead of cold-restarting.
    try {
        db.run("ALTER TABLE sessions ADD COLUMN last_compression_summary TEXT DEFAULT ''");
    } catch {
        /* exists */
    }

    // ── FTS5 with Porter stemmer + Unicode tokenizer (Hybrid Search) ──
    // Standalone FTS5 table (not external-content mode) with porter stemming
    // for better keyword recall. Synced via triggers + explicit INSERT in remember().
    try {
        // Drop old external-content FTS5 table if it exists (migration from content-linked mode)
        // Detection: try to read the FTS5 config; if content= is set, it's the old format
        let needsFtsMigration = false;
        try {
            if (rawDb) {
                // External-content tables have a config entry; standalone tables do not
                const configCheck = rawDb.prepare("SELECT * FROM memories_fts_config WHERE k = 'content'").get() as
                    | { k: string; v: string }
                    | undefined;
                if (configCheck && configCheck.v === "memories") {
                    needsFtsMigration = true;
                }
            }
        } catch {
            /* table may not exist at all — that's fine, we'll create it */
        }

        if (needsFtsMigration) {
            console.log("[FTS5] Migrating from external-content to standalone porter-stemmed FTS5...");
            try {
                if (rawDb) {
                    rawDb.exec("DROP TRIGGER IF EXISTS memories_ai");
                    rawDb.exec("DROP TRIGGER IF EXISTS memories_ad");
                    rawDb.exec("DROP TRIGGER IF EXISTS memories_au");
                    rawDb.exec("DROP TABLE IF EXISTS memories_fts");
                }
            } catch {
                /* best effort cleanup */
            }
        }

        db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, category, tags,
          tokenize='porter unicode61'
        )
      `);

        // Trigram FTS5 table for CJK + arbitrary-substring search.
        // unicode61 splits CJK into single-character tokens (so a query like
        // "大别山项目" degenerates to 5 individual tokens chained by AND and
        // misses phrase matches). The trigram tokenizer emits overlapping
        // 3-byte windows so multi-character CJK phrases and mid-word matches
        // ("config" in "config.yaml") both work.
        db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_trigram USING fts5(
          content, category, tags,
          tokenize='trigram'
        )
      `);

        // Triggers keep BOTH FTS5 tables in sync automatically.
        db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT OR REPLACE INTO memories_fts(rowid, content, category, tags)
          VALUES (new.id, new.content, new.category, new.tags);
          INSERT OR REPLACE INTO memories_fts_trigram(rowid, content, category, tags)
          VALUES (new.id, new.content, new.category, new.tags);
        END
      `);

        // Delete/update sync — see fts-triggers.ts (replaces broken older bodies).
        if (rawDb) rawDb.exec(MEMORIES_FTS_SYNC_SQL);

        // Pruned-context facts used to be filed as session_summary (now 'fact'), and
        // recall used to bump summary importance on every read. Both are no-ops once
        // applied. Runs after the trigger sync: the old update trigger failed every UPDATE.
        try {
            db.run(
                "UPDATE memories SET category = 'fact' WHERE category = 'session_summary' AND tags LIKE 'context_pruning%'",
            );
            db.run("UPDATE memories SET importance = 6 WHERE category = 'session_summary' AND importance > 6");
        } catch {
            /* */
        }

        // Backfill both FTS5 tables from existing memories (idempotent).
        backfillFTS5();

        // ── Conversation transcript search (session_search) ──
        // Per-message decomposition + FTS5 over raw transcript content.
        // Gated by ATLAS_NO_SESSION_SEARCH; shares this try/catch fail-open.
        if (process.env.ATLAS_NO_SESSION_SEARCH !== "true") {
            initConversationSearchSchema(rawDb);
            backfillConversationMessages();
        }

        console.log("🧠 Memory database initialized (WAL + FTS5 porter+trigram + Living Continuity)");
    } catch (err) {
        console.log("🧠 Memory database initialized (WAL + Living Continuity, FTS5 setup failed)");
        console.error("  FTS5 error:", (err as Error).message);
    }

    const gateDisabled = process.env.ATLAS_NO_MEMORY_GATE === "true";
    const shadow = process.env.ATLAS_MEMORY_GATE_SHADOW !== "false";
    if (gateDisabled) {
        console.log("[MEMORY] Value-gate: DISABLED (ATLAS_NO_MEMORY_GATE=true)");
    } else if (shadow) {
        console.log(
            "[MEMORY] Value-gate: SHADOW (decisions logged to data/memory-gate.jsonl, all writes still insert)",
        );
    } else {
        console.log("[MEMORY] Value-gate: ENFORCING");
    }

    // ── Build HNSW index from existing embeddings (async, non-blocking) ──
    if (rawDb) {
        buildIndexFromDB(rawDb).catch((err) =>
            console.warn("[HNSW] Index build failed (non-fatal):", (err as Error).message),
        );
    }

    initProactiveSchema(db);
    initMarketingDB(db);

    return db;
}

// ── Proactive Subsystem Schema ────────────────────────────────

/**
 * Creates the three SQLite tables needed by the proactive messaging pipeline.
 * Safe to call multiple times — all statements use CREATE TABLE/INDEX IF NOT EXISTS.
 * Called automatically by initMemoryDB(); also exported for isolated unit tests.
 *
 * Timestamp convention: these tables use INTEGER (unix epoch ms) rather than
 * TEXT datetime('now') like the older tables above. The proactive subsystem's
 * TS types (ProactiveIntent.createdAt, ProactiveOutcome.dispatchedAt) are
 * numbers, so storing them as INTEGER avoids per-read parsing.
 *
 * proactive_outcomes is intentionally an append-only log (no PRIMARY KEY on
 * intent_id): a single intent produces multiple rows as it moves
 * enqueued → released → dispatched, plus later rows recording user replies.
 * Aggregations read by (source, channel) via idx_outcomes_source_channel.
 */
export function initProactiveSchema(db: CompatDatabase): void {
    db.run(`
    CREATE TABLE IF NOT EXISTS monitor_rules (
      id TEXT PRIMARY KEY,
      user_phrase TEXT NOT NULL,
      topic TEXT NOT NULL,
      topic_embedding BLOB NOT NULL,
      scope_json TEXT NOT NULL,
      urgency TEXT NOT NULL,
      action_json TEXT NOT NULL,
      threshold REAL NOT NULL,
      cooldown_minutes INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      intent_id TEXT PRIMARY KEY,
      intent_json TEXT NOT NULL,
      status TEXT NOT NULL,
      composed_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      user_action_at INTEGER,
      user_action TEXT,
      edited_text TEXT,
      execution_status TEXT,
      execution_result TEXT
    )
  `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, created_at)`);
    // ── Safe migration: add deferred_until column (Phase 4.1) ──
    try {
        db.run(`ALTER TABLE inbox_items ADD COLUMN deferred_until INTEGER`);
    } catch {
        /* column already exists */
    }
    db.run(`
    CREATE TABLE IF NOT EXISTS proactive_outcomes (
      intent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      channel TEXT NOT NULL,
      decision TEXT NOT NULL,
      drop_reason TEXT,
      dispatched_at INTEGER,
      user_replied INTEGER NOT NULL DEFAULT 0,
      user_reply_latency_ms INTEGER,
      user_reply_sentiment TEXT,
      user_marked_useful INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_outcomes_source_channel ON proactive_outcomes(source, channel, created_at)`);
    // ── Safe migrations: add scheduled_for + batch_ids columns (Phase 2) ──
    try {
        db.run(`ALTER TABLE proactive_outcomes ADD COLUMN scheduled_for REAL`);
    } catch {
        /* column already exists */
    }
    try {
        db.run(`ALTER TABLE proactive_outcomes ADD COLUMN batch_ids TEXT`);
    } catch {
        /* column already exists */
    }
}

// ── FTS5 Backfill ────────────────────────────────

/**
 * Populate the FTS5 index from existing memories.
 * Safe to call multiple times — uses INSERT OR IGNORE semantics
 * by checking what's already indexed.
 */
export function backfillFTS5(): void {
    if (!rawDb) return;

    try {
        // Count existing rows across the unicode61 and trigram FTS tables.
        const ftsCount = rawDb.prepare("SELECT COUNT(*) as c FROM memories_fts").get() as { c: number } | undefined;
        let trigramExists = true;
        let trigramN = 0;
        try {
            const trigramCount = rawDb.prepare("SELECT COUNT(*) as c FROM memories_fts_trigram").get() as
                | { c: number }
                | undefined;
            trigramN = trigramCount?.c ?? 0;
        } catch {
            trigramExists = false;
        }

        const memCount = rawDb.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number } | undefined;

        const ftsN = ftsCount?.c ?? 0;
        const memN = memCount?.c ?? 0;

        const unicodeSynced = ftsN >= memN && memN > 0;
        const trigramSynced = !trigramExists || (trigramN >= memN && memN > 0);

        if (unicodeSynced && trigramSynced) {
            console.log(`  [FTS5] Indexes already synced (unicode61=${ftsN}, trigram=${trigramN}, memories=${memN})`);
            return;
        }

        if (!unicodeSynced) {
            rawDb.exec("DELETE FROM memories_fts");
            rawDb.exec(
                "INSERT INTO memories_fts(rowid, content, category, tags) SELECT id, content, category, tags FROM memories",
            );
        }
        if (trigramExists && !trigramSynced) {
            rawDb.exec("DELETE FROM memories_fts_trigram");
            rawDb.exec(
                "INSERT INTO memories_fts_trigram(rowid, content, category, tags) SELECT id, content, category, tags FROM memories",
            );
        }

        const finalUni = rawDb.prepare("SELECT COUNT(*) as c FROM memories_fts").get() as { c: number } | undefined;
        const finalTri = trigramExists
            ? ((rawDb.prepare("SELECT COUNT(*) as c FROM memories_fts_trigram").get() as { c: number } | undefined)
                  ?.c ?? 0)
            : 0;

        console.log(
            `  [FTS5] Backfilled unicode61=${finalUni?.c ?? 0}, trigram=${finalTri} (porter unicode61 + trigram)`,
        );
    } catch (err) {
        console.warn("[FTS5] Backfill failed (non-fatal):", (err as Error).message);
    }
}

// ── Conversation Transcript Search (session_search) ───────────
// Per-message decomposition of conversations.messages_json into
// conversation_messages, mirrored into FTS5 (porter + trigram) for
// zero-LLM BM25 keyword recall of what was literally said in past sessions.

export interface SessionMessageHit {
    conversation_id: number;
    session_id: string;
    role: string;
    snippet: string;
    content: string;
    created_at: string | null;
    rank: number;
}

/**
 * Coalesce an OpenAI ChatCompletionMessageParam content into plain text.
 * - string → as-is
 * - array of content-parts → join the `.text` of `type:"text"` parts
 * - null / tool-call-only / non-text → "" (caller skips empties)
 */
export function extractMsgText(msg: unknown): string {
    if (typeof msg !== "object" || msg === null) return "";
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const p of content) {
            if (
                typeof p === "object" &&
                p !== null &&
                (p as { type?: unknown }).type === "text" &&
                typeof (p as { text?: unknown }).text === "string"
            ) {
                parts.push((p as { text: string }).text);
            }
        }
        return parts.join("\n").trim();
    }
    return "";
}

export function getMsgRole(msg: unknown): string {
    if (typeof msg !== "object" || msg === null) return "unknown";
    const r = (msg as { role?: unknown }).role;
    return typeof r === "string" ? r : "unknown";
}

/**
 * Creates the conversation_messages backing table + the two FTS5 mirrors
 * (porter unicode61 + trigram) and their sync triggers. Idempotent
 * (CREATE ... IF NOT EXISTS). Exported so unit tests exercise the real DDL.
 */
export function initConversationSearchSchema(raw: BetterSqlite3.Database): void {
    raw.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      msg_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT,
      UNIQUE(conversation_id, msg_index)
    )`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_convmsg_conv ON conversation_messages(conversation_id)`);
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_convmsg_created ON conversation_messages(created_at DESC)`);

    raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
      content, role, session_id UNINDEXED,
      tokenize='porter unicode61'
    )`);
    raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts_trigram USING fts5(
      content, role, session_id UNINDEXED,
      tokenize='trigram'
    )`);

    raw.exec(`
    CREATE TRIGGER IF NOT EXISTS conv_msg_ai AFTER INSERT ON conversation_messages BEGIN
      INSERT OR REPLACE INTO conversations_fts(rowid, content, role, session_id)
      VALUES (new.id, new.content, new.role, new.session_id);
      INSERT OR REPLACE INTO conversations_fts_trigram(rowid, content, role, session_id)
      VALUES (new.id, new.content, new.role, new.session_id);
    END`);
    raw.exec(CONVERSATIONS_FTS_SYNC_SQL); // see fts-triggers.ts
}

/**
 * Append each non-empty text message of a conversation as a conversation_messages
 * row; triggers populate the FTS5 mirrors. Re-indexing a session's grown (or
 * pruned) history only adds messages not already stored for that conversation,
 * so positions shifting under pruning never drop or duplicate rows. Used by
 * reflection.ts for immediate write-side indexing and by backfill.
 */
export function indexConversationMessages(
    conversationId: number,
    sessionId: string,
    messages: unknown[],
    createdAt?: string | null,
): number {
    if (!rawDb || !Array.isArray(messages)) return 0;
    const stmt = rawDb.prepare(
        `INSERT INTO conversation_messages (conversation_id, session_id, msg_index, role, content, created_at)
         SELECT @conv, @sid, (SELECT COALESCE(MAX(msg_index), -1) + 1 FROM conversation_messages WHERE conversation_id = @conv),
                @role, @content, COALESCE(@created, datetime('now'))
         WHERE NOT EXISTS (SELECT 1 FROM conversation_messages WHERE conversation_id = @conv AND role = @role AND content = @content)`,
    );
    let inserted = 0;
    for (const m of messages) {
        const content = extractMsgText(m);
        if (!content) continue;
        try {
            inserted += stmt.run({
                conv: conversationId,
                sid: sessionId,
                role: getMsgRole(m),
                content,
                created: createdAt ?? null,
            }).changes;
        } catch {
            /* skip malformed row */
        }
    }
    return inserted;
}

/**
 * Images and audio are not stored: screenshots now reach history as real
 * images, and every reflection would otherwise write full captures of the
 * user's screen into memory.db, indefinitely.
 */
export function withoutMedia<T extends { content?: unknown }>(messages: T[]): T[] {
    return messages.map((m) =>
        Array.isArray(m.content)
            ? {
                  ...m,
                  content: (m.content as Array<{ type?: string }>).map((p) =>
                      p?.type === "image_url" || p?.type === "input_audio"
                          ? { type: "text", text: "[image omitted]" }
                          : p,
                  ),
              }
            : m,
    );
}

/**
 * Housekeeping after decay: strip media that older builds stored in
 * conversations, drop transcripts past ATLAS_TRANSCRIPT_RETENTION_DAYS (unset =
 * keep forever), refresh planner stats, and on the nightly pass VACUUM when over
 * a quarter of the file is free pages.
 */
export function compactMemoryDB(nightly = false): void {
    if (!rawDb) return;
    const raw = rawDb;
    try {
        const media = raw
            .prepare(
                `SELECT id, messages_json FROM conversations
                 WHERE messages_json LIKE '%"type":"image_url"%' OR messages_json LIKE '%"type":"input_audio"%'`,
            )
            .all() as Array<{ id: number; messages_json: string }>;
        if (media.length > 0) {
            const update = raw.prepare("UPDATE conversations SET messages_json = ? WHERE id = ?");
            raw.transaction(() => {
                for (const r of media) {
                    try {
                        update.run(JSON.stringify(withoutMedia(JSON.parse(r.messages_json))), r.id);
                    } catch {
                        /* unparseable row: leave it */
                    }
                }
            })();
            console.log(`[MEMORY][COMPACT] Stripped media from ${media.length} stored conversations`);
        }

        const days = Number.parseInt(process.env.ATLAS_TRANSCRIPT_RETENTION_DAYS ?? "", 10);
        if (days > 0) {
            const old = "SELECT id FROM conversations WHERE COALESCE(updated_at, created_at) < datetime('now', ?)";
            const cutoff = `-${days} days`;
            const removed = raw.transaction(() => {
                // conversation_messages is absent with ATLAS_NO_SESSION_SEARCH.
                if (raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_messages'").get())
                    raw.prepare(`DELETE FROM conversation_messages WHERE conversation_id IN (${old})`).run(cutoff);
                raw.prepare(`DELETE FROM conversation_embeddings WHERE conversation_id IN (${old})`).run(cutoff);
                return raw.prepare(`DELETE FROM conversations WHERE id IN (${old})`).run(cutoff).changes;
            })();
            if (removed > 0) console.log(`[MEMORY][COMPACT] Removed ${removed} transcripts older than ${days} days`);
        }

        raw.pragma("optimize");

        if (nightly) {
            const pages = raw.pragma("page_count", { simple: true }) as number;
            const free = raw.pragma("freelist_count", { simple: true }) as number;
            if (pages > 0 && free > pages * 0.25) {
                raw.exec("VACUUM");
                console.log(`[MEMORY][COMPACT] Vacuumed (${free}/${pages} pages were free)`);
            }
        }
    } catch (err) {
        console.warn("[MEMORY][COMPACT] Failed (non-fatal):", (err as Error).message);
    }
}

/**
 * Backfill conversation_messages from existing conversations rows that have
 * not yet been decomposed. Idempotent (NOT-IN guard). Wrapped in a single
 * transaction for speed; non-fatal on any error.
 */
export function backfillConversationMessages(): void {
    if (!rawDb) return;
    try {
        const rows = rawDb
            .prepare(
                `SELECT id, session_id, messages_json, created_at FROM conversations
                 WHERE id NOT IN (SELECT DISTINCT conversation_id FROM conversation_messages)`,
            )
            .all() as Array<{ id: number; session_id: string; messages_json: string; created_at: string | null }>;

        if (rows.length === 0) {
            console.log("  [session_search] conversation_messages already backfilled");
            return;
        }

        let total = 0;
        beginTransaction();
        try {
            for (const row of rows) {
                try {
                    const parsed = JSON.parse(row.messages_json);
                    if (Array.isArray(parsed)) {
                        total += indexConversationMessages(row.id, row.session_id, parsed, row.created_at);
                    }
                } catch {
                    /* skip malformed messages_json */
                }
            }
            commitTransaction();
        } catch (err) {
            rollbackTransaction();
            throw err;
        }
        console.log(`  [session_search] Backfilled ${total} messages from ${rows.length} conversation(s)`);
    } catch (err) {
        console.warn("[session_search] Backfill failed (non-fatal):", (err as Error).message);
    }
}

/**
 * Keyword search over past conversation transcripts (per-message FTS5 + BM25).
 * Reuses the keywordSearch CJK-routing logic. Returns ACTUAL stored message
 * text with a highlighted snippet. Fail-open: returns [] on any error or
 * missing table — never throws. Zero LLM / zero network.
 */
export function searchSessionMessages(query: string, limit = 10): SessionMessageHit[] {
    if (!rawDb) return [];
    try {
        const rawQuery = (query ?? "").trim();
        if (rawQuery.length < 2) return [];

        const cjk = containsCjk(rawQuery);
        let ftsQuery: string;
        let ftsTable: "conversations_fts" | "conversations_fts_trigram";

        if (cjk) {
            ftsQuery = buildTrigramQuery(rawQuery);
            ftsTable = "conversations_fts_trigram";
            if (!ftsQuery) return [];
        } else {
            const sanitized = sanitizeFts5Query(rawQuery);
            if (!sanitized) return [];
            const stopWords = new Set([
                "a",
                "an",
                "the",
                "is",
                "are",
                "do",
                "you",
                "know",
                "who",
                "what",
                "where",
                "when",
                "why",
                "how",
                "i",
                "am",
                "my",
                "me",
                "to",
                "for",
                "in",
                "on",
                "of",
                "and",
                "or",
                "with",
            ]);
            const tokens: string[] = [];
            const phraseRe = /"[^"]+"|\S+/g;
            for (const m of sanitized.matchAll(phraseRe)) tokens.push(m[0]);
            const terms = tokens.filter((w) => {
                if (w.startsWith('"')) return true;
                const lc = w.toLowerCase();
                return lc.length > 2 && !stopWords.has(lc);
            });
            if (terms.length === 0) return [];
            ftsQuery = terms.join(" OR ");
            ftsTable = "conversations_fts";
        }

        const rows = rawDb
            .prepare(
                `SELECT cm.conversation_id AS conversation_id, cm.session_id AS session_id,
                        cm.role AS role, cm.content AS content, cm.created_at AS created_at,
                        snippet(${ftsTable}, 0, '«', '»', ' … ', 12) AS snip,
                        bm25(${ftsTable}) AS rank
                 FROM ${ftsTable} fts
                 JOIN conversation_messages cm ON cm.id = fts.rowid
                 WHERE ${ftsTable} MATCH ?
                 ORDER BY rank
                 LIMIT ?`,
            )
            .all(ftsQuery, limit) as Array<{
            conversation_id: number;
            session_id: string;
            role: string;
            content: string;
            created_at: string | null;
            snip: string;
            rank: number;
        }>;

        return rows.map((r) => ({
            conversation_id: r.conversation_id,
            session_id: r.session_id,
            role: r.role,
            snippet: r.snip,
            content: r.content,
            created_at: r.created_at,
            rank: r.rank,
        }));
    } catch {
        // Missing table / FTS5 unavailable / malformed query → fail-open.
        return [];
    }
}

/**
 * Browse the most recent conversation messages in reverse-chronological order.
 * No FTS dependency. Fail-open: [] on any error. Zero LLM.
 */
export function browseRecentMessages(limit = 20): SessionMessageHit[] {
    if (!rawDb) return [];
    try {
        const rows = rawDb
            .prepare(
                `SELECT conversation_id, session_id, role, content, created_at
                 FROM conversation_messages
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?`,
            )
            .all(limit) as Array<{
            conversation_id: number;
            session_id: string;
            role: string;
            content: string;
            created_at: string | null;
        }>;
        return rows.map((r) => ({
            conversation_id: r.conversation_id,
            session_id: r.session_id,
            role: r.role,
            snippet: r.content.length > 200 ? `${r.content.slice(0, 200)} …` : r.content,
            content: r.content,
            created_at: r.created_at,
            rank: 0,
        }));
    } catch {
        return [];
    }
}

// ── Memory CRUD ───────────────────────────────

export async function remember(
    content: string,
    category = "general",
    tags = "",
    importance = 5,
    source: "user" | "tool" | "reflection" | "consolidation" = "user",
    smartWrite = false,
    scope: string = "global",
): Promise<number | null> {
    if (!db) throw new Error("Memory DB not initialized");

    const validScope = /^(global|user:.+|session:.+|task:.+)$/.test(scope) ? scope : "global";

    const gateDisabled = process.env.ATLAS_NO_MEMORY_GATE === "true";
    const shadow = process.env.ATLAS_MEMORY_GATE_SHADOW !== "false"; // default ON during rollout

    let gateDecision: "allow" | "reject" = "allow";
    let gateReason = "gate_disabled";
    let gateLogDeferred = false;

    if (!gateDisabled) {
        const threat = threatReject(content);
        if (threat.reject) {
            gateDecision = "reject";
            gateReason = threat.reason;
        } else {
            // gateVerdict orders unconditional rejects → explicit allow → shape
            // rejects, so a curated/high-importance memory that is pure JSON or
            // oversize (e.g. a brand profile) is no longer dropped by hardReject.
            const verdict = gateVerdict(content, source, importance, category);
            if (verdict.verdict === "reject") {
                gateDecision = "reject";
                gateReason = verdict.reason;
            } else {
                if (verdict.verdict === "allow") {
                    gateDecision = "allow";
                    gateReason = verdict.reason;
                } else if (shadow) {
                    // Shadow mode always inserts, so classify in the background
                    // instead of adding LLM latency to every remember().
                    gateLogDeferred = true;
                    llmGate(content, memoryLLM)
                        .then((r) =>
                            logGateDecision({
                                decision: r.decision === "ADD" ? "allow" : "reject",
                                reason: r.reason,
                                source,
                                category,
                                content,
                            }),
                        )
                        .catch(() => {});
                } else {
                    const llmResult = await llmGate(content, memoryLLM);
                    gateDecision = llmResult.decision === "ADD" ? "allow" : "reject";
                    gateReason = llmResult.reason;
                }
            }
        }

        if (!gateLogDeferred) {
            logGateDecision({
                decision: gateDecision,
                reason: gateReason,
                source,
                category,
                content,
            });
        }

        // Shadow mode only defers the soft (LLM value) verdict, which never sets
        // gateDecision. A reject here is threat/binary/oversize/etc: always drop.
        if (gateDecision === "reject") {
            return null;
        }
    }

    // Same fact again: reinforce the stored row instead of adding a copy. Before
    // smart write, whose NOOP/UPDATE path purges the id it is handed.
    const dup = findExactMemory(content, validScope);
    if (dup) {
        db.run(
            "UPDATE memories SET access_count = access_count + 1, accessed_at = datetime('now'), importance = MAX(importance, ?), decay_score = 1.0 WHERE id = ?",
            [Math.min(importance, 10), dup],
        );
        getTemporalCache().clearCache();
        return dup;
    }

    if (smartWrite && memoryLLM && isEmbeddingReady()) {
        const directId = _rememberDirect(content, category, tags, importance, source, validScope);
        _smartWriteDecision(directId, content, category, tags, importance, source).catch((err) =>
            console.warn("[MEMORY][SMART_WRITE] Decision pipeline failed (non-fatal):", (err as Error).message),
        );
        return directId;
    }

    return _rememberDirect(content, category, tags, importance, source, validScope);
}

/** Core synchronous insert — always succeeds regardless of smart write. */
function _rememberDirect(
    content: string,
    category: string,
    tags: string,
    importance: number,
    source: "user" | "tool" | "reflection" | "consolidation",
    scope: string = "global",
): number {
    if (!db) throw new Error("Memory DB not initialized");

    // Boosts are for what the user told us. Auto summaries (reflection, context
    // pruning) were inflated 5–6 → 10 and took the always-injected core slots
    // from facts the user stated.
    const boostable = source === "user" && category !== "session_summary" && category !== "knowledge_crystal";

    // ── Emotional Salience Gating (Amygdala Effect) ──
    // Boost importance for memories stored during high-emotion sessions
    let adjustedImportance = importance;
    if (boostable)
        try {
            const intensity = getCurrentEmotionalIntensity?.() ?? 0;
            if (intensity > 0.6) {
                const boost = 1 + 0.5 * intensity;
                adjustedImportance = Math.min(10, Math.round(importance * boost));
            }
        } catch {
            /* emotional module not loaded yet */
        }

    // At most one step above what was asked, so 8, 9 and 10 stay distinct.
    adjustedImportance = Math.min(adjustedImportance, importance + 1, 10);

    db.run(
        "INSERT INTO memories (content, category, tags, importance, source, decay_score, scope) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [content, category, tags, adjustedImportance, source, 1.0, scope],
    );

    // Get last insert id
    const result = db.exec("SELECT last_insert_rowid() as id");
    const id = (result[0]?.values[0]?.[0] as number) || 0;

    // ── FTS5 sync (belt-and-suspenders with the trigger) ──
    // The trigger handles this too, but explicit insert ensures consistency
    // even if the trigger was dropped during migration.
    if (id > 0) {
        try {
            db.run("INSERT OR REPLACE INTO memories_fts(rowid, content, category, tags) VALUES (?, ?, ?, ?)", [
                id,
                content,
                category,
                tags,
            ]);
        } catch {
            /* FTS5 sync non-fatal — trigger is the backup */
        }
    }

    // Drop cached recall results so a search right after a store sees the new memory.
    getTemporalCache().clearCache();

    // Async: generate embedding, store in DB + HNSW index (non-blocking)
    if (id > 0) {
        embedAndStore(id, content).catch((err) =>
            console.warn(`[MEMORY][EMBED] Failed to embed memory #${id}:`, (err as Error).message),
        );
    }

    return id;
}

/**
 * LLM-driven smart write decision pipeline.
 * Searches for similar existing memories, asks the LLM to decide
 * ADD / UPDATE / DELETE / NOOP, then executes the decision.
 * Runs asynchronously after the direct write — on UPDATE/DELETE/NOOP,
 * it post-hoc cleans up the already-inserted row.
 */
async function _smartWriteDecision(
    newId: number,
    content: string,
    category: string,
    tags: string,
    importance: number,
    _source: "user" | "tool" | "reflection" | "consolidation",
): Promise<void> {
    if (!db || !memoryLLM) return;

    try {
        // 1. Embed the new content and find similar existing memories
        const newEmbedding = await embedText(content, "document");
        const hnswIndex = getHNSWIndex();

        const similarMemories: Array<{
            id: number;
            content: string;
            similarity: number;
            access_count: number;
            importance: number;
        }> = [];

        if (hnswIndex.size > 0) {
            const hits = hnswIndex.search(newEmbedding, 5);
            if (hits.length > 0 && rawDb) {
                const ids = hits.filter((h) => h.id !== newId).map((h) => h.id);
                if (ids.length > 0) {
                    const placeholders = ids.map(() => "?").join(",");
                    const rows = rawDb
                        .prepare(
                            `SELECT id, content, access_count, importance FROM memories
             WHERE id IN (${placeholders}) AND decay_score > 0.2 AND consolidated_into IS NULL`,
                        )
                        .all(...ids) as Array<{
                        id: number;
                        content: string;
                        access_count: number;
                        importance: number;
                    }>;

                    const rowMap = new Map(rows.map((r) => [r.id, r]));

                    for (const hit of hits) {
                        if (hit.id === newId) continue;
                        const row = rowMap.get(hit.id);
                        if (row) {
                            const storedEmb = await _getStoredEmbedding(hit.id);
                            const sim = storedEmb ? cosineSimilarity(newEmbedding, storedEmb) : 1 - hit.distance;
                            if (sim > 0.85) {
                                similarMemories.push({
                                    id: row.id,
                                    content: row.content,
                                    similarity: sim,
                                    access_count: row.access_count,
                                    importance: row.importance,
                                });
                            }
                        }
                    }
                }
            }
        }

        // If no similar memories found, the direct ADD was correct — nothing to do
        if (similarMemories.length === 0) return;

        // 2. Ask the LLM for a decision (use the cheapest/fastest model)
        const top3 = similarMemories.sort((a, b) => b.similarity - a.similarity).slice(0, 3);

        const existingList = top3
            .map(
                (m, i) =>
                    `[${i + 1}] (ID: ${m.id}, similarity: ${m.similarity.toFixed(3)}, accesses: ${m.access_count}) "${m.content}"`,
            )
            .join("\n");

        const decisionPrompt = `You are a memory management system. A new fact is being stored, but similar memories already exist.

NEW FACT: "${content}"
CATEGORY: ${category}
IMPORTANCE: ${importance}

EXISTING SIMILAR MEMORIES:
${existingList}

Decide ONE action:
- ADD: The new fact contains genuinely new information not covered by existing memories.
- UPDATE <ID>: The new fact is an updated version of an existing memory. Specify which ID to update.
- DELETE <ID>: An existing memory is stale/wrong and should be replaced. Specify which ID to mark as stale, then the new fact will replace it.
- NOOP: The new fact is already known — no need to store it.

Respond with ONLY the action keyword (and ID if applicable), e.g.: "UPDATE 42" or "NOOP" or "ADD" or "DELETE 17"`;

        const response = await memoryLLM.chat({
            messages: [{ role: "user", content: decisionPrompt }],
            systemPrompt: "You are a concise memory deduplication engine. Respond with only the action.",
            modelOverride: "openai/gpt-4.1-nano",
        });

        const decision = (response.choices[0]?.message?.content || "ADD").trim().toUpperCase();

        // 3. Execute the decision
        if (decision === "ADD") {
            // Direct write was already correct — keep the new memory
            return;
        }

        if (decision === "NOOP") {
            // Already known — remove the just-inserted duplicate
            try {
                _purgeMemoryRow(newId);
                console.log(`[MEMORY][SMART_WRITE] NOOP: removed duplicate #${newId} (already known)`);
            } catch {
                /* cleanup non-fatal */
            }
            return;
        }

        const idMatch = decision.match(/^(UPDATE|DELETE)\s+(\d+)/);
        if (!idMatch) return; // Unrecognized decision format — keep the ADD

        const action = idMatch[1];
        const targetId = parseInt(idMatch[2], 10);

        // Verify the target ID is one of our similar memories (safety check)
        if (!top3.find((m) => m.id === targetId)) return;

        if (action === "UPDATE") {
            // Update the existing memory's content, bump access_count and importance
            db.run(
                `UPDATE memories SET content = ?, importance = MIN(importance + 1, 10),
         access_count = access_count + 1, accessed_at = datetime('now') WHERE id = ?`,
                [content, targetId],
            );
            // Update FTS5
            try {
                db.run("INSERT OR REPLACE INTO memories_fts(rowid, content, category, tags) VALUES (?, ?, ?, ?)", [
                    targetId,
                    content,
                    category,
                    tags,
                ]);
            } catch {
                /* FTS sync non-fatal */
            }
            // Re-embed the updated content
            embedAndStore(targetId, content).catch(() => {});
            // Remove the newly-inserted duplicate
            try {
                _purgeMemoryRow(newId);
            } catch {
                /* cleanup non-fatal */
            }
            console.log(`[MEMORY][SMART_WRITE] UPDATE: merged #${newId} into existing #${targetId}`);
        } else if (action === "DELETE") {
            // Mark the stale memory as decayed, keep the new one
            db.run("UPDATE memories SET decay_score = 0 WHERE id = ?", [targetId]);
            getTemporalCache().clearCache();
            console.log(`[MEMORY][SMART_WRITE] DELETE: decayed stale #${targetId}, kept new #${newId}`);
        }
    } catch (err) {
        // Entire smart write pipeline failed — the direct write still succeeded
        console.warn("[MEMORY][SMART_WRITE] Pipeline error (non-fatal):", (err as Error).message);
    }
}

/**
 * Hard-delete a memory row with its embedding, FTS row and HNSW vector, and
 * drop cached recall results. embedAndStore() re-checks row existence before
 * writing, so an in-flight embed for this id won't resurrect the vector.
 */
function _purgeMemoryRow(id: number): void {
    if (!db) return;
    db.run("DELETE FROM memories WHERE id = ?", [id]);
    db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
    try {
        db.run("DELETE FROM memories_fts WHERE rowid = ?", [id]);
    } catch {
        /* */
    }
    try {
        getHNSWIndex().removeVector(id);
    } catch {
        /* */
    }
    getTemporalCache().clearCache();
}

/** Helper: retrieve a stored embedding vector for a given memory ID. */
async function _getStoredEmbedding(memoryId: number): Promise<Float32Array | null> {
    if (!rawDb) return null;
    try {
        const row = rawDb.prepare("SELECT embedding FROM memory_embeddings WHERE memory_id = ?").get(memoryId) as
            | { embedding: Buffer }
            | undefined;
        if (row) return bufferToEmbedding(row.embedding);
    } catch {
        /* */
    }
    return null;
}

/** Generate embedding for a memory and store it in the embeddings table + HNSW index */
async function embedAndStore(memoryId: number, content: string): Promise<void> {
    if (!rawDb) return;
    try {
        const embedding = await embedText(content, "document");
        const buffer = embeddingToBuffer(embedding);

        const { getEmbeddingVersion } = await import("./embeddings.js");
        // The row may have been removed (smart-write NOOP/UPDATE, prune) while
        // we were embedding — don't re-insert an orphan vector. No await between
        // this check and the writes below, so it can't race.
        if (!rawDb.prepare("SELECT 1 FROM memories WHERE id = ?").get(memoryId)) return;
        rawDb
            .prepare(
                "INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, embedding_version) VALUES (?, ?, ?)",
            )
            .run(memoryId, buffer, getEmbeddingVersion());

        // ── Add to HNSW index ──
        const index = getHNSWIndex();
        index.addVector(memoryId, embedding);
    } catch (err) {
        console.warn(`[MEMORY][EMBED] Embedding failed for #${memoryId}:`, (err as Error).message);
    }
}

// ── Standalone FTS5 Keyword Search (BM25 ranked) ──────────────────

export const normFact = (t: string) =>
    t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

/** Id of a stored memory in this scope with the same text, ignoring case and punctuation. */
export function findExactMemory(content: string, scope = "global"): number | null {
    const n = normFact(content);
    return keywordSearch(content, 5, [scope]).find((m) => normFact(m.content) === n)?.id ?? null;
}

/**
 * FTS5 keyword search using BM25 ranking with porter stemming.
 * Filters out consolidated and heavily-decayed memories.
 * Falls back to empty array on any error (fail-open).
 */
export function keywordSearch(
    query: string,
    limit: number = 15,
    scopes?: string[],
): Array<{
    id: number;
    content: string;
    category: string;
    tags: string;
    importance: number;
    created_at: string;
    access_count: number;
    rank: number;
}> {
    if (!db) return [];

    try {
        const rawQuery = (query ?? "").trim();
        if (!rawQuery || rawQuery.length < 2) return [];

        // Route CJK queries (≥2 CJK chars) to the trigram FTS5 table: the
        // unicode61 tokenizer splits CJK into single-character tokens and
        // misses multi-character phrase matches. The trigram table indexes
        // overlapping 3-byte windows and handles CJK + arbitrary substring.
        const cjk = containsCjk(rawQuery);
        let ftsQuery: string;
        let ftsTable: "memories_fts" | "memories_fts_trigram";

        if (cjk) {
            ftsQuery = buildTrigramQuery(rawQuery);
            ftsTable = "memories_fts_trigram";
            if (!ftsQuery) return [];
        } else {
            // ASCII / Latin path: use the porter+unicode61 table. Sanitize
            // aggressively, then split into OR-joined stemmed terms for
            // broad recall.
            const sanitized = sanitizeFts5Query(rawQuery);
            if (!sanitized) return [];

            const stopWords = new Set([
                "a",
                "an",
                "the",
                "is",
                "are",
                "do",
                "you",
                "know",
                "who",
                "what",
                "where",
                "when",
                "why",
                "how",
                "i",
                "am",
                "my",
                "me",
                "to",
                "for",
                "in",
                "on",
                "of",
                "and",
                "or",
                "with",
            ]);
            // Split only on whitespace that's NOT inside a quoted phrase.
            // Simpler heuristic: keep quoted phrases as single tokens.
            const tokens: string[] = [];
            const phraseRe = /"[^"]+"|\S+/g;
            for (const m of sanitized.matchAll(phraseRe)) tokens.push(m[0]);

            const terms = tokens.filter((w) => {
                if (w.startsWith('"')) return true; // phrases always kept
                const lc = w.toLowerCase();
                return lc.length > 2 && !stopWords.has(lc);
            });
            if (terms.length === 0) return [];

            ftsQuery = terms.join(" OR ");
            ftsTable = "memories_fts";
        }

        const results = db.exec(
            `SELECT m.id, m.content, m.category, m.tags, m.importance, m.created_at, m.access_count, rank
       FROM ${ftsTable} fts
       JOIN memories m ON m.id = fts.rowid
       WHERE ${ftsTable} MATCH ?
       AND m.consolidated_into IS NULL
       AND m.decay_score > 0.2
       AND ${recallableSql("m.")}
       ${scopes && scopes.length > 0 ? `AND m.scope IN (${scopes.map(() => "?").join(",")})` : ""}
       ORDER BY rank
       LIMIT ?`,
            [ftsQuery, ...(scopes ?? []), limit],
        );

        if (results.length === 0) return [];

        return results[0].values.map((row, _idx) => ({
            id: row[0] as number,
            content: row[1] as string,
            category: row[2] as string,
            tags: row[3] as string,
            importance: row[4] as number,
            created_at: row[5] as string,
            access_count: row[6] as number,
            rank: row[7] as number,
        }));
    } catch (err) {
        console.warn("[FTS5] keywordSearch failed (non-fatal):", (err as Error).message);
        return [];
    }
}

// ── Reciprocal Rank Fusion (RRF) ──────────────────────────────────

/**
 * Merge results from multiple retrieval methods using Reciprocal Rank Fusion.
 * Each result list should be pre-sorted by relevance (best first).
 *
 * @param vectorResults - Results from HNSW vector search, ranked by similarity
 * @param keywordResults - Results from FTS5 keyword search, ranked by BM25
 * @param vectorWeight - Weight for vector results (default 0.70)
 * @param keywordWeight - Weight for keyword results (default 0.30)
 * @param k - RRF constant (default 60, controls rank saturation)
 * @returns Fused results sorted by combined RRF score
 */
export function reciprocalRankFusion(
    vectorResults: Array<{ id: number; score: number }>,
    keywordResults: Array<{ id: number; rank: number }>,
    vectorWeight: number = 0.7,
    keywordWeight: number = 0.3,
    k: number = 60,
): Array<{ id: number; score: number }> {
    const scores = new Map<number, number>();

    vectorResults.forEach((r, i) => {
        scores.set(r.id, (scores.get(r.id) || 0) + vectorWeight * (1 / (k + i)));
    });

    keywordResults.forEach((r, i) => {
        scores.set(r.id, (scores.get(r.id) || 0) + keywordWeight * (1 / (k + i)));
    });

    return Array.from(scores.entries())
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);
}

/**
 * Rows that must never surface in recall or core memory: audit-trail entries
 * and raw JSON blobs (e.g. brand profiles stored at importance 10).
 */
export function recallableSql(alias = ""): string {
    return `${alias}category NOT IN ('audit_log', 'brand') AND LTRIM(${alias}content) NOT LIKE '{%'`;
}

/**
 * Reciprocal-rank fusion of per-retriever ranks (1-based, undefined = not
 * found) with a multi-source agreement boost, normalised to 0-1 against the
 * best score achievable with `activeSources` retrievers (rank 1 in all of them).
 * Normalising lets relevance compete with recency/importance (both 0-1) in the
 * composite blend instead of being ~0.02 next to them.
 */
export function normalizedFusionScore(ranks: Array<number | undefined>, activeSources: number, k = 60): number {
    const boost = (n: number) => (n >= 3 ? 2.0 : n === 2 ? 1.5 : 1);
    let raw = 0;
    let found = 0;
    for (const r of ranks) {
        if (r === undefined) continue;
        raw += 1 / (k + r);
        found++;
    }
    if (found === 0) return 0;
    const active = Math.max(found, Math.min(3, activeSources));
    return Math.min(1, (raw * boost(found)) / ((boost(active) * active) / (k + 1)));
}

export async function recall(
    query: string,
    limit = 5,
    llm?: import("../llm.js").LLMClient,
    queryMode?: string,
    scopes?: string[],
    // Optional precomputed / in-flight embedding of `query`. When the caller
    // is about to run recall alongside other queries, it can kick off
    // embedText() early (or pass a cached Float32Array) and hand the
    // resulting promise here so the embedding happens in parallel with
    // those queries instead of sequentially inside recall.
    queryEmbedding?: Float32Array | Promise<Float32Array | null> | null,
    // touch:false = read-only (no access/decay/importance writes). since/until (ISO)
    // narrow results to a date window, falling back to unfiltered when it empties them.
    opts: { touch?: boolean; excludeCategories?: string[]; since?: string; until?: string } = {},
): Promise<MemoryRecord[]> {
    if (!db) throw new Error("Memory DB not initialized");

    // ── Scope filtering: build SQL clause for memory visibility ──
    // Always include "global" scope; also include any explicitly provided scopes.
    const effectiveScopes = scopes && scopes.length > 0 ? [...new Set(["global", ...scopes])] : ["global"];

    // ── Layer 0: Temporal Cache (Prefrontal Working Memory) ──
    // The key covers everything that changes the result, so one group's rows are never served to another.
    const cache = getTemporalCache();
    const cacheKey = JSON.stringify([
        query.toLowerCase().trim(),
        limit,
        [...effectiveScopes].sort(),
        queryMode ?? "",
        !!llm,
        opts.excludeCategories ?? [],
        opts.since ?? "",
        opts.until ?? "",
    ]);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const scopePlaceholders = effectiveScopes.map(() => "?").join(",");
    const scopeWhereClause = `scope IN (${scopePlaceholders})`;
    // Shared visibility filter for the secondary paths (SAN / HyDE).
    const visibleWhere = `decay_score > 0.2 AND consolidated_into IS NULL AND ${recallableSql()} AND ${scopeWhereClause}`;

    // Extract meaningful keywords
    const stopWords = new Set([
        "a",
        "an",
        "the",
        "is",
        "are",
        "do",
        "you",
        "know",
        "who",
        "what",
        "where",
        "when",
        "why",
        "how",
        "i",
        "am",
        "my",
        "me",
        "to",
        "for",
        "in",
        "on",
        "of",
        "and",
        "or",
        "with",
    ]);
    const words = query
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .split(/\s+/);
    const keywords = words.filter((w) => w.length > 2 && !stopWords.has(w));
    const searchTerms = keywords.length > 0 ? keywords : words;

    // Recall was tuned with this 2x candidate over-fetch.
    const effectiveLimit = limit * 2;

    // ── Layer 1a: FTS5 keyword search (porter-stemmed BM25) ──
    // Uses the standalone keywordSearch() which handles sanitization and fail-open
    const ftsResults = new Map<number, { record: MemoryRecord; rank: number }>();
    try {
        const keywordHits = keywordSearch(query, effectiveLimit * 2, effectiveScopes);
        for (let idx = 0; idx < keywordHits.length; idx++) {
            const hit = keywordHits[idx];
            const record: MemoryRecord = {
                id: hit.id,
                content: hit.content,
                category: hit.category,
                tags: hit.tags,
                importance: hit.importance,
                created_at: hit.created_at,
                access_count: hit.access_count,
            };
            ftsResults.set(record.id, { record, rank: idx + 1 });
        }
    } catch {
        /* FTS error — continue with vector only */
    }

    // ── Layer 1b: HNSW vector search (O(log n) instead of O(n)) ──
    const vectorResults = new Map<number, { record: MemoryRecord; rank: number }>();

    if (isEmbeddingReady()) {
        try {
            // Resolve the embedding. If the caller supplied a precomputed
            // or in-flight embedding we use that (it may already be done
            // by the time we get here, overlapping with FTS work above);
            // otherwise compute it ourselves. See resolve-embedding.ts
            // for the full resolution matrix + unit tests.
            const { resolveQueryEmbedding } = await import("./resolve-embedding.js");
            const hnswEmbedding = await resolveQueryEmbedding(queryEmbedding, () => embedText(query));
            const hnswIndex = getHNSWIndex();

            if (hnswIndex.size > 0) {
                // HNSW search — O(log n), returns top candidates
                const hnswResults = hnswIndex.search(hnswEmbedding, effectiveLimit * 3);

                // Filter by distance threshold first (distance < 0.75 means similarity > 0.25)
                const validHits = hnswResults.filter((hit) => hit.distance < 0.75);

                if (validHits.length > 0 && rawDb) {
                    // Batch load all memory data in ONE query instead of N queries
                    const ids = validHits.map((hit) => hit.id);
                    const placeholders = ids.map(() => "?").join(",");
                    const stmt = rawDb.prepare(
                        `SELECT id, content, category, tags, importance, created_at, access_count
             FROM memories WHERE id IN (${placeholders}) AND ${visibleWhere}`,
                    );
                    const rows = stmt.all(...ids, ...effectiveScopes) as Array<{
                        id: number;
                        content: string;
                        category: string;
                        tags: string;
                        importance: number;
                        created_at: string;
                        access_count: number;
                    }>;

                    // Create a map for O(1) lookup
                    const rowMap = new Map(rows.map((row) => [row.id, row]));

                    // Preserve HNSW ranking order
                    validHits.forEach((hit, idx) => {
                        const row = rowMap.get(hit.id);
                        if (row) {
                            const record = rowToMemory([
                                row.id,
                                row.content,
                                row.category,
                                row.tags,
                                row.importance,
                                row.created_at,
                                row.access_count,
                            ]);
                            vectorResults.set(record.id, { record, rank: idx + 1 });
                        }
                    });
                }
            } else if (rawDb) {
                // Fallback: brute-force if HNSW not built yet
                const rows = rawDb
                    .prepare(
                        `SELECT m.id, m.content, m.category, m.tags, m.importance, m.created_at, m.access_count, e.embedding
           FROM memory_embeddings e JOIN memories m ON e.memory_id = m.id
           WHERE m.decay_score > 0.2 AND m.consolidated_into IS NULL AND ${recallableSql("m.")} AND m.scope IN (${scopePlaceholders})`,
                    )
                    .all(...effectiveScopes) as Array<{
                    id: number;
                    content: string;
                    category: string;
                    tags: string;
                    importance: number;
                    created_at: string;
                    access_count: number;
                    embedding: Buffer;
                }>;

                const scored = rows
                    .map((row) => {
                        const embedding = bufferToEmbedding(row.embedding);
                        return {
                            record: {
                                id: row.id,
                                content: row.content,
                                category: row.category,
                                tags: row.tags,
                                importance: row.importance,
                                created_at: row.created_at,
                                access_count: row.access_count,
                            },
                            similarity: cosineSimilarity(hnswEmbedding, embedding),
                        };
                    })
                    .filter((r) => r.similarity > 0.25)
                    .sort((a, b) => b.similarity - a.similarity);

                scored.slice(0, effectiveLimit * 2).forEach((item, idx) => {
                    vectorResults.set(item.record.id, { record: item.record, rank: idx + 1 });
                });
            }
        } catch (err) {
            console.warn("[MEMORY][RECALL] Vector search failed:", (err as Error).message);
        }
    }

    // ── Layer 2a: Reciprocal Rank Fusion (RRF) ──
    const k = 60;
    const allIds = new Set([...ftsResults.keys(), ...vectorResults.keys()]);
    const fusedScores: Array<{ id: number; record: MemoryRecord; score: number }> = [];
    const activeSources = [ftsResults, vectorResults].filter((m) => m.size > 0).length;
    // Weights tunable via Meta-Harness registry
    const wRel = getDimensionValue<number>("memory.fusion.relevanceWeight") ?? 0.5;
    const wRec = getDimensionValue<number>("memory.fusion.recencyWeight") ?? 0.25;
    const wImp = getDimensionValue<number>("memory.fusion.importanceWeight") ?? 0.25;
    // Drop weak matches (e.g. single-retriever hits deep in the list while both
    // retrievers are active) instead of letting importance/recency carry them in.
    const minRelevance = getDimensionValue<number>("memory.fusion.minRelevance") ?? 0.1;

    for (const id of allIds) {
        const fts = ftsResults.get(id);
        const vec = vectorResults.get(id);
        const record = fts?.record || vec?.record;
        if (!record) continue;

        const relevance = normalizedFusionScore([fts?.rank, vec?.rank], activeSources, k);
        if (relevance < minRelevance) continue;

        // ── Generative Agents-style composite scoring (Park et al. 2023) ──
        // Score = α·recency + β·relevance + γ·importance (all terms 0-1)
        const hoursAgo = record.created_at ? (Date.now() - dbTimeMs(record.created_at)) / 3600000 : 168; // default 1 week
        const recencyWeight = Math.exp((-Math.LN2 * hoursAgo) / (30 * 24)); // exponential decay, half-life 30 days
        const importanceWeight = (record.importance || 5) / 10; // normalized 0-1
        const score = wRel * relevance + wRec * recencyWeight + wImp * importanceWeight;

        fusedScores.push({ id, record, score });
    }
    // Sort before any top-N slice below (SAN seeds, cross-encoder, reranker).
    fusedScores.sort((a, b) => b.score - a.score);

    // ── Layer 2b: Spreading Activation Network (Associative Cortex) ──
    if (fusedScores.length > 0) {
        try {
            const seedScores = new Map<number, number>();
            for (const f of fusedScores.slice(0, 5)) {
                // Top 5 seeds
                seedScores.set(f.id, f.score);
            }
            const sanResults = spreadActivation(seedScores, db);
            if (sanResults.length > 0) {
                const sanW = getDimensionValue<number>("memory.san.weight") ?? 0.3;
                // Merge SAN results — load full records for new IDs
                for (const san of sanResults) {
                    const existing = fusedScores.find((f) => f.id === san.memoryId);
                    if (existing) {
                        existing.score += sanW * san.activationScore;
                    } else {
                        const memResult = db.exec(
                            `SELECT id, content, category, tags, importance, created_at, access_count
               FROM memories WHERE id = ? AND ${visibleWhere}`,
                            [san.memoryId, ...effectiveScopes],
                        );
                        if (memResult.length > 0 && memResult[0].values.length > 0) {
                            fusedScores.push({
                                id: san.memoryId,
                                record: rowToMemory(memResult[0].values[0]),
                                score: sanW * san.activationScore,
                            });
                        }
                    }
                }
            }
        } catch {
            /* SAN non-fatal */
        }
    }

    // ── Layer 2c: Cross-Encoder Re-Ranking (lightweight) ──
    // Re-rank top candidates using direct embedding similarity for precision.
    // This is a lightweight cross-attention substitute — compare query embedding
    // against each candidate's content embedding for fine-grained relevance.
    fusedScores.sort((a, b) => b.score - a.score); // SAN may have reordered
    if (isEmbeddingReady() && fusedScores.length > 3) {
        try {
            const queryEmb = await embedText(query);
            const topN = fusedScores.slice(0, Math.min(fusedScores.length, limit * 2));
            const wCE = getDimensionValue<number>("memory.crossEncoder.blend") ?? 0.6;
            // Reuse vectors already in memory_embeddings; only embed rows that lack one.
            const stored = new Map<number, Float32Array>();
            if (rawDb) {
                const rows = rawDb
                    .prepare(
                        `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${topN.map(() => "?").join(",")})`,
                    )
                    .all(...topN.map((t) => t.id)) as Array<{ memory_id: number; embedding: Buffer }>;
                for (const row of rows) stored.set(row.memory_id, bufferToEmbedding(row.embedding));
            }
            for (const item of topN) {
                let contentEmb = stored.get(item.id);
                if (!contentEmb || contentEmb.length !== queryEmb.length) {
                    contentEmb = await embedText(item.record.content.substring(0, 200));
                }
                const rerankSim = cosineSimilarity(queryEmb, contentEmb);
                // Blend: wCE × fused score + (1-wCE) × re-rank similarity (both ~0-1)
                item.score = item.score * wCE + rerankSim * (1 - wCE);
            }
            // Keep the un-rescored tail on the same scale so it can't leapfrog the top N.
            for (const item of fusedScores.slice(topN.length)) item.score *= wCE;
        } catch {
            /* re-ranking non-fatal — fall through to RRF sort */
        }
    }

    // ── Layer 2d: LLM re-ranking for explicit memory lookups (~300ms extra) ──
    if (queryMode === "retrieve" && llm && fusedScores.length > 3) {
        try {
            fusedScores.sort((a, b) => b.score - a.score); // reranker takes the top slice
            const candidates = fusedScores.map((f) => ({
                id: f.id,
                content: f.record.content,
                originalScore: f.score,
            }));
            const { rerankWithLLM } = await import("./reranker.js");
            const reranked = await rerankWithLLM(llm, query, candidates, limit);
            const recordMap = new Map(fusedScores.map((f) => [f.id, f.record]));
            fusedScores.length = 0;
            for (const rr of reranked) {
                const rec = recordMap.get(rr.id);
                if (rec) fusedScores.push({ id: rr.id, record: rec, score: rr.score });
            }
            for (const [id, rec] of recordMap) {
                if (!fusedScores.find((f) => f.id === id)) {
                    fusedScores.push({ id, record: rec, score: 0 });
                }
            }
        } catch {
            /* reranker non-fatal */
        }
    }

    // Sort by fused score and take top results
    fusedScores.sort((a, b) => b.score - a.score);

    // ── Layer 2e: Conditional HyDE (Hypothetical Document Embeddings) ──
    // When initial recall is weak (vague queries like "the thing yesterday"),
    // generate a hypothetical answer and use its embedding to find better matches.
    // Only for questions about the past ("retrieve" mode): for everything else a
    // weak recall just means memory has nothing relevant, and the extra LLM call
    // (plus its latency on the critical path) buys nothing.
    if (
        llm &&
        queryMode === "retrieve" &&
        isEmbeddingReady() &&
        (fusedScores.length < (getDimensionValue<number>("memory.hyde.minResults") ?? 3) ||
            (fusedScores.length > 0 &&
                fusedScores[0].score < (getDimensionValue<number>("memory.hyde.minTopScore") ?? 0.15)))
    ) {
        try {
            console.log(
                `[MEMORY][HYDE] Weak recall (${fusedScores.length} results, top score: ${fusedScores[0]?.score?.toFixed(3) || "0"}) — generating hypothetical answer...`,
            );
            const hydeResponse = await llm.chat({
                messages: [
                    {
                        role: "user",
                        content: `Based on this query from a user to their personal AI assistant, write a 1-2 sentence hypothetical memory/fact that would answer it. Only output the hypothetical memory, nothing else.\n\nQuery: "${query}"`,
                    },
                ],
                systemPrompt: "You generate hypothetical memory entries. Output only the memory text, no explanation.",
                modelOverride: "openai/gpt-4.1-nano",
                lean: true,
            });
            const hypothetical = hydeResponse?.choices?.[0]?.message?.content;
            if (hypothetical && hypothetical.length > 10) {
                const hydeEmbedding = await embedText(hypothetical);
                const index = getHNSWIndex();
                if (index.size > 0) {
                    const hydeHits = index.search(hydeEmbedding, effectiveLimit);
                    const validHits = hydeHits.filter((hit) => hit.distance < 0.75);
                    // Merge HyDE results into fusedScores with 0.8x weight to avoid dominating
                    // Separate hits into existing (already in fusedScores) and new (need DB lookup)
                    const newHydeHits: typeof validHits = [];
                    for (const hit of validHits) {
                        const existing = fusedScores.find((f) => f.id === hit.id);
                        if (existing) {
                            existing.score += 0.8 * wRel * normalizedFusionScore([validHits.indexOf(hit) + 1], 1, k);
                        } else {
                            newHydeHits.push(hit);
                        }
                    }
                    // Batch load all new HyDE hits in ONE query instead of N queries
                    if (newHydeHits.length > 0 && rawDb) {
                        const hydeHitIds = newHydeHits.map((hit) => hit.id);
                        const placeholders = hydeHitIds.map(() => "?").join(",");
                        const stmt = rawDb.prepare(
                            `SELECT id, content, category, tags, importance, created_at, access_count
               FROM memories WHERE id IN (${placeholders}) AND ${visibleWhere}`,
                        );
                        const rows = stmt.all(...hydeHitIds, ...effectiveScopes) as Array<{
                            id: number;
                            content: string;
                            category: string;
                            tags: string;
                            importance: number;
                            created_at: string;
                            access_count: number;
                        }>;
                        const rowMap = new Map(rows.map((row) => [row.id, row]));
                        for (const hit of newHydeHits) {
                            const row = rowMap.get(hit.id);
                            if (row) {
                                fusedScores.push({
                                    id: hit.id,
                                    record: rowToMemory([
                                        row.id,
                                        row.content,
                                        row.category,
                                        row.tags,
                                        row.importance,
                                        row.created_at,
                                        row.access_count,
                                    ]),
                                    score: 0.8 * wRel * normalizedFusionScore([validHits.indexOf(hit) + 1], 1, k),
                                });
                            }
                        }
                    }
                    // Re-sort after HyDE merge
                    fusedScores.sort((a, b) => b.score - a.score);
                    console.log(
                        `[MEMORY][HYDE] Added ${validHits.length} HyDE results (hypothetical: "${hypothetical.substring(0, 60)}...")`,
                    );
                }
            }
        } catch (err) {
            console.warn("[MEMORY][HYDE] HyDE expansion failed (non-fatal):", (err as Error).message);
        }
    }

    const excluded = opts.excludeCategories ?? [];
    let kept = fusedScores.filter((f) => !excluded.includes(f.record.category));
    if (opts.since || opts.until) {
        const lo = opts.since ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
        const hi = opts.until ? Date.parse(opts.until) : Number.POSITIVE_INFINITY;
        const inWindow = kept.filter((f) => {
            const t = dbTimeMs(f.record.created_at);
            return t >= lo && t < hi;
        });
        if (inWindow.length > 0) kept = inWindow;
    }
    const records = kept.slice(0, limit).map((f) => f.record);

    // ── Layer 3: Fallback LIKE search ──
    if (records.length === 0) {
        // Sanitize search terms: escape SQL LIKE wildcards and use parameterized queries
        const sanitized = searchTerms.map((t) => t.replace(/[%_'\\]/g, ""));
        const likeConditions = sanitized.flatMap((t) => [`content LIKE ?`, `tags LIKE ?`]);
        const likeParams = sanitized.flatMap((t) => [`%${t}%`, `%${t}%`]);
        const whereClause =
            likeConditions.length > 0
                ? `WHERE (${likeConditions.join(" OR ")}) AND ${visibleWhere}`
                : `WHERE ${visibleWhere}`;

        const results = db.exec(
            `SELECT id, content, category, tags, importance, created_at, access_count
       FROM memories
       ${whereClause}
       ORDER BY (importance * decay_score * (1 + access_count * 0.1)) DESC, created_at DESC
       LIMIT ?`,
            [...likeParams, ...effectiveScopes, limit],
        );

        if (results.length > 0) {
            for (const row of results[0].values) {
                const r = rowToMemory(row);
                if (!excluded.includes(r.category)) records.push(r);
            }
        }
    }

    // ── Layer 4: Update access + Reconsolidation (Hippocampal Reconsolidation) ──
    if (opts.touch !== false && records.length > 0) {
        beginTransaction();
        try {
            for (const r of records) {
                const newAccessCount = r.access_count + 1;
                // Summaries stay at importance 6, as in remember().
                const shouldBoost = r.category !== "session_summary" && [10, 25, 50].includes(newAccessCount);

                // ── Reconsolidation: append query context tags to frequently-accessed memories ──
                if (newAccessCount > 3 && keywords.length > 0) {
                    try {
                        const tagResult = db.exec("SELECT reconsolidation_tags FROM memories WHERE id = ?", [r.id]);
                        if (tagResult.length > 0 && tagResult[0].values.length > 0) {
                            let tags: string[] = [];
                            try {
                                tags = JSON.parse((tagResult[0].values[0][0] as string) || "[]");
                            } catch {
                                /* */
                            }
                            const newTags = keywords.slice(0, 2); // Add top 2 keywords
                            for (const t of newTags) {
                                if (!tags.includes(t)) tags.push(t);
                            }
                            // FIFO: keep max 5 tags
                            while (tags.length > 5) tags.shift();
                            db.run("UPDATE memories SET reconsolidation_tags = ? WHERE id = ?", [
                                JSON.stringify(tags),
                                r.id,
                            ]);
                        }
                    } catch {
                        /* reconsolidation non-fatal */
                    }
                }

                // ── Ebbinghaus Strength Boost ──
                // Memory strength increases with each successful recall.
                // Decay rate slows as access_count grows, so frequently-recalled
                // memories resist decay more strongly while rarely-accessed ones
                // still decay normally.
                let ebbinghausUpdate = "";
                try {
                    const decayResult = db.exec("SELECT decay_score FROM memories WHERE id = ?", [r.id]);
                    const currentDecay = (decayResult[0]?.values[0]?.[0] as number) ?? 1.0;
                    const ebbinghausBoost = Math.min(0.5, 0.05 * Math.log2(1 + newAccessCount));
                    const newDecayScore = Math.min(1.0, currentDecay + ebbinghausBoost);
                    ebbinghausUpdate = `, decay_score = ${newDecayScore}`;
                } catch {
                    /* Ebbinghaus boost non-fatal */
                }

                if (shouldBoost) {
                    // Use self-evolving boostMemory() for milestone access counts — it updates
                    // decay_score, access_count, and accessed_at in a single atomic write
                    try {
                        boostMemory(db, r.id);
                    } catch {
                        /* boost non-fatal */
                    }
                    db.run("UPDATE memories SET importance = MIN(importance + 1, 10) WHERE id = ?", [r.id]);
                } else {
                    db.run(
                        `UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1${ebbinghausUpdate} WHERE id = ?`,
                        [r.id],
                    );
                }
            }
            commitTransaction();
        } catch {
            rollbackTransaction();
            return records; // don't cache stale data
        }
    }
    if (records.length > 0) cache.set(cacheKey, records);

    return records;
}

export function getCoreMemory(limit = 10): MemoryRecord[] {
    if (!db) return [];

    // Skip archived/consolidated originals, smart-write "deleted" (decay 0) rows,
    // session/task-scoped rows and audit/JSON blobs — this is injected every turn.
    const results = db.exec(
        `SELECT id, content, category, tags, importance, created_at, access_count
     FROM memories
     WHERE decay_score > 0.2 AND consolidated_into IS NULL AND scope = 'global' AND ${recallableSql()}
       AND category != 'session_summary' -- already injected as ACTIVE SESSION / PAST CONVERSATIONS
     ORDER BY importance DESC, access_count DESC, created_at DESC
     LIMIT ?`,
        [limit],
    );

    if (results.length === 0) return [];
    return results[0].values.map(rowToMemory);
}

// ── Scope Chain Builder ──────────────────────────────────
// Builds a hierarchical scope chain for memory filtering.
// A task-scoped recall includes: global + user + session + task memories.

export function buildScopeChain(userId?: string, sessionId?: string, taskId?: string): string[] {
    const chain = ["global"];
    if (userId) chain.push(`user:${userId}`);
    if (sessionId) chain.push(`session:${sessionId}`);
    if (taskId) chain.push(`task:${taskId}`);
    return chain;
}

export function listMemories(category?: string, limit = 20): MemoryRecord[] {
    if (!db) throw new Error("Memory DB not initialized");

    const query = category
        ? "SELECT id, content, category, tags, importance, created_at, access_count FROM memories WHERE category = ? ORDER BY created_at DESC LIMIT ?"
        : "SELECT id, content, category, tags, importance, created_at, access_count FROM memories ORDER BY created_at DESC LIMIT ?";

    const params = category ? [category, limit] : [limit];
    const results = db.exec(query, params);
    if (results.length === 0) return [];
    return results[0].values.map(rowToMemory);
}

export function forgetMemory(id: number): boolean {
    return forgetMemoryWithReason(id, "unspecified", "system");
}

// ── Memory Studio: edit / pin / forget ────────────────────────────────
// All writes go through these so the desktop main process and the bot
// share one source of truth for the SQL.

export function updateMemory(
    id: number,
    fields: Partial<{ content: string; category: string; tags: string; importance: number }>,
): { ok: boolean; error?: string } {
    if (!db) throw new Error("Memory DB not initialized");
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof fields.content === "string") {
        sets.push("content = ?");
        params.push(fields.content);
    }
    if (typeof fields.category === "string") {
        sets.push("category = ?");
        params.push(fields.category);
    }
    if (typeof fields.tags === "string") {
        sets.push("tags = ?");
        params.push(fields.tags);
    }
    if (typeof fields.importance === "number") {
        sets.push("importance = ?");
        params.push(Math.max(1, Math.min(10, Math.round(fields.importance))));
    }
    if (sets.length === 0) return { ok: false, error: "no fields to update" };

    try {
        beginTransaction();
        db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
        // If content changed, the embedding is stale — drop it. The HNSW
        // index rebuilds from DB on next bot boot.
        if (typeof fields.content === "string") {
            db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
        }
        commitTransaction();
        getTemporalCache().clearCache();
        return { ok: true };
    } catch (err) {
        rollbackTransaction();
        return { ok: false, error: (err as Error).message };
    }
}

export function setImportance(id: number, importance: number): boolean {
    if (!db) throw new Error("Memory DB not initialized");
    const v = Math.max(1, Math.min(10, Math.round(importance)));
    db.run("UPDATE memories SET importance = ? WHERE id = ?", [v, id]);
    return true;
}

export function setMemoryPinned(id: number, pinned: boolean): boolean {
    if (!db) throw new Error("Memory DB not initialized");
    db.run("UPDATE memories SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, id]);
    return true;
}

export function forgetMemoryWithReason(id: number, reason: string, source: "user" | "system" = "user"): boolean {
    if (!db) throw new Error("Memory DB not initialized");
    try {
        beginTransaction();
        // The tombstone keeps the reason, never the content: forgotten means gone.
        db.run("INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, ?)", [
            "memory",
            String(id),
            reason || "unspecified",
            source,
        ]);
        // Hard delete + cleanup the embedding row (no FK cascade exists).
        db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
        db.run("DELETE FROM memories WHERE id = ?", [id]);
        commitTransaction();
        try {
            getHNSWIndex().removeVector(id);
        } catch {
            /* */
        }
        getTemporalCache().clearCache();
        return true;
    } catch (err) {
        rollbackTransaction();
        throw err;
    }
}

export function bulkForget(ids: number[], reason: string, source: "user" | "system" = "user"): { forgotten: number } {
    if (!db) throw new Error("Memory DB not initialized");
    let count = 0;
    try {
        beginTransaction();
        for (const id of ids) {
            db.run("INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, ?)", [
                "memory",
                String(id),
                reason || "unspecified",
                source,
            ]);
            db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
            db.run("DELETE FROM memories WHERE id = ?", [id]);
            count++;
        }
        commitTransaction();
        try {
            for (const id of ids) getHNSWIndex().removeVector(id);
        } catch {
            /* */
        }
        getTemporalCache().clearCache();
    } catch (err) {
        rollbackTransaction();
        throw err;
    }
    return { forgotten: count };
}

export function forgetEntity(
    id: number,
    reason: string,
    cascade = true,
): { forgotten: number; relationshipsRemoved: number } {
    if (!db) throw new Error("Memory DB not initialized");
    let relCount = 0;
    try {
        beginTransaction();
        if (cascade) {
            // FK cascade is set; counting first for the report.
            const r = db.exec("SELECT COUNT(*) FROM relationships WHERE from_id = ? OR to_id = ?", [id, id]);
            relCount = r.length > 0 && r[0].values.length > 0 ? ((r[0].values[0]?.[0] as number) ?? 0) : 0;
        }
        db.run("INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, 'user')", [
            "entity",
            String(id),
            reason || "unspecified",
        ]);
        db.run("DELETE FROM entities WHERE id = ?", [id]);
        commitTransaction();
        return { forgotten: 1, relationshipsRemoved: relCount };
    } catch (err) {
        rollbackTransaction();
        throw err;
    }
}

export function getMemoryStats(): { total: number; categories: Record<string, number> } {
    if (!db) throw new Error("Memory DB not initialized");

    const totalResult = db.exec("SELECT COUNT(*) FROM memories");
    const total = (totalResult[0]?.values[0]?.[0] as number) || 0;

    const catResult = db.exec("SELECT category, COUNT(*) as cnt FROM memories GROUP BY category");
    const categories: Record<string, number> = {};
    if (catResult.length > 0) {
        for (const row of catResult[0].values) {
            categories[row[0] as string] = row[1] as number;
        }
    }

    return { total, categories };
}

// ── Types ─────────────────────────────────────

export interface MemoryRecord {
    id: number;
    content: string;
    category: string;
    tags: string;
    importance: number;
    created_at: string;
    access_count: number;
}

// SQLite datetime('now') is UTC without a zone marker; new Date() alone reads it as local time.
export function dbTimeMs(ts: string): number {
    if (!ts) return Number.NaN;
    return new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts.replace(" ", "T")}Z`).getTime();
}

export function ageLabel(ts: string, now = Date.now()): string {
    const days = (now - dbTimeMs(ts)) / 86_400_000;
    if (Number.isNaN(days)) return "undated";
    if (days < 1) return "today";
    if (days < 7) return `${Math.floor(days)}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
}

// "yesterday" / "last week" / "last month" / "N days|weeks ago" → a created_at window for recall().
export function parseDateWindow(message: string, now = new Date()): { since?: string; until?: string } {
    const m = message.toLowerCase();
    const DAY = 86_400_000;
    const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
    if (/\byesterday\b/.test(m)) {
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        return { since: new Date(today.getTime() - DAY).toISOString(), until: today.toISOString() };
    }
    const n = m.match(/\b(\d+)\s+(day|week)s?\s+ago\b/);
    if (n) {
        const days = Number(n[1]) * (n[2] === "week" ? 7 : 1);
        const slack = n[2] === "week" ? 7 : 1;
        return { since: ago(days + slack), until: ago(Math.max(0, days - slack)) };
    }
    if (/\blast week\b/.test(m)) return { since: ago(14) };
    if (/\blast month\b/.test(m)) return { since: ago(62) };
    return {};
}

function rowToMemory(row: unknown[]): MemoryRecord {
    return {
        id: row[0] as number,
        content: row[1] as string,
        category: row[2] as string,
        tags: row[3] as string,
        importance: row[4] as number,
        created_at: row[5] as string,
        access_count: row[6] as number,
    };
}

// ── Conversation Retrieval ────────────────────

export interface ConversationRecord {
    id: number;
    session_id: string;
    summary: string;
    created_at: string;
}

export async function recallConversation(query: string, limit = 5): Promise<ConversationRecord[]> {
    if (!db) return [];

    const stopWords = new Set([
        "a",
        "an",
        "the",
        "is",
        "are",
        "do",
        "you",
        "know",
        "who",
        "what",
        "where",
        "when",
        "why",
        "how",
        "i",
        "am",
        "my",
        "me",
        "to",
        "for",
        "in",
        "on",
        "of",
        "and",
        "or",
        "with",
    ]);
    const words = query
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .split(/\s+/);
    const keywords = words.filter((w) => w.length > 2 && !stopWords.has(w));
    const searchTerms = keywords.length > 0 ? keywords : words;

    // ── 1. Keyword LIKE search ──
    const keywordResults = new Map<number, { record: ConversationRecord; rank: number }>();
    const sanitizedTerms = searchTerms.map((t) => t.replace(/[%_'\\]/g, ""));
    const likeConditions = sanitizedTerms.map(() => `summary LIKE ?`);
    const likeParams = sanitizedTerms.map((t) => `%${t}%`);
    const whereClause = likeConditions.length > 0 ? `WHERE ${likeConditions.join(" OR ")}` : "";

    // Most matching terms first, so one shared word doesn't outrank an exact topic match.
    const matchOrder = likeConditions.length > 0 ? `(${likeConditions.map((c) => `(${c})`).join(" + ")}) DESC, ` : "";
    const likeRes = db.exec(
        `SELECT id, session_id, summary, created_at
     FROM conversations
     ${whereClause}
     ORDER BY ${matchOrder}created_at DESC
     LIMIT ?`,
        [...likeParams, ...(matchOrder ? likeParams : []), limit * 2],
    );

    if (likeRes.length > 0) {
        likeRes[0].values.forEach((row, idx) => {
            const record = {
                id: row[0] as number,
                session_id: row[1] as string,
                summary: row[2] as string,
                created_at: row[3] as string,
            };
            keywordResults.set(record.id, { record, rank: idx + 1 });
        });
    }

    // ── 2. Vector semantic search ──
    const vectorResults = new Map<number, { record: ConversationRecord; rank: number }>();

    if (isEmbeddingReady() && rawDb) {
        try {
            const queryEmbedding = await embedText(query);

            // ponytail: brute-force cosine over the newest 500 sessions; older ones stay
            // keyword/FTS-reachable. Move to an HNSW index if they need vector recall.
            const rows = rawDb
                .prepare(
                    `SELECT c.id, c.session_id, c.summary, c.created_at, ce.embedding
         FROM conversation_embeddings ce
         JOIN conversations c ON ce.conversation_id = c.id
         ORDER BY c.created_at DESC
         LIMIT 500`,
                )
                .all() as Array<{
                id: number;
                session_id: string;
                summary: string;
                created_at: string;
                embedding: Buffer;
            }>;

            const scored = rows
                .map((row) => {
                    const embedding = bufferToEmbedding(row.embedding);
                    return {
                        record: {
                            id: row.id,
                            session_id: row.session_id,
                            summary: row.summary,
                            created_at: row.created_at,
                        },
                        similarity: cosineSimilarity(queryEmbedding, embedding),
                    };
                })
                .filter((r) => r.similarity > 0.25)
                .sort((a, b) => b.similarity - a.similarity);

            scored.slice(0, limit * 2).forEach((item, idx) => {
                vectorResults.set(item.record.id, { record: item.record, rank: idx + 1 });
            });
        } catch {
            /* vector search non-fatal */
        }
    }

    // ── 3. RRF Fusion ──
    const k = 60;
    const allIds = new Set([...keywordResults.keys(), ...vectorResults.keys()]);
    const fused: Array<{ record: ConversationRecord; score: number }> = [];

    for (const id of allIds) {
        const kw = keywordResults.get(id);
        const vec = vectorResults.get(id);
        const record = kw?.record || vec?.record;
        if (!record) continue;

        let score = 0;
        if (kw) score += 1 / (k + kw.rank);
        if (vec) score += 1 / (k + vec.rank);
        if (kw && vec) score *= 1.5;

        fused.push({ record, score });
    }

    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, limit).map((f) => f.record);
}

// ── Embedding Migration ───────────────────────

/**
 * Embed all memories that don't have embeddings yet.
 * Called during boot to backfill existing data.
 */
export async function embedExistingMemories(): Promise<void> {
    if (!rawDb) return;

    try {
        // Warm up the embedding model first
        await warmupEmbeddings();
        // Stored vectors are Matryoshka-truncated (nomic 768 → 256), so compare
        // against the effective dim, not the raw model dim, or every boot
        // re-embeds the whole store.
        const activeDim = getEffectiveDimension();

        // 1. Find memories without any embeddings
        const unembedded = rawDb
            .prepare(
                `SELECT m.id, m.content FROM memories m
       LEFT JOIN memory_embeddings e ON m.id = e.memory_id
       WHERE e.memory_id IS NULL`,
            )
            .all() as Array<{ id: number; content: string }>;

        // 2. Find memories with wrong-dimension embeddings (e.g., 384-dim from fallback model)
        const wrongDim = rawDb
            .prepare(
                `SELECT m.id, m.content, LENGTH(e.embedding) as embed_bytes FROM memories m
       JOIN memory_embeddings e ON m.id = e.memory_id
       WHERE LENGTH(e.embedding) != ?`,
            )
            .all(activeDim * 4) as Array<{ id: number; content: string; embed_bytes: number }>;
        // Float32 = 4 bytes per dimension, so expected byte length = activeDim * 4

        const toEmbed = [...unembedded, ...wrongDim];

        if (toEmbed.length === 0) {
            console.log("[EMBED] All memories already have embeddings");
            return;
        }

        if (wrongDim.length > 0) {
            console.log(`[EMBED] Found ${wrongDim.length} memories with wrong dimension — will re-embed`);
            // Delete wrong-dimension embeddings so they get replaced
            for (const row of wrongDim) {
                rawDb.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(row.id);
            }
        }

        console.log(
            `[EMBED] Embedding ${toEmbed.length} memories (${unembedded.length} new, ${wrongDim.length} re-embed)...`,
        );

        // Reset HNSW index to correct dimension BEFORE re-embedding
        // This prevents "Vector length mismatch" errors during embedAndStore()
        if (wrongDim.length > 0) {
            try {
                const { resetIndex } = await import("./vector-index.js");
                resetIndex(activeDim);
                console.log(`[EMBED] HNSW index reset to ${activeDim}-dim for re-embedding`);
            } catch {
                /* non-fatal — will rebuild after */
            }
        }

        let embedded = 0;
        for (const row of toEmbed) {
            try {
                await embedAndStore(row.id, row.content);
                embedded++;
                if (embedded % 10 === 0) {
                    console.log(`[EMBED]   ...${embedded}/${toEmbed.length}`);
                }
            } catch {
                // Skip individual failures
            }
        }

        // Rebuild HNSW index with correct dimensions
        if (embedded > 0) {
            try {
                const { buildIndexFromDB } = await import("./vector-index.js");
                await buildIndexFromDB(rawDb);
                console.log("[EMBED] HNSW index rebuilt with correct dimensions");
            } catch {
                /* non-fatal */
            }
        }

        console.log(`[EMBED] ✅ Embedded ${embedded}/${toEmbed.length} memories`);
    } catch (err) {
        console.warn("[EMBED] Migration failed (non-fatal):", (err as Error).message);
    }
}

/**
 * Export the raw better-sqlite3 database handle for direct access.
 */
export function getRawDb(): BetterSqlite3.Database | null {
    return rawDb;
}

// ── getMemoryDB accessor ──────────────────────
// Used by marketing modules that need direct SQL access.

let _marketingDb: CompatDatabase | null = null;

export function getMemoryDB(): CompatDatabase {
    if (!_marketingDb) throw new Error("Memory DB not initialized — call initMemoryDB first");
    return _marketingDb;
}

// ── Marketing tables ──────────────────────────

export function initMarketingDB(db: CompatDatabase): void {
    _marketingDb = db;

    db.run(`CREATE TABLE IF NOT EXISTS marketing_calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content_pillar TEXT,
    caption TEXT,
    media_path TEXT,
    hashtags TEXT,
    scheduled_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    post_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mktcal_brand ON marketing_calendar(brand_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mktcal_status ON marketing_calendar(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mktcal_scheduled ON marketing_calendar(scheduled_at)`);

    db.run(`CREATE TABLE IF NOT EXISTS marketing_outreach (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    target_name TEXT,
    target_contact TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    sent_at TEXT,
    opened_at TEXT,
    replied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mktout_brand ON marketing_outreach(brand_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mktout_status ON marketing_outreach(status)`);
}
