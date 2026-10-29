// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Goal Persistence ────────────────────────────
 * Tracks user goals with deadlines, progress, and hierarchy.
 * Detects goal-like statements from user messages and persists them.
 * Used by the planner and proactive systems to stay aligned with user intent.
 *
 * Rust counterpart: native/src/goal_engine.rs
 */

import type { Database } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface Goal {
    id: number;
    description: string;
    deadline: string | null;
    status: "active" | "completed" | "abandoned" | "paused";
    progress: number;           // 0-1
    parentGoalId: number | null;
    createdAt: string;
    updatedAt: string;
    tags: string;
}

export interface DetectedGoal {
    description: string;
    deadline: string | null;
    confidence: number;         // 0-1 how confident the detection is
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// Nothing updates progress, so a goal untouched for 30 days counts as stale.
const VISIBLE_GOALS = "status NOT IN ('completed', 'abandoned') AND updated_at > datetime('now', '-30 days')";

// ── Init ──────────────────────────────────────

export function initGoals(database: Database): void {
    db = database;

    // proactive/goal-engine.ts used to share this table name; move its rows out of the way.
    if (db.exec("SELECT 1 FROM pragma_table_info('goals') WHERE name = 'title'").length) {
        db.run("ALTER TABLE goals RENAME TO proactive_goals");
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            deadline TEXT,
            status TEXT DEFAULT 'active',
            progress REAL DEFAULT 0,
            parent_goal_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            tags TEXT DEFAULT ''
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)"); } catch { /* */ }
    try { db.run("CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id)"); } catch { /* */ }

    console.log("[GOALS] Initialized");
}

// ── CRUD Operations ───────────────────────────

/**
 * Create a new goal. Returns the ID of the inserted goal, or -1 if it already exists.
 */
export function createGoal(description: string, deadline?: string, parentGoalId?: number): number {
    if (!db) return -1;

    const dup = db.exec(`SELECT 1 FROM goals WHERE ${VISIBLE_GOALS} AND lower(description) = lower(?)`, [description]);
    if (dup[0]?.values.length) return -1;

    db.run(
        `INSERT INTO goals (description, deadline, parent_goal_id) VALUES (?, ?, ?)`,
        [description, deadline || null, parentGoalId ?? null]
    );

    const results = db.exec("SELECT last_insert_rowid()", []);
    if (!results[0]?.values[0]) return -1;

    const id = results[0].values[0][0] as number;

    // Try native goal engine for priority scoring
    try {
        const native = loadNative();
        if (native?.scoreGoalPriority) {
            const priority = native.scoreGoalPriority({
                title: description,
                description,
                source: "user_explicit",
                evidence_strength: 0.8,
                user_interest_score: 0.7,
                feasibility: 0.8,
                urgency: deadline ? 0.7 : 0.3,
            });
            console.log(`[GOALS] Created goal #${id} (priority: ${priority.final_priority?.toFixed(2) || "N/A"})`);
        }
    } catch { /* */ }

    return id;
}

/**
 * Update goal progress (0-1) and optionally change status.
 */
export function updateGoalProgress(goalId: number, progress: number, status?: Goal["status"]): void {
    if (!db) return;

    const clampedProgress = Math.max(0, Math.min(1, progress));

    if (status) {
        db.run(
            `UPDATE goals SET progress = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
            [clampedProgress, status, goalId]
        );
    } else {
        // Auto-complete if progress reaches 1.0
        const autoStatus = clampedProgress >= 1.0 ? "completed" : undefined;
        if (autoStatus) {
            db.run(
                `UPDATE goals SET progress = ?, status = 'completed', updated_at = datetime('now') WHERE id = ?`,
                [clampedProgress, goalId]
            );
        } else {
            db.run(
                `UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ?`,
                [clampedProgress, goalId]
            );
        }
    }
}

/**
 * Get all non-completed goals, ordered by most recently updated.
 */
export function getActiveGoals(): Goal[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT id, description, deadline, status, progress, parent_goal_id, created_at, updated_at, tags
         FROM goals
         WHERE ${VISIBLE_GOALS}
         ORDER BY updated_at DESC`,
        []
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        id: row[0] as number,
        description: row[1] as string,
        deadline: row[2] as string | null,
        status: row[3] as Goal["status"],
        progress: row[4] as number,
        parentGoalId: row[5] as number | null,
        createdAt: row[6] as string,
        updatedAt: row[7] as string,
        tags: row[8] as string,
    }));
}

