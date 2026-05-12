// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Click memory (Phase 5) — persistent per-user record of successful clicks.
 *
 * Schema: `(app, window_title, element_label) → (x_norm, y_norm, success_count,
 * last_used, last_screen_w, last_screen_h)`. Normalized to monitor dimensions so
 * the recall transfers across resolution changes.
 *
 * On a hit, the cascade router's tier 1 returns the cached coord with
 * `confidence = min(0.95, 0.7 + success_count*0.05)` — high confidence once a
 * site has been clicked successfully 5+ times. Misses (post-click verification
 * fails) decrement success_count and zero it at 0.
 *
 * Storage: lightweight SQLite at `<data>/click-memory.db`. Keeps the agent's
 * `memories.db` clean of UI-specific noise.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { getDataDir } from "../config/paths.js";

export interface ClickSite {
    app: string;
    windowTitle: string;
    elementLabel: string;
}

/** Kill-switch — when true, recall returns null and record* are no-ops. */
function isDisabled(): boolean {
    return process.env.ATLAS_NO_CLICK_MEMORY === "true";
}

export interface ClickRecall {
    xNorm: number;
    yNorm: number;
    successCount: number;
    lastUsed: number;
    lastScreenWidth: number;
    lastScreenHeight: number;
    confidence: number;
}

export interface ClickMemoryOptions {
    dbPath?: string;
}

let _db: BetterSqlite3.Database | null = null;
let _dbPath: string | null = null;

function getDbPath(opts?: ClickMemoryOptions): string {
    if (opts?.dbPath) return opts.dbPath;
    return join(getDataDir(), "click-memory.db");
}

