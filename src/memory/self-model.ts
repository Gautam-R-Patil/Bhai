// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Self Model ──────────────────────────────────
 * Tracks the agent's own capability model — success/failure rates
 * per tool and per task type. Used by the model router and planner
 * to make informed decisions about what the agent can do reliably.
 *
 * Rust counterparts: native/src/skill_scorer.rs, native/src/process_reward.rs
 */

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface CapabilityRecord {
    capability: string;
    successCount: number;
    failureCount: number;
    avgDurationMs: number;
    lastUpdated: string;
    domain: string;
}

export interface CapabilityConfidence {
    capability: string;
    confidence: number;
    totalAttempts: number;
    domain: string;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function initSelfModel(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS self_model (
            capability TEXT PRIMARY KEY,
            success_count INTEGER DEFAULT 0,
            failure_count INTEGER DEFAULT 0,
            avg_duration_ms REAL DEFAULT 0,
            last_updated TEXT,
            domain TEXT DEFAULT 'general'
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_self_model_domain ON self_model(domain)"); } catch { /* */ }

    console.log("[SELF-MODEL] Initialized");
}

// ── Record Events ─────────────────────────────

/**
 * Record the outcome of a capability use (tool call, task type, etc.).
 * Updates success/failure counts and running average duration.
 */
export function recordOutcome(capability: string, success: boolean, durationMs: number, domain = "general"): void {
    if (!db) return;

    const successIncrement = success ? 1 : 0;
    const failureIncrement = success ? 0 : 1;

    db.run(`
        INSERT INTO self_model (capability, success_count, failure_count, avg_duration_ms, last_updated, domain)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(capability) DO UPDATE SET
            success_count = success_count + ?,
            failure_count = failure_count + ?,
            avg_duration_ms = CASE
                WHEN avg_duration_ms = 0 THEN ?
                ELSE (avg_duration_ms * 0.7 + ? * 0.3)
            END,
            last_updated = datetime('now'),
            domain = COALESCE(?, domain)
    `, [
        capability, successIncrement, failureIncrement, durationMs, domain,
        successIncrement, failureIncrement, durationMs, durationMs, domain,
    ]);
}

// ── Query ─────────────────────────────────────

/**
 * Get confidence score for a capability.
 * Returns success_count / (success_count + failure_count), or 0.5 if no data.
 */
export function getConfidence(capability: string): number {
    if (!db) return 0.5;

    const results = db.exec(
        `SELECT success_count, failure_count FROM self_model WHERE capability = ?`,
        [capability]
    );

    if (!results[0]?.values[0]) return 0.5;

    const row = results[0].values[0];
    const successCount = row[0] as number;
    const failureCount = row[1] as number;
    const total = successCount + failureCount;

    if (total === 0) return 0.5;

    // Try native Rust scorer for weighted confidence
    try {
        const native = loadNative();
        if (native?.scoreCapabilityConfidence) {
            return native.scoreCapabilityConfidence(successCount, failureCount);
        }
    } catch { /* */ }

    return successCount / total;
}

/**
 * Get all capabilities with confidence below a threshold.
 * Useful for identifying areas where the agent struggles.
 */
export function getWeakCapabilities(threshold = 0.4): CapabilityConfidence[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT capability, success_count, failure_count, domain
         FROM self_model
         WHERE (success_count + failure_count) > 2
         ORDER BY CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) ASC`,
        []
    );

    if (!results[0]?.values) return [];

    const weak: CapabilityConfidence[] = [];
    for (const row of results[0].values) {
        const successCount = row[1] as number;
        const failureCount = row[2] as number;
        const total = successCount + failureCount;
        const confidence = total > 0 ? successCount / total : 0.5;

        if (confidence < threshold) {
            weak.push({
                capability: row[0] as string,
                confidence,
                totalAttempts: total,
                domain: row[3] as string,
            });
        }
    }

    return weak;
}

/**
 * Get all capability records sorted by usage.
 */
export function getAllCapabilities(): CapabilityRecord[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT capability, success_count, failure_count, avg_duration_ms, last_updated, domain
         FROM self_model
         ORDER BY (success_count + failure_count) DESC`,
        []
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        capability: row[0] as string,
        successCount: row[1] as number,
        failureCount: row[2] as number,
        avgDurationMs: row[3] as number,
        lastUpdated: row[4] as string,
        domain: row[5] as string,
    }));
}

/**
 * Get a ~200 token summary of top capabilities and weaknesses for prompt injection.
 */
export function getSelfModelSnippet(): string {
    if (!db) return "";

    // Top strengths (high confidence, high usage)
    const strengthResults = db.exec(
        `SELECT capability, success_count, failure_count
         FROM self_model
         WHERE (success_count + failure_count) >= 3
         ORDER BY CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) DESC, (success_count + failure_count) DESC
         LIMIT 5`,
        []
    );

    // Top weaknesses (low confidence, some usage)
    const weakResults = db.exec(
        `SELECT capability, success_count, failure_count
         FROM self_model
         WHERE (success_count + failure_count) >= 3
         ORDER BY CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) ASC
         LIMIT 3`,
        []
    );

    const parts: string[] = [];

    if (strengthResults[0]?.values?.length) {
        const strengths = strengthResults[0].values.map(row => {
            const s = row[1] as number;
            const f = row[2] as number;
            const pct = Math.round((s / (s + f)) * 100);
            return `${row[0]} (${pct}%)`;
        });
        parts.push(`Strengths: ${strengths.join(", ")}`);
    }

    if (weakResults[0]?.values?.length) {
        const weaknesses = weakResults[0].values.map(row => {
            const s = row[1] as number;
            const f = row[2] as number;
            const pct = Math.round((s / (s + f)) * 100);
            return `${row[0]} (${pct}%)`;
        });
        // Only include if they're actually weak (< 60%)
        const realWeak = weakResults[0].values.filter(row => {
            const s = row[1] as number;
            const f = row[2] as number;
            return s / (s + f) < 0.6;
        });
        if (realWeak.length > 0) {
            const weakLabels = realWeak.map(row => {
                const s = row[1] as number;
                const f = row[2] as number;
                const pct = Math.round((s / (s + f)) * 100);
                return `${row[0]} (${pct}%)`;
            });
            parts.push(`Weaknesses: ${weakLabels.join(", ")}`);
        }
    }

    return parts.length > 0
        ? `SELF MODEL:\n${parts.map(p => `- ${p}`).join("\n")}`
        : "";
}

// ── Native Module ─────────────────────────────

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
