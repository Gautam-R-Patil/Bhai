// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface Entity {
    id: number;
    name: string;
    type: string;
    properties: Record<string, unknown>;
}

export interface Relationship {
    id: number;
    from_id: number;
    to_id: number;
    type: string;
    properties: Record<string, unknown>;
    valid_at: number | null;
    invalid_at: number | null;
    expired_at: number | null;
    source_episode: string | null;
}

export interface RelationshipHistoryEntry {
    relation: string;
    target: string;
    valid_at: number;
    invalid_at: number | null;
}

// ── Initialize ────────────────────────────────

let _kgDb: Database | null = null;

export function getKnowledgeGraphDB(): Database | null {
    return _kgDb;
}

export function initKnowledgeGraph(db: Database): void {
    _kgDb = db;
    db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'thing',
      properties TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_accessed_at TEXT DEFAULT (datetime('now'))
    )
  `);

    // Add last_accessed_at column if missing (migration for existing DBs)
    try { db.run(`ALTER TABLE entities ADD COLUMN last_accessed_at TEXT DEFAULT (datetime('now'))`); } catch { /* column already exists */ }

    db.run(`
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      properties TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES entities(id) ON DELETE CASCADE
    )
  `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type)`);

    // Migration: add strength and last_accessed columns for spreading activation & temporal decay
    try { db.run(`ALTER TABLE relationships ADD COLUMN strength REAL DEFAULT 1.0`); } catch { /* already exists */ }
    try { db.run(`ALTER TABLE relationships ADD COLUMN last_accessed_at TEXT DEFAULT (datetime('now'))`); } catch { /* already exists */ }

    // Migration: bi-temporal tracking columns for relationship history
    try { db.run(`ALTER TABLE relationships ADD COLUMN valid_at INTEGER`); } catch { /* already exists */ }
    try { db.run(`ALTER TABLE relationships ADD COLUMN invalid_at INTEGER DEFAULT NULL`); } catch { /* already exists */ }
    try { db.run(`ALTER TABLE relationships ADD COLUMN expired_at INTEGER DEFAULT NULL`); } catch { /* already exists */ }
    try { db.run(`ALTER TABLE relationships ADD COLUMN source_episode TEXT DEFAULT NULL`); } catch { /* already exists */ }

    // Index for efficient temporal queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_rel_valid_at ON relationships(valid_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_rel_invalid_at ON relationships(invalid_at)`);
}

// ── Entity CRUD ───────────────────────────────

export function addEntity(db: Database, name: string, type: string, properties: Record<string, unknown> = {}): number {
    // Check if entity already exists
    const existing = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [name, type]);
    if (existing.length > 0 && existing[0].values.length > 0) {
        return existing[0].values[0][0] as number;
    }

    db.run(
        "INSERT INTO entities (name, type, properties) VALUES (?, ?, ?)",
        [name, type, JSON.stringify(properties)]
    );
    const result = db.exec("SELECT last_insert_rowid()");
    return (result[0]?.values[0]?.[0] as number) || 0;
}

export function getEntity(db: Database, id: number): Entity | null {
    const results = db.exec("SELECT id, name, type, properties FROM entities WHERE id = ?", [id]);
    if (results.length === 0 || results[0].values.length === 0) return null;
    return rowToEntity(results[0].values[0]);
}

export function findEntities(db: Database, query: string, type?: string): Entity[] {
    // Order by recency — recently accessed/updated entities rank higher
    const sql = type
        ? "SELECT id, name, type, properties FROM entities WHERE name LIKE ? AND type = ? ORDER BY COALESCE(last_accessed_at, updated_at) DESC LIMIT 20"
        : "SELECT id, name, type, properties FROM entities WHERE name LIKE ? ORDER BY COALESCE(last_accessed_at, updated_at) DESC LIMIT 20";
    const params = type ? [`%${query}%`, type] : [`%${query}%`];
    const results = db.exec(sql, params);
    if (results.length === 0) return [];
    const entities = results[0].values.map(rowToEntity);

    // Touch last_accessed_at for found entities (parameterized to avoid injection)
    if (entities.length > 0) {
        try {
            const placeholders = entities.map(() => "?").join(",");
            const ids = entities.map(e => e.id);
            db.run(`UPDATE entities SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`, ids);
        } catch { /* non-fatal */ }
    }

    return entities;
}