export function initClickMemory(opts?: ClickMemoryOptions): BetterSqlite3.Database {
    if (_db) return _db;
    const dbPath = getDbPath(opts);
    _dbPath = dbPath;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _db = new BetterSqlite3(dbPath);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
        CREATE TABLE IF NOT EXISTS click_sites (
            app TEXT NOT NULL,
            window_title TEXT NOT NULL,
            element_label TEXT NOT NULL,
            x_norm REAL NOT NULL,
            y_norm REAL NOT NULL,
            success_count INTEGER NOT NULL DEFAULT 1,
            last_used INTEGER NOT NULL,
            last_screen_w INTEGER NOT NULL,
            last_screen_h INTEGER NOT NULL,
            PRIMARY KEY (app, window_title, element_label)
        );
        CREATE INDEX IF NOT EXISTS idx_click_sites_last_used ON click_sites(last_used);
    `);
    return _db;
}

export function closeClickMemory(): void {
    if (_db) {
        _db.close();
        _db = null;
        _dbPath = null;
    }
}

/** Record a successful click at the given coordinates. Bumps success_count. */
export function recordClickSuccess(
    site: ClickSite,
    x: number,
    y: number,
    screenW: number,
    screenH: number,
    opts?: ClickMemoryOptions,
): void {
    if (isDisabled()) return;
    if (screenW <= 0 || screenH <= 0) return; // can't normalize
    const db = initClickMemory(opts);
    const xNorm = x / screenW;
    const yNorm = y / screenH;
    const now = Date.now();
    db.prepare(`
        INSERT INTO click_sites (app, window_title, element_label, x_norm, y_norm, success_count, last_used, last_screen_w, last_screen_h)
        VALUES (@app, @windowTitle, @elementLabel, @xNorm, @yNorm, 1, @now, @screenW, @screenH)
        ON CONFLICT(app, window_title, element_label) DO UPDATE SET
            x_norm = excluded.x_norm,
            y_norm = excluded.y_norm,
            success_count = success_count + 1,
            last_used = excluded.last_used,
            last_screen_w = excluded.last_screen_w,
            last_screen_h = excluded.last_screen_h
    `).run({
        app: site.app,
        windowTitle: site.windowTitle,
        elementLabel: site.elementLabel,
        xNorm,
        yNorm,
        now,
        screenW,
        screenH,
    });
}

/** Decrement success on a recorded miss; remove the entry when it hits zero. Atomic. */
export function recordClickMiss(site: ClickSite, opts?: ClickMemoryOptions): void {
    if (isDisabled()) return;
    const db = initClickMemory(opts);
    const updateStmt = db.prepare(`
        UPDATE click_sites
        SET success_count = success_count - 1
        WHERE app = @app AND window_title = @windowTitle AND element_label = @elementLabel
    `);
    const deleteStmt = db.prepare(`DELETE FROM click_sites WHERE success_count <= 0`);
    const tx = db.transaction((s: ClickSite) => {
        updateStmt.run(s);
        deleteStmt.run();
    });
    tx(site);
}

/** Look up a previously-clicked site. Returns null if no recent record. */
export function recallClickSite(site: ClickSite, opts?: ClickMemoryOptions): ClickRecall | null {
    if (isDisabled()) return null;
    const db = initClickMemory(opts);
    const row = db
        .prepare(`
        SELECT x_norm, y_norm, success_count, last_used, last_screen_w, last_screen_h
        FROM click_sites
        WHERE app = @app AND window_title = @windowTitle AND element_label = @elementLabel
    `)
        .get(site) as
        | {
              x_norm: number;
              y_norm: number;
              success_count: number;
              last_used: number;
              last_screen_w: number;
              last_screen_h: number;
          }
        | undefined;
    if (!row) return null;
    // Stale entries (>90 days unused) → drop and miss
    const AGE_MAX_MS = 90 * 24 * 60 * 60 * 1000;
    if (Date.now() - row.last_used > AGE_MAX_MS) {
        db.prepare(
            `DELETE FROM click_sites WHERE app = @app AND window_title = @windowTitle AND element_label = @elementLabel`,
        ).run(site);
        return null;
    }
    return {
        xNorm: row.x_norm,
        yNorm: row.y_norm,
        successCount: row.success_count,
        lastUsed: row.last_used,
        lastScreenWidth: row.last_screen_w,
        lastScreenHeight: row.last_screen_h,
        confidence: Math.min(0.95, 0.7 + row.success_count * 0.05),
    };
}

/** Get all sites for an app+window (useful for UX or migration). */
export function listClickSitesForWindow(app: string, windowTitle: string, opts?: ClickMemoryOptions): ClickRecall[] {
    const db = initClickMemory(opts);
    const rows = db
        .prepare(`
        SELECT x_norm, y_norm, success_count, last_used, last_screen_w, last_screen_h
        FROM click_sites
        WHERE app = @app AND window_title = @windowTitle
        ORDER BY last_used DESC
    `)
        .all({ app, windowTitle }) as Array<{
        x_norm: number;
        y_norm: number;
        success_count: number;
        last_used: number;
        last_screen_w: number;
        last_screen_h: number;
    }>;
    return rows.map((row) => ({
        xNorm: row.x_norm,
        yNorm: row.y_norm,
        successCount: row.success_count,
        lastUsed: row.last_used,
        lastScreenWidth: row.last_screen_w,
        lastScreenHeight: row.last_screen_h,
        confidence: Math.min(0.95, 0.7 + row.success_count * 0.05),
    }));
}

/** Stats helper for debugging. */
export function clickMemoryStats(opts?: ClickMemoryOptions): {
    totalSites: number;
    totalApps: number;
    oldestMs: number;
    newestMs: number;
} {
    const db = initClickMemory(opts);
    const row = db
        .prepare(`
        SELECT
            COUNT(*) AS total_sites,
            COUNT(DISTINCT app) AS total_apps,
            MIN(last_used) AS oldest,
            MAX(last_used) AS newest
        FROM click_sites
    `)
        .get() as { total_sites: number; total_apps: number; oldest: number | null; newest: number | null };
    return {
        totalSites: row.total_sites,
        totalApps: row.total_apps,
        oldestMs: row.oldest || 0,
        newestMs: row.newest || 0,
    };
}

/** Test helper — drop all rows. */
export function clearClickMemory(opts?: ClickMemoryOptions): void {
    const db = initClickMemory(opts);
    db.prepare(`DELETE FROM click_sites`).run();
}

export function _getDbPathForTests(): string | null {
    return _dbPath;
}
