// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Schedule formats supported:
//   "30m" / "2h" / "1d" / "45s"  — one-shot, relative to now
//   "every 30m" / "every 2h"     — recurring interval
//   "0 9 * * *"                  — cron expression (5 or 6 fields)
//   "2026-05-04T15:30:00Z"       — ISO timestamp, absolute one-shot

import cron from "node-cron";

export type ParsedSchedule =
    | { kind: "one-shot"; intervalMs: number }
    | { kind: "interval"; intervalMs: number }
    | { kind: "cron"; cronExpr: string }
    | { kind: "at"; atMs: number };

const DURATION_RE = /^\s*(\d+)\s*([smhd])\s*$/i;
const EVERY_RE = /^\s*every\s+(\d+)\s*([smhd])\s*$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const UNIT_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

export function parseSchedule(input: string): ParsedSchedule {
    if (typeof input !== "string" || input.trim() === "") {
        throw new Error(`invalid schedule: empty input`);
    }
    const raw = input.trim();

    const dur = raw.match(DURATION_RE);
    if (dur) {
        const n = Number.parseInt(dur[1], 10);
        const unit = dur[2].toLowerCase();
        return { kind: "one-shot", intervalMs: n * UNIT_MS[unit] };
    }

    const ev = raw.match(EVERY_RE);
    if (ev) {
        const n = Number.parseInt(ev[1], 10);
        const unit = ev[2].toLowerCase();
        return { kind: "interval", intervalMs: n * UNIT_MS[unit] };
    }

    if (ISO_RE.test(raw)) {
        const t = Date.parse(raw);
        if (!Number.isNaN(t)) {
            return { kind: "at", atMs: t };
        }
    }

    if (cron.validate(raw)) {
        return { kind: "cron", cronExpr: raw };
    }

    throw new Error(`invalid schedule: ${raw}`);
}

// ── Cron next-time computation (minute-resolution) ─────────────
// node-cron doesn't expose a "next fire time" helper, so we compute it by
// walking forward minute-by-minute from `now` and checking which minute
// would fire. Cron fields evaluated: minute, hour, day-of-month, month,
// day-of-week. Covers the 5-field form. For 6-field (with seconds), the
// first field is ignored in next-time computation and the next fire is
// the next MINUTE match — sufficient for ATLAS's scheduling granularity.

function cronFieldMatches(value: number, field: string): boolean {
    if (field === "*") return true;
    // "*/n" step (e.g., */5 matches 0, 5, 10, …)
    if (field.startsWith("*/")) {
        const step = Number.parseInt(field.slice(2), 10);
        return Number.isFinite(step) && step > 0 && value % step === 0;
    }
    // comma-separated list: "0,15,30,45"
    if (field.includes(",")) {
        return field.split(",").some((p) => cronFieldMatches(value, p.trim()));
    }
    // range: "9-17"
    const range = field.match(/^(\d+)-(\d+)$/);
    if (range) {
        const lo = Number.parseInt(range[1], 10);
        const hi = Number.parseInt(range[2], 10);
        return value >= lo && value <= hi;
    }
    const n = Number.parseInt(field, 10);
    return Number.isFinite(n) && n === value;
}

// Cron fields are evaluated in the server's LOCAL timezone, matching
// user intuition: "0 9 * * *" means "9 AM local", not "9 AM UTC".
// node-cron uses local time too. ISO timestamps ("at" kind) remain absolute.
function cronMatches(cronExpr: string, d: Date): boolean {
    const parts = cronExpr.trim().split(/\s+/);
    const fields = parts.length === 6 ? parts.slice(1) : parts;
    if (fields.length !== 5) return false;
    const [minF, hourF, domF, monthF, dowF] = fields;
    return (
        cronFieldMatches(d.getMinutes(), minF) &&
        cronFieldMatches(d.getHours(), hourF) &&
        cronFieldMatches(d.getDate(), domF) &&
        cronFieldMatches(d.getMonth() + 1, monthF) &&
        cronFieldMatches(d.getDay(), dowF)
    );
}

function nextCronRunAt(cronExpr: string, nowMs: number): number {
    // Start from the next full minute after now (inclusive if aligned).
    const start = new Date(nowMs);
    start.setUTCSeconds(0, 0);
    let cursor = start.getTime();
    if (cursor <= nowMs) cursor += 60_000;
    // Cap the scan to 366 days × 24 × 60 = ~527k iterations worst-case,
    // but we break out much sooner for any realistic cron expression.
    const maxIterations = 366 * 24 * 60;
    for (let i = 0; i < maxIterations; i++) {
        if (cronMatches(cronExpr, new Date(cursor))) return cursor;
        cursor += 60_000;
    }
    throw new Error(`cron never fires within a year: ${cronExpr}`);
}

export function nextRunAt(schedule: ParsedSchedule, nowMs: number): number {
    switch (schedule.kind) {
        case "one-shot":
        case "interval":
            return nowMs + schedule.intervalMs;
        case "at":
            return schedule.atMs;
        case "cron":
            return nextCronRunAt(schedule.cronExpr, nowMs);
    }
}
