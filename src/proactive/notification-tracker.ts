// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Notification Tracker ─────────────────────────
 * Tracks all proactive messages (briefings, thoughts, alerts) and measures
 * user engagement. Enables adaptive notification timing and fatigue detection.
 */

import type { Database } from "../memory/sqlite.js";
import * as nativeModule from "../../native/index.js";

// ── Types ─────────────────────────────────────

export type NotificationType = "briefing" | "thought" | "monitor_alert" | "proactive";

export interface NotificationLogEntry {
    id: number;
    type: NotificationType;
    content_hash: string;
    sent_at: string;
    user_response_at: string | null;
    response_type: "engaged" | "read_no_reply" | "ignored" | null;
    response_depth: number;
    hour_of_day: number;
    day_of_week: number;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;
const firstMessageHours: number[] = []; // Cache of first-message hours per day

// ── Init ──────────────────────────────────────

export function initNotificationTracker(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS notification_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            content_hash TEXT,
            sent_at TEXT DEFAULT (datetime('now')),
            user_response_at TEXT,
            response_type TEXT,
            response_depth INTEGER DEFAULT 0,
            hour_of_day INTEGER,
            day_of_week INTEGER,
            suppressed_by_dnd INTEGER DEFAULT 0
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_notif_type ON notification_log(type)"); } catch { /* */ }
    try { db.run("CREATE INDEX IF NOT EXISTS idx_notif_sent ON notification_log(sent_at)"); } catch { /* */ }

    // Load first-message hours for wake-time estimation
    loadFirstMessageHours();

    console.log("[NOTIF-TRACKER] Initialized");
}

// ── Record ────────────────────────────────────

export function recordNotification(type: NotificationType, content: string): number {
    if (!db) return 0;

    const now = new Date();
    const hourOfDay = now.getHours();
    const dayOfWeek = now.getDay();
    const hash = simpleHash(content);

    db.run(
        `INSERT INTO notification_log (type, content_hash, hour_of_day, day_of_week)
         VALUES (?, ?, ?, ?)`,
        [type, hash, hourOfDay, dayOfWeek]
    );

    const result = db.exec("SELECT last_insert_rowid() as id");
    return (result[0]?.values[0]?.[0] as number) || 0;
}

export function recordResponse(
    notificationId: number,
    responseType: "engaged" | "read_no_reply" | "ignored",
    depth = 1
): void {
    if (!db) return;
    db.run(
        "UPDATE notification_log SET user_response_at = datetime('now'), response_type = ?, response_depth = ? WHERE id = ?",
        [responseType, depth, notificationId]
    );
}

/**
 * The owner wrote (any channel): every notification of the last 4h still waiting for a
 * response counts as engaged. Called with id 0 before, which matched no row, so nothing was
 * ever engaged and isFatigued() muted every proactive message — urgent ones too — after 5.
 */
export function recordOwnerEngagement(): void {
    if (!db) return;
    db.run(
        `UPDATE notification_log SET user_response_at = datetime('now'), response_type = 'engaged', response_depth = 1
         WHERE user_response_at IS NULL AND sent_at > datetime('now', '-4 hours')`,
        []
    );
}

// ── First Message Tracking (for wake-time) ────

export function recordFirstMessageOfDay(hourOfDay: number): void {
    firstMessageHours.push(hourOfDay);
    // Keep only last 30 days
    while (firstMessageHours.length > 30) firstMessageHours.shift();
}

function loadFirstMessageHours(): void {
    // On init, preload from notification_log if available
    if (!db) return;

    try {
        const results = db.exec(
            `SELECT MIN(hour_of_day) as first_hour
             FROM notification_log
             WHERE type = 'briefing' AND response_type = 'engaged'
             GROUP BY date(sent_at)
             ORDER BY sent_at DESC
             LIMIT 14`,
            []
        );

        if (results[0]?.values) {
            for (const row of results[0].values) {
                if (row[0] !== null) firstMessageHours.push(row[0] as number);
            }
        }
    } catch { /* table might not have data */ }
}

// ── Wake Time Estimation ──────────────────────

export function getEstimatedWakeTime(): {
    meanHour: number;
    stdDev: number;
    briefingHour: number;
    confidence: number;
} {
    try {
        const native = loadNative();
        if (native && firstMessageHours.length > 0) {
            return native.estimateWakeTime(firstMessageHours);
        }
    } catch { /* */ }

    // JS fallback
    if (firstMessageHours.length === 0) {
        return { meanHour: 7, stdDev: 1.5, briefingHour: 6.5, confidence: 0 };
    }

    const mean = firstMessageHours.reduce((a, b) => a + b, 0) / firstMessageHours.length;
    const variance = firstMessageHours.reduce((sum, h) => sum + (h - mean) ** 2, 0) / firstMessageHours.length;
    const stdDev = Math.max(Math.sqrt(variance), 0.25);
    const briefingHour = Math.max(mean - stdDev, 5);
    const confidence = Math.min(firstMessageHours.length / 14, 1) * 0.7;

    return { meanHour: mean, stdDev, briefingHour, confidence };
}

// ── Engagement Stats ──────────────────────────

export function getEngagementRate(type?: NotificationType, daysBack = 14): number {
    if (!db) return 0;

    const typeFilter = type ? `AND type = '${type}'` : "";
    const results = db.exec(
        `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN response_type = 'engaged' THEN 1 ELSE 0 END) as engaged
         FROM notification_log
         WHERE sent_at > datetime('now', '-${daysBack} days') ${typeFilter}`,
        []
    );

    if (!results[0]?.values[0]) return 0;
    const [total, engaged] = results[0].values[0] as [number, number];
    return total > 0 ? engaged / total : 0;
}

// ── Fatigue Detection ─────────────────────────

export function isFatigued(): boolean {
    if (!db) return false;

    const results = db.exec(
        `SELECT COUNT(*) as cnt,
                SUM(CASE WHEN response_type = 'engaged' THEN 1 ELSE 0 END) as engaged
         FROM notification_log
         WHERE sent_at > datetime('now', '-4 hours')`,
        []
    );

    if (!results[0]?.values[0]) return false;
    const [count, engaged] = results[0].values[0] as [number, number];
    return count >= 5 && (engaged / Math.max(count, 1)) < 0.3;
}

// ── Helpers ───────────────────────────────────

function simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}


function loadNative(): any {
    // A static import: `require` doesn't exist in ESM (nor in the esbuild bundle),
    // so the old createRequire path always returned null and the native scorers
    // never ran.
    return nativeModule;
}
