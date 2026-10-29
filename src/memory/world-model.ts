// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── World Model ──────────────────────────────────
 * Structured model of the user's digital environment.
 * Tracks APIs, websites, tools, documents, and their accessibility.
 * Used by the replanner and tool router for informed planning decisions.
 */

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface WorldEntity {
    name: string;
    entityType: "api" | "website" | "tool" | "document" | "contact" | "service";
    accessibilityScore: number;  // 0-1
    lastVerified: string | null;
    failureCount24h: number;
    successCount24h: number;
    typicalResponseMs: number;
    capabilities: string[];
    dependencies: string[];
}

export interface EntityConfidence {
    name: string;
    confidence: number;
    status: "healthy" | "degraded" | "unreachable" | "unknown";
    hoursSinceVerified: number;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function initWorldModel(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS world_entities (
            name TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            accessibility_score REAL DEFAULT 1.0,
            last_verified TEXT,
            failure_count_24h INTEGER DEFAULT 0,
            success_count_24h INTEGER DEFAULT 0,
            typical_response_ms REAL DEFAULT 0,
            capabilities TEXT DEFAULT '[]',
            dependencies TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_world_type ON world_entities(entity_type)"); } catch { /* */ }

    console.log("[WORLD-MODEL] Initialized");
}

// ── Record Events ─────────────────────────────

/**
 * Record a successful interaction with an entity.
 */
export function recordSuccess(name: string, entityType: WorldEntity["entityType"], responseMs = 0): void {
    if (!db) return;

    db.run(`
        INSERT INTO world_entities (name, entity_type, last_verified, success_count_24h, typical_response_ms, accessibility_score)
        VALUES (?, ?, datetime('now'), 1, ?, 1.0)
        ON CONFLICT(name) DO UPDATE SET
            last_verified = datetime('now'),
            success_count_24h = success_count_24h + 1,
            typical_response_ms = CASE
                WHEN typical_response_ms = 0 THEN ?
                ELSE (typical_response_ms * 0.7 + ? * 0.3)
            END,
            accessibility_score = MIN(accessibility_score + 0.1, 1.0),
            updated_at = datetime('now')
    `, [name, entityType, responseMs, responseMs, responseMs]);
}

/**
 * Record a failed interaction with an entity.
 */
export function recordFailure(name: string, entityType: WorldEntity["entityType"]): void {
    if (!db) return;

    db.run(`
        INSERT INTO world_entities (name, entity_type, failure_count_24h, accessibility_score)
        VALUES (?, ?, 1, 0.5)
        ON CONFLICT(name) DO UPDATE SET
            failure_count_24h = failure_count_24h + 1,
            accessibility_score = MAX(accessibility_score - 0.2, 0.0),
            updated_at = datetime('now')
    `, [name, entityType]);
}

// ── Query ─────────────────────────────────────

/**
 * Get entity confidence. Uses native Rust decay computation when available.
 */
export function getEntityConfidence(name: string): EntityConfidence | null {
    if (!db) return null;

    const results = db.exec(
        `SELECT name, entity_type, accessibility_score, last_verified,
                failure_count_24h, success_count_24h, typical_response_ms
         FROM world_entities WHERE name = ?`,
        [name]
    );

    if (!results[0]?.values[0]) return null;

    const row = results[0].values[0];
    const lastVerified = row[3] as string | null;
    const hoursSinceVerified = lastVerified
        ? (Date.now() - new Date(lastVerified).getTime()) / 3600000
        : 999;

    try {
        const native = loadNative();
        if (native) {
            return native.entityConfidenceDecay({
                name: row[0] as string,
                entity_type: row[1] as string,
                last_verified_hours_ago: hoursSinceVerified,
                failure_count_24h: row[4] as number,
                success_count_24h: row[5] as number,
                typical_response_ms: row[6] as number,
                dependencies: [],
            });
        }
    } catch { /* */ }

    // JS fallback
    const failureCount = row[4] as number;
    const timeFactor = Math.exp(-0.693 * hoursSinceVerified / 168);
    const failureFactor = failureCount === 0 ? 1 : Math.max(0, 1 - failureCount / 5);
    const confidence = Math.max(0, Math.min(1, timeFactor * failureFactor));

    return {
        name: row[0] as string,
        confidence,
        status: confidence > 0.7 ? "healthy" : confidence > 0.3 ? "degraded" : failureCount > 0 ? "unreachable" : "unknown",
        hoursSinceVerified,
    };
}

/**
 * Get all entities with their current confidence scores.
 */
export function getAllEntities(): WorldEntity[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT name, entity_type, accessibility_score, last_verified,
                failure_count_24h, success_count_24h, typical_response_ms,
                capabilities, dependencies
         FROM world_entities ORDER BY accessibility_score DESC`,
        []
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        name: row[0] as string,
        entityType: row[1] as WorldEntity["entityType"],
        accessibilityScore: row[2] as number,
        lastVerified: row[3] as string | null,
        failureCount24h: row[4] as number,
        successCount24h: row[5] as number,
        typicalResponseMs: row[6] as number,
        capabilities: safeParse(row[7] as string),
        dependencies: safeParse(row[8] as string),
    }));
}

/**
 * Check if a planned action is feasible given current world state.
 */
export function checkFeasibility(requiredEntityNames: string[]): {
    feasible: boolean;
    bottleneck: string | null;
    confidence: number;
} {
    if (requiredEntityNames.length === 0) {
        return { feasible: true, bottleneck: null, confidence: 1 };
    }

    let minConfidence = 1;
    let bottleneck: string | null = null;

    for (const name of requiredEntityNames) {
        const conf = getEntityConfidence(name);
        if (conf && conf.confidence < minConfidence) {
            minConfidence = conf.confidence;
            bottleneck = conf.name;
        }
    }

    return {
        feasible: minConfidence > 0.3,
        bottleneck,
        confidence: minConfidence,
    };
}

/**
 * Reset 24h failure/success counts (run daily).
 */
export function resetDailyCounts(): void {
    if (!db) return;
    db.run("UPDATE world_entities SET failure_count_24h = 0, success_count_24h = 0");
}

// ── Helpers ───────────────────────────────────

function safeParse(json: string): string[] {
    try { return JSON.parse(json); } catch { return []; }
}

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const nativeRequire = createRequire(import.meta.url);
        const path = require("node:path");
        _native = nativeRequire(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
