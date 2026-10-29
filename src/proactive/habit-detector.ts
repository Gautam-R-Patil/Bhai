// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Habit Detector — Detects recurring user patterns for proactive automation.
// Uses native Rust time-series analysis for pattern matching.

import { type Database, dbTimeMs } from "../memory/sqlite.js";
import * as nativeModule from "../../native/index.js";

export interface Habit {
    eventType: string;
    pattern: string;
    typicalHour: number;
    frequency: number;
    confidence: number;
    nextExpectedMs: number;
}

export function detectHabits(db: Database): Habit[] {
    // Get interaction events from last 14 days
    const results = db.exec(
        `SELECT content, created_at FROM conversation_messages
         WHERE role = 'user' AND datetime(created_at) > datetime('now', '-14 days')
         ORDER BY created_at LIMIT 500`, []
    );
    if (!results[0]?.values) return [];

    const events = results[0].values.map(r => {
        const ts = new Date(dbTimeMs(r[1] as string));
        const content = (r[0] as string || "").toLowerCase();
        const topic = content.includes("code") ? "coding" : content.includes("email") ? "email" :
            content.includes("research") ? "research" : "general";
        // napi field names are camelCase (snake_case made every call throw).
        return {
            timestampMs: ts.getTime(), eventType: topic,
            hourOfDay: ts.getHours() + ts.getMinutes() / 60, dayOfWeek: ts.getDay(),
        };
    });

    const native = loadNative();
    if (native) {
        let detected: any[];
        try {
            detected = native.detectHabits(events, 3);
        } catch {
            return [];
        }
        return detected.map((h: any) => ({
            eventType: h.eventType, pattern: h.pattern, typicalHour: h.typicalHour,
            frequency: h.frequency, confidence: h.confidence, nextExpectedMs: h.nextExpectedMs,
        }));
    }

    return []; // JS fallback: rely on native module
}

function loadNative(): any {
    // A static import: `require` doesn't exist in ESM (nor in the esbuild bundle),
    // so the old createRequire path always returned null and the native scorers
    // never ran.
    return nativeModule;
}
