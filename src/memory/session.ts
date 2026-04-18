// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Session / Working Memory ──────────────────
// Lightweight session state with rolling summary.
// Persisted to SQLite so sessions survive bot restarts.

import { getRawDb } from "./sqlite.js";
import { generateUUID } from "../utils/uuid.js";

// ── Types ─────────────────────────────────────

export interface TurnEntry {
    role: "user" | "assistant";
    content: string;
    ts: number;
}

export interface SessionState {
    session_id: string;
    current_goal: string;
    started_at: string;
    last_activity: string;
    turn_count: number;
    short_summary: string;        // Rolling compressed summary
    recent_turns: TurnEntry[];    // Buffer of recent turns
}

// ── Constants ─────────────────────────────────

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes
const MAX_RECENT_TURNS = 6;                   // Buffer before compression
const MAX_SHORT_SUMMARY_CHARS = 1600;         // ~400 tokens at 4 chars/token
const COMPRESS_SENTENCE_LIMIT = 200;          // Target chars per compressed chunk

// Simple UUID v4
// generateId moved to ../utils/uuid.ts as generateUUID

// ── State ─────────────────────────────────────

let currentSession: SessionState | null = null;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

// ── Persistence Helpers ───────────────────────

/** Debounced write of current session to SQLite (100ms delay to batch rapid mutations) */
function persistSession(): void {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
        _persistTimer = null;
        if (!currentSession) return;
        const raw = getRawDb();
        if (!raw) return;
        try {
            raw.prepare(`
                INSERT OR REPLACE INTO sessions
                (session_id, current_goal, started_at, last_activity, turn_count, short_summary, recent_turns_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                currentSession.session_id,
                currentSession.current_goal,
                currentSession.started_at,
                currentSession.last_activity,
                currentSession.turn_count,
                currentSession.short_summary,
                JSON.stringify(currentSession.recent_turns),
            );
        } catch (err) {
            console.warn("[SESSION] Persist failed:", (err as Error).message);
        }
    }, 100);
}

/** Load the most recent session from SQLite (if within timeout) */
function loadLastSession(): SessionState | null {
    const raw = getRawDb();
    if (!raw) return null;
    try {
        const row = raw.prepare(
            `SELECT session_id, current_goal, started_at, last_activity, turn_count, short_summary, recent_turns_json
             FROM sessions ORDER BY last_activity DESC LIMIT 1`
        ).get() as {
            session_id: string; current_goal: string; started_at: string;
            last_activity: string; turn_count: number; short_summary: string;
            recent_turns_json: string;
        } | undefined;

        if (!row) return null;

        // Check if within timeout
        const lastActivity = new Date(row.last_activity).getTime();
        if (Date.now() - lastActivity > SESSION_TIMEOUT_MS) return null;

        return {
            session_id: row.session_id,
            current_goal: row.current_goal,
            started_at: row.started_at,
            last_activity: row.last_activity,
            turn_count: row.turn_count,
            short_summary: row.short_summary,
            recent_turns: JSON.parse(row.recent_turns_json || "[]"),
        };
    } catch {
        return null;
    }
}

// ── Start Session ─────────────────────────────

export function startSession(): SessionState {
    const now = new Date().toISOString();
    currentSession = {
        session_id: generateUUID(),
        current_goal: "",
        started_at: now,
        last_activity: now,
        turn_count: 0,
        short_summary: "",
        recent_turns: [],
    };
    console.log(`📋 Session started: ${currentSession.session_id}`);
    persistSession();
    return currentSession;
}

// ── Get Session ───────────────────────────────

export function getSessionState(): SessionState | null {
    if (!currentSession) return null;

    const lastActivity = new Date(currentSession.last_activity).getTime();
    const elapsed = Date.now() - lastActivity;

    if (elapsed > SESSION_TIMEOUT_MS) {
        console.log(`📋 Session expired after ${Math.round(elapsed / 60000)}min inactivity`);
        return null;
    }

    return currentSession;
}

// ── Touch Session ─────────────────────────────

/**
 * Called on every user message. Creates session if needed.
 * Returns whether this is a new session + the expired session (for reflection).
 */
export function touchSession(_userMessage: string): {
    isNew: boolean;
    session: SessionState;
    expiredSession: SessionState | null;
} {
    // On first call after restart, try to load from DB
    if (!currentSession) {
        const loaded = loadLastSession();
        if (loaded) {
            currentSession = loaded;
            console.log(`📋 Session restored from DB: ${loaded.session_id} (${loaded.turn_count} turns)`);
        }
    }

    const existing = getSessionState();

    if (!existing) {
        // Capture expired session before clearing
        const expired = currentSession; // May be non-null but timed out
        const session = startSession();
        session.turn_count = 1;
        return { isNew: true, session, expiredSession: expired };
    }

    existing.last_activity = new Date().toISOString();
    existing.turn_count++;
    persistSession();
    return { isNew: false, session: existing, expiredSession: null };
}

// ── Append Turn ───────────────────────────────

/**
 * Record a turn in the session buffer.
 * When buffer exceeds MAX_RECENT_TURNS, compress oldest turns into short_summary.
 */
export function appendTurn(role: "user" | "assistant", content: string): void {
    if (!currentSession) return;

    // Truncate very long content for the buffer
    const truncated = content.length > 500 ? content.substring(0, 497) + "..." : content;

    currentSession.recent_turns.push({
        role,
        content: truncated,
        ts: Date.now(),
    });

    // Compress when buffer exceeds limit
    if (currentSession.recent_turns.length > MAX_RECENT_TURNS) {
        compressOldestTurns();
    }

    persistSession();
}

// ── Compression ───────────────────────────────

function compressOldestTurns(): void {
    if (!currentSession || currentSession.recent_turns.length <= 2) return;

    // Take the oldest 2 turns and compress into a summary sentence
    const oldest = currentSession.recent_turns.splice(0, 2);
    const compressed = oldest
        .map(t => `${t.role === "user" ? "User" : "AI"}: ${t.content.substring(0, 100)}`)
        .join(" → ");

    // Heuristic compression: extract key info
    const sentence = heuristicCompress(compressed);

    if (currentSession.short_summary) {
        currentSession.short_summary += " " + sentence;
    } else {
        currentSession.short_summary = sentence;
    }

    // If short_summary exceeds limit, recompress
    if (currentSession.short_summary.length > MAX_SHORT_SUMMARY_CHARS) {
        currentSession.short_summary = recompressSummary(currentSession.short_summary);
    }
}

/**
 * Heuristic compression: truncate and clean up a turn pair into ~50 tokens.
 */
function heuristicCompress(text: string): string {
    // Take first COMPRESS_SENTENCE_LIMIT characters using spread to handle multi-byte chars safely
    let trimmed = [...text].slice(0, COMPRESS_SENTENCE_LIMIT).join("");
    const lastPeriod = trimmed.lastIndexOf(".");
    const lastQuestion = trimmed.lastIndexOf("?");
    const lastBreak = Math.max(lastPeriod, lastQuestion);

    if (lastBreak > COMPRESS_SENTENCE_LIMIT * 0.4) {
        trimmed = trimmed.substring(0, lastBreak + 1);
    } else {
        trimmed = trimmed.trimEnd() + ".";
    }

    return trimmed;
}

/**
 * When short_summary exceeds budget, keep only the most recent ~60%.
 */
function recompressSummary(summary: string): string {
    const target = Math.floor(MAX_SHORT_SUMMARY_CHARS * 0.6);
    const sentences = summary.split(/(?<=[.!?])\s+/);

    // Keep the last N sentences that fit within target
    const kept: string[] = [];
    let totalLen = 0;

    for (let i = sentences.length - 1; i >= 0; i--) {
        if (totalLen + sentences[i].length > target) break;
        kept.unshift(sentences[i]);
        totalLen += sentences[i].length;
    }

    return kept.join(" ");
}

// ── Update Goal ───────────────────────────────

export function updateSessionGoal(goal: string): void {
    if (!currentSession) return;
    currentSession.current_goal = goal;
    persistSession();
}

// ── End Session ───────────────────────────────

export function endSession(): SessionState | null {
    // Cancel any pending persist timer to prevent stale writes to a new session
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    const session = currentSession;
    currentSession = null;
    if (session) {
        console.log(`📋 Session ended: ${session.session_id} (${session.turn_count} turns)`);
    }
    return session;
}

// ── Get Short Summary ─────────────────────────

/**
 * Returns the rolling short summary for reflection input.
 * Combines short_summary + recent_turns into a complete picture.
 */
export function getShortSummary(): string {
    if (!currentSession) return "";

    const parts: string[] = [];

    if (currentSession.short_summary) {
        parts.push(currentSession.short_summary);
    }

    // Add recent turns as brief lines
    if (currentSession.recent_turns.length > 0) {
        const recentText = currentSession.recent_turns
            .map(t => `${t.role === "user" ? "User" : "AI"}: ${t.content.substring(0, 100)}`)
            .join("; ");
        parts.push(recentText);
    }

    return parts.join(" | ");
}

// ── Summary for Prompt Injection ──────────────

export function getSessionSummary(): string {
    const session = getSessionState();
    if (session) {
        const parts: string[] = [];

        if (session.current_goal) {
            parts.push(`- Current goal: ${session.current_goal}`);
        }

        if (session.short_summary) {
            // Truncate for prompt injection (just the last portion)
            const summaryPreview = session.short_summary.length > 300
                ? "..." + session.short_summary.slice(-297)
                : session.short_summary;
            parts.push(`- Session context: ${summaryPreview}`);
        }

        parts.push(`- Session turns: ${session.turn_count}`);

        const elapsed = Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000);
        parts.push(`- Session duration: ${elapsed} min`);

        if (parts.length === 0) return "";

        return "📋 ACTIVE SESSION:\n" + parts.join("\n");
    }

    // Fallback: load previous session summary from DB so new sessions have context
    try {
        const lastSession = loadLastSession();
        if (lastSession && lastSession.short_summary) {
            const parts: string[] = [];
            if (lastSession.current_goal) {
                parts.push(`- Previous goal: ${lastSession.current_goal}`);
            }
            parts.push(`- Previous session context: ${lastSession.short_summary.substring(0, 400)}`);
            parts.push(`- Previous session turns: ${lastSession.turn_count}`);
            return "📋 PREVIOUS SESSION (for continuity):\n" + parts.join("\n");
        }
    } catch { /* no previous session available */ }

    return "";
}

// ── Check if session should trigger reflection ─

export function shouldReflect(): boolean {
    const session = getSessionState();
    if (!session) return false;

    // Reflect every 15 turns (slightly more frequent than before)
    return session.turn_count > 0 && session.turn_count % 15 === 0;
}

// ── Session Timeout Warning ────────────────────

/**
 * Returns minutes until session expires (null if no session).
 * Used to warn users about impending context loss.
 */
export function getSessionTimeRemaining(): number | null {
    if (!currentSession) return null;

    const lastActivity = new Date(currentSession.last_activity).getTime();
    const elapsed = Date.now() - lastActivity;
    const remaining = SESSION_TIMEOUT_MS - elapsed;

    return remaining > 0 ? Math.floor(remaining / 60000) : 0;
}

/**
 * Check if we should warn the user about session expiry.
 * Returns true if session is between 5-8 minutes from expiry.
 */
export function shouldWarnSessionExpiry(): boolean {
    const remaining = getSessionTimeRemaining();
    if (remaining === null) return false;

    // Warn when 5-8 minutes remaining (once per session)
    return remaining >= 5 && remaining <= 8;
}
