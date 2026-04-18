// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Habit Detector — Detects recurring user patterns for proactive automation.
// Uses native Rust time-series analysis for pattern matching.

import type { Database } from "../memory/sqlite.js";

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
        `SELECT content, created_at FROM conversations
         WHERE role = 'user' AND created_at > datetime('now', '-14 days')
         ORDER BY created_at LIMIT 500`, []
    );
    if (!results[0]?.values) return [];

    const events = results[0].values.map(r => {
        const ts = new Date(r[1] as string);
        const content = (r[0] as string || "").toLowerCase();
        const topic = content.includes("code") ? "coding" : content.includes("email") ? "email" :
            content.includes("research") ? "research" : "general";
        return {
            timestamp_ms: ts.getTime(), event_type: topic,
            hour_of_day: ts.getHours() + ts.getMinutes() / 60, day_of_week: ts.getDay(),
        };
    });

    const native = loadNative();
    if (native) {
        const detected = native.detectHabits(events, 3);
        return detected.map((h: any) => ({
            eventType: h.event_type, pattern: h.pattern, typicalHour: h.typical_hour,
            frequency: h.frequency, confidence: h.confidence, nextExpectedMs: h.next_expected_ms,
        }));
    }

    return []; // JS fallback: rely on native module
}

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
