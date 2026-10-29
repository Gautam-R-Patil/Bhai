// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Channel, IntentSource } from "./intent.js";

function isTrue(v: string | undefined): boolean {
    return v === "true" || v === "1";
}

function parseCsv(v: string | undefined): Set<string> {
    if (!v) return new Set();
    return new Set(
        v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

export function isProactiveDisabled(): boolean {
    return isTrue(process.env.ATLAS_PROACTIVE_DISABLE);
}

export function isSourceDisabled(src: IntentSource): boolean {
    return parseCsv(process.env.ATLAS_PROACTIVE_DISABLE_SOURCES).has(src);
}

export function isChannelDisabled(ch: Channel): boolean {
    return parseCsv(process.env.ATLAS_PROACTIVE_DISABLE_CHANNELS).has(ch);
}

export function isShadowMode(): boolean {
    return isTrue(process.env.ATLAS_PROACTIVE_SHADOW);
}

// ── Timed quiet ──
// "shut up" is permanent; "not now" or a serious moment holds non-urgent sends
// for a while. Read by the observer's DND and dispatch, so urgent still passes.
// Not by dnd.ts: every Telegram/overlay send goes through it, asked-for ones too.
// ponytail: in-memory, so a restart clears it; persist next to cfg.quiet if that matters.
let quietUntil = 0;

/** Hold non-urgent proactive sends until `ms` (the later deadline wins). */
export function setQuietUntil(ms: number): void {
    quietUntil = Math.max(quietUntil, ms);
}

export function isQuietNow(now = Date.now()): boolean {
    return now < quietUntil;
}

// The owner brushing Bhai off in their own words. A few words and no question
// only, so "busy, book the tatkal ticket for me" or "later today remind me to
// file the GST return" isn't one.
const BUSY_RE = /^\s*(not now|busy|later|in a meeting|can'?t talk|abhi nahi|baad me(in)?)\b/i;

/** An owner message like "not now" or "busy" quiets proactive sends for 2h. */
export function noteOwnerBusy(text: string, now = Date.now()): void {
    if (text.trim().split(/\s+/).length <= 4 && !text.includes("?") && BUSY_RE.test(text))
        setQuietUntil(now + 2 * 3_600_000);
}

/** "bhai resume": the owner wants Bhai back now. */
export function clearQuiet(): void {
    quietUntil = 0;
}

// ── Log rotation state ────────────────────────────────

const LOG_DIR = (): string =>
    process.env.ATLAS_DATA_DIR ? join(process.env.ATLAS_DATA_DIR, "logs") : join(process.cwd(), "data", "logs");

const LOG_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60_000; // once per hour max
const LOG_FILE_PATTERN = /^proactive-(\d{4}-\d{2}-\d{2})\.log$/;

let lastPruneMs = 0;

function todayStr(): string {
    return new Date().toISOString().slice(0, 10);
}

function currentLogPath(): string {
    return join(LOG_DIR(), `proactive-${todayStr()}.log`);
}

function pruneOldLogs(): void {
    const now = Date.now();
    if (now - lastPruneMs < PRUNE_INTERVAL_MS) return;
    lastPruneMs = now;
    try {
        const dir = LOG_DIR();
        if (!existsSync(dir)) return;
        const files = readdirSync(dir);
        const cutoffMs = now - LOG_RETENTION_DAYS * 86_400_000;
        for (const f of files) {
            const m = f.match(LOG_FILE_PATTERN);
            if (!m) continue;
            const path = join(dir, f);
            try {
                const s = statSync(path);
                if (s.mtimeMs < cutoffMs) unlinkSync(path);
            } catch {
                // file disappeared or inaccessible — skip
            }
        }
    } catch {
        // directory unreadable — skip
    }
}

function writeJsonLine(event: string, ctx: Record<string, unknown>): void {
    try {
        const dir = LOG_DIR();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ts: Date.now(), event, ...ctx }) + "\n";
        appendFileSync(currentLogPath(), line);
        pruneOldLogs();
    } catch {
        // fs error — silent; console log path still ran
    }
}

export function debugProactive(event: string, ctx: Record<string, unknown>): void {
    if (process.env.ATLAS_PROACTIVE_DEBUG === "false") return;
    const flat = Object.entries(ctx)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
    console.log(`🔔 [proactive] ${event} | ${flat}`);
    writeJsonLine(event, ctx);
}

// ── Test helpers (named _ prefixed so they can't collide with real exports) ──

export function _resetProactiveLogPruneTimerForTests(): void {
    lastPruneMs = 0;
}
