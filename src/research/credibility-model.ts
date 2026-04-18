// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Source Credibility Model ─────────────────────
 * Bayesian credibility tracking per domain/author/publication.
 * Updates scores based on cross-referencing research results.
 * Higher-credibility sources weighted more in research synthesis.
 */

import type { Database } from "../memory/sqlite.js";

// ── Types ─────────────────────────────────────

export interface SourceScore {
    domain: string;
    credibility: number;    // 0-1
    totalCitations: number;
    confirmed: number;
    contradicted: number;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function initCredibilityModel(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS source_credibility (
            domain TEXT PRIMARY KEY,
            credibility_score REAL DEFAULT 0.5,
            total_citations INTEGER DEFAULT 0,
            confirmed_claims INTEGER DEFAULT 0,
            contradicted_claims INTEGER DEFAULT 0,
            last_updated TEXT DEFAULT (datetime('now'))
        )
    `);

    console.log("[CREDIBILITY] Model initialized");
}

// ── Record ────────────────────────────────────

/**
 * Record that a claim from a source was confirmed or contradicted.
 */
export function recordClaimVerification(
    domain: string,
    confirmed: boolean,
    strength = 0.5,
): void {
    if (!db) return;

    const native = loadNative();

    // Get or create source record
    const existing = db.exec(
        "SELECT credibility_score, total_citations, confirmed_claims, contradicted_claims FROM source_credibility WHERE domain = ?",
        [domain]
    );

    if (existing[0]?.values[0]) {
        const [score, citations, conf, contra] = existing[0].values[0] as [number, number, number, number];

        let newScore = score;
        if (native) {
            const update = native.updateCredibility({
                domain, credibility_score: score, total_citations: citations,
                confirmed_claims: conf, contradicted_claims: contra, last_updated_ms: Date.now(),
            }, confirmed, strength);
            newScore = update.new_score;
        } else {
            // Simple Bayesian update
            const alpha = conf + 1 + (confirmed ? strength : 0);
            const beta = contra + 1 + (confirmed ? 0 : strength);
            newScore = alpha / (alpha + beta);
        }

        db.run(
            `UPDATE source_credibility SET
                credibility_score = ?, total_citations = total_citations + 1,
                confirmed_claims = confirmed_claims + ?,
                contradicted_claims = contradicted_claims + ?,
                last_updated = datetime('now')
             WHERE domain = ?`,
            [newScore, confirmed ? 1 : 0, confirmed ? 0 : 1, domain]
        );
    } else {
        const initialScore = confirmed ? 0.6 : 0.4;
        db.run(
            `INSERT INTO source_credibility (domain, credibility_score, total_citations, confirmed_claims, contradicted_claims)
             VALUES (?, ?, 1, ?, ?)`,
            [domain, initialScore, confirmed ? 1 : 0, confirmed ? 0 : 1]
        );
    }
}

// ── Query ─────────────────────────────────────

/**
 * Get credibility score for a domain. Returns 0.5 if unknown.
 */
export function getCredibility(domain: string): number {
    if (!db) return 0.5;
    const result = db.exec(
        "SELECT credibility_score FROM source_credibility WHERE domain = ?",
        [domain]
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0.5;
}

/**
 * Get top credible sources, ranked.
 */
export function getTopSources(limit = 10): SourceScore[] {
    if (!db) return [];
    const results = db.exec(
        `SELECT domain, credibility_score, total_citations, confirmed_claims, contradicted_claims
         FROM source_credibility ORDER BY credibility_score DESC LIMIT ?`,
        [limit]
    );
    if (!results[0]?.values) return [];
    return results[0].values.map(r => ({
        domain: r[0] as string, credibility: r[1] as number, totalCitations: r[2] as number,
        confirmed: r[3] as number, contradicted: r[4] as number,
    }));
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;
function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const r = createRequire(import.meta.url);
        const path = require("node:path");
        _native = r(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