// ── Relationship CRUD ─────────────────────────

export function addRelationship(
    db: Database,
    fromId: number,
    toId: number,
    type: string,
    properties: Record<string, unknown> = {},
    sourceEpisode?: string
): number {
    const now = Date.now();

    // Check for contradicting relationships (same subject+object, different relation type)
    // Invalidate them rather than deleting
    try {
        const existing = db.exec(
            `SELECT id, type FROM relationships
             WHERE from_id = ? AND to_id = ? AND type != ? AND invalid_at IS NULL`,
            [fromId, toId, type]
        );
        if (existing.length > 0 && existing[0].values.length > 0) {
            for (const row of existing[0].values) {
                const existingId = row[0] as number;
                db.run(
                    `UPDATE relationships SET invalid_at = ?, expired_at = ? WHERE id = ?`,
                    [now, now, existingId]
                );
            }
        }
    } catch { /* non-fatal — proceed with insert */ }

    db.run(
        "INSERT INTO relationships (from_id, to_id, type, properties, valid_at, source_episode) VALUES (?, ?, ?, ?, ?, ?)",
        [fromId, toId, type, JSON.stringify(properties), now, sourceEpisode ?? null]
    );
    const result = db.exec("SELECT last_insert_rowid()");
    return (result[0]?.values[0]?.[0] as number) || 0;
}

export function getRelationships(
    db: Database,
    entityId: number,
    options: { includeHistory?: boolean } = {}
): Array<{ relationship: Relationship; entity: Entity }> {
    const includeHistory = options.includeHistory ?? false;
    const invalidFilter = includeHistory ? "" : "AND r.invalid_at IS NULL";

    const results = db.exec(
        `SELECT r.id, r.from_id, r.to_id, r.type, r.properties,
            e.id as eid, e.name, e.type as etype, e.properties as eprops,
            r.valid_at, r.invalid_at, r.expired_at, r.source_episode
     FROM relationships r
     JOIN entities e ON (e.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END)
     WHERE (r.from_id = ? OR r.to_id = ?) ${invalidFilter}
     LIMIT 50`,
        [entityId, entityId, entityId]
    );

    if (results.length === 0) return [];

    return results[0].values.map((row) => ({
        relationship: {
            id: row[0] as number,
            from_id: row[1] as number,
            to_id: row[2] as number,
            type: row[3] as string,
            properties: JSON.parse((row[4] as string) || "{}"),
            valid_at: row[9] as number | null,
            invalid_at: row[10] as number | null,
            expired_at: row[11] as number | null,
            source_episode: row[12] as string | null,
        },
        entity: {
            id: row[5] as number,
            name: row[6] as string,
            type: row[7] as string,
            properties: JSON.parse((row[8] as string) || "{}"),
        },
    }));
}

// ── Graph Traversal ───────────────────────────

export function traverseGraph(
    db: Database,
    startEntityId: number,
    maxDepth = 3
): Entity[] {
    const visited = new Set<number>();
    const result: Entity[] = [];
    const queue: Array<{ id: number; depth: number }> = [{ id: startEntityId, depth: 0 }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.id) || current.depth > maxDepth) continue;
        visited.add(current.id);

        const entity = getEntity(db, current.id);
        if (entity) result.push(entity);

        if (current.depth < maxDepth) {
            const rels = getRelationships(db, current.id);
            for (const rel of rels) {
                if (!visited.has(rel.entity.id)) {
                    queue.push({ id: rel.entity.id, depth: current.depth + 1 });
                }
            }
        }
    }

    return result;
}

// ── Relationship Strength & Decay ────────────