/**
 * Get a ~200 token summary of active goals for prompt injection.
 */
export function getGoalsSnippet(): string {
    const goals = getActiveGoals();
    if (goals.length === 0) return "";

    const lines = goals.slice(0, 5).map(g => {
        const pct = g.progress > 0 ? ` — ${Math.round(g.progress * 100)}% done` : "";
        const deadline = g.deadline ? ` (due: ${g.deadline})` : "";
        const status = g.status === "paused" ? " [paused]" : "";
        return `- ${g.description}${pct}${deadline}${status}`;
    });

    const remaining = goals.length - 5;
    if (remaining > 0) {
        lines.push(`- ...and ${remaining} more active goal(s)`);
    }

    return `ACTIVE GOALS:\n${lines.join("\n")}`;
}

// ── Goal Detection ────────────────────────────

// Patterns that signal goal-like intent
const GOAL_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
    { pattern: /\bi (?:need|want|have) to\b/i, weight: 0.7 },
    { pattern: /\bmy goal is\b/i, weight: 0.9 },
    { pattern: /\bi(?:'m| am) (?:trying|planning|aiming) to\b/i, weight: 0.8 },
    { pattern: /\bdeadline (?:is|by)\b/i, weight: 0.6 },
    { pattern: /\bby (?:friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i, weight: 0.5 },
    { pattern: /\bby (?:end of|next|this) (?:week|month|year)\b/i, weight: 0.6 },
    { pattern: /\bbefore (?:the|next)\b/i, weight: 0.4 },
    { pattern: /\bfinish(?:ing)?\b.*\bby\b/i, weight: 0.7 },
    { pattern: /\bcomplete(?:ing)?\b.*\bby\b/i, weight: 0.7 },
    { pattern: /\bship(?:ping)?\b.*\bby\b/i, weight: 0.6 },
    { pattern: /\bmust\b.*\bdone\b/i, weight: 0.6 },
    { pattern: /\bhelp me\b.*\bachieve\b/i, weight: 0.7 },
];

// Deadline extraction patterns
const DEADLINE_PATTERNS: Array<{ pattern: RegExp; extract: (match: RegExpMatchArray) => string }> = [
    { pattern: /\bby (\d{4}-\d{2}-\d{2})\b/i, extract: (m) => m[1] },
    { pattern: /\bby (\d{1,2}\/\d{1,2}\/\d{2,4})\b/i, extract: (m) => m[1] },
    { pattern: /\bdeadline[:\s]+(\w+ \d{1,2}(?:,?\s*\d{4})?)\b/i, extract: (m) => m[1] },
    { pattern: /\bby (next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i, extract: (m) => m[1] },
    { pattern: /\bby (end of (?:this |next )?(?:week|month|year))\b/i, extract: (m) => m[1] },
    { pattern: /\bby (this (?:friday|weekend))\b/i, extract: (m) => m[1] },
];

/**
 * Detect if a user message contains a goal-like statement.
 * Uses keyword heuristics — not LLM-based.
 * Returns null if no goal detected.
 */
export function detectGoalFromMessage(message: string): DetectedGoal | null {
    if (message.length < 10) return null;

    let totalWeight = 0;
    const matchedPatterns: string[] = [];

    for (const { pattern, weight } of GOAL_PATTERNS) {
        if (pattern.test(message)) {
            totalWeight += weight;
            matchedPatterns.push(pattern.source);
        }
    }

    // Need at least some confidence
    const confidence = Math.min(1, totalWeight);
    if (confidence < 0.4) return null;

    // Extract deadline if present
    let deadline: string | null = null;
    for (const { pattern, extract } of DEADLINE_PATTERNS) {
        const match = message.match(pattern);
        if (match) {
            deadline = extract(match);
            break;
        }
    }

    // Extract the goal description (take the core statement)
    let description = message;
    // Try to extract just the goal part from common patterns
    const goalMatch = message.match(/(?:i (?:need|want|have) to|my goal is|i(?:'m| am) (?:trying|planning|aiming) to|help me (?:to )?)\s*(.+?)(?:\.|$)/i);
    if (goalMatch?.[1]) {
        description = goalMatch[1].trim();
        // Remove trailing deadline phrases from the description
        description = description.replace(/\s*by\s+(next\s+)?\w+.*$/i, "").trim();
    }

    // Cap description length
    if (description.length > 200) {
        description = description.substring(0, 200).trim();
    }

    return { description, deadline, confidence };
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