/** Boost a relationship's strength when it's used/accessed (capped at 2.0) */
export function strengthenRelationship(db: Database, relId: number, boost = 0.1): void {
    try {
        db.run(
            `UPDATE relationships SET strength = MIN(2.0, strength + ?), last_accessed_at = datetime('now') WHERE id = ?`,
            [boost, relId]
        );
    } catch { /* non-fatal */ }
}

/** Decay all relationship strengths over time (call from dream replay / heartbeat) */
export function decayRelationships(db: Database, decayRate = 0.01): void {
    try {
        // Exponential decay based on hours since last access
        db.run(`
            UPDATE relationships
            SET strength = MAX(0.1, strength * EXP(-? * (julianday('now') - julianday(COALESCE(last_accessed_at, created_at))) * 24))
            WHERE strength > 0.1
        `, [decayRate]);
        // Invalidate very weak relationships (strength < 0.1 and older than 30 days) instead of deleting
        db.run(`UPDATE relationships SET invalid_at = ?, expired_at = ? WHERE strength < 0.1 AND julianday('now') - julianday(created_at) > 30 AND invalid_at IS NULL`, [Date.now(), Date.now()]);
    } catch (err) {
        console.warn("[KG] Relationship decay failed:", (err as Error).message);
    }
}

/** Detect contradictions: find existing entities that conflict with a new assertion */
export function detectContradiction(
    db: Database,
    entityName: string,
    propertyKey: string,
    newValue: unknown,
): { hasContradiction: boolean; existingValue?: unknown; entityId?: number } {
    try {
        const results = db.exec(
            "SELECT id, properties FROM entities WHERE name = ?",
            [entityName]
        );
        if (results.length === 0 || results[0].values.length === 0) {
            return { hasContradiction: false };
        }
        const row = results[0].values[0];
        const existing = JSON.parse((row[1] as string) || "{}");
        if (propertyKey in existing && existing[propertyKey] !== newValue) {
            return {
                hasContradiction: true,
                existingValue: existing[propertyKey],
                entityId: row[0] as number,
            };
        }
        return { hasContradiction: false };
    } catch {
        return { hasContradiction: false };
    }
}

// ── Bi-Temporal History ──────────────────────

/**
 * Get the full temporal history of relationships for a named entity.
 * Returns all relationships (including invalidated ones) with their temporal bookends.
 */
export function getRelationshipHistory(
    entityName: string
): Array<{ relation: string; target: string; valid_at: number; invalid_at: number | null }> {
    const db = _kgDb;
    if (!db) return [];

    try {
        // Find entity by name
        const entityResults = db.exec(
            "SELECT id FROM entities WHERE name = ?",
            [entityName]
        );
        if (entityResults.length === 0 || entityResults[0].values.length === 0) return [];

        const entityId = entityResults[0].values[0][0] as number;

        // Get all relationships (including invalidated) with joined entity names
        const results = db.exec(
            `SELECT r.type, e.name, r.valid_at, r.invalid_at
             FROM relationships r
             JOIN entities e ON (e.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END)
             WHERE r.from_id = ? OR r.to_id = ?
             ORDER BY r.valid_at ASC`,
            [entityId, entityId, entityId]
        );

        if (results.length === 0) return [];

        return results[0].values.map((row) => ({
            relation: row[0] as string,
            target: row[1] as string,
            valid_at: (row[2] as number) ?? 0,
            invalid_at: row[3] as number | null,
        }));
    } catch {
        return [];
    }
}

/**
 * Invalidate a specific relationship by ID (soft-delete).
 * Sets invalid_at to current time instead of removing the row.
 */
export function invalidateRelationship(db: Database, relId: number): void {
    try {
        db.run(
            `UPDATE relationships SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL`,
            [Date.now(), relId]
        );
    } catch { /* non-fatal */ }
}

// ── Helpers ───────────────────────────────────

function rowToEntity(row: unknown[]): Entity {
    return {
        id: row[0] as number,
        name: row[1] as string,
        type: row[2] as string,
        properties: JSON.parse((row[3] as string) || "{}"),
    };
}
