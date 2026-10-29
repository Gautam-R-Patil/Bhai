// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Goal Engine ──────────────────────────────────
 * Autonomous goal generation and lifecycle management.
 * Inspired by SAGA (Scientific Autonomous Goal-evolving Agent, Dec 2025).
 *
 * Bi-level architecture:
 *   Outer loop (runs during dreaming): proposes new goals from user patterns
 *   Inner loop (runs on heartbeat): generates tasks from active goals
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import type { Database } from "../memory/sqlite.js";
import * as nativeModule from "../../native/index.js";

// ── Types ─────────────────────────────────────

export interface Goal {
    id: number;
    title: string;
    description: string;
    source: "user_explicit" | "pattern_observed" | "curiosity" | "dream";
    priority: number;
    status: "proposed" | "accepted" | "active" | "completed" | "abandoned";
    parentGoalId: number | null;
    evidence: string;
    progress: number;
    createdAt: string;
    updatedAt: string;
}

export interface GoalTask {
    id: number;
    goalId: number;
    description: string;
    status: "pending" | "in_progress" | "completed" | "failed";
    result: string | null;
    createdAt: string;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function initGoalEngine(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS proactive_goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            source TEXT DEFAULT 'pattern_observed',
            priority REAL DEFAULT 0.5,
            status TEXT DEFAULT 'proposed',
            parent_goal_id INTEGER,
            evidence TEXT,
            progress REAL DEFAULT 0.0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS goal_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            result TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (goal_id) REFERENCES proactive_goals(id)
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_proactive_goals_status ON proactive_goals(status)"); } catch { /* */ }
    try { db.run("CREATE INDEX IF NOT EXISTS idx_goal_tasks_status ON goal_tasks(status)"); } catch { /* */ }

    console.log("[GOAL-ENGINE] Initialized");
}

// ── Outer Loop: Goal Proposal ─────────────────

/**
 * Generate new goal proposals based on user patterns, knowledge graph, and context.
 * Runs during dreaming or quiet periods.
 */
export async function proposeGoals(
    llm: LLMClient,
    userContext: string,
    recentTopics: string[]
): Promise<Goal[]> {
    if (!db) return [];

    // Get existing goals to avoid duplicates
    const existingGoals = getGoalsByStatus(["proposed", "accepted", "active"]);
    const existingTitles = existingGoals.map(g => g.title.toLowerCase());

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Based on this user context, suggest 1-3 proactive goals the agent could pursue:

USER CONTEXT:
${userContext}

RECENT TOPICS: ${recentTopics.join(", ")}

EXISTING GOALS (avoid duplicates):
${existingGoals.map(g => `- ${g.title} (${g.status})`).join("\n") || "None"}

For each goal, provide:
GOAL: [title]
DESCRIPTION: [1-2 sentences]
SOURCE: [pattern_observed or curiosity]
EVIDENCE: [what observation led to this suggestion]

Only suggest goals that are genuinely useful and actionable. If nothing is worth suggesting, respond with "NONE".`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are the goal-generation module of a personal AI agent. Suggest autonomous goals based on user patterns.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        if (content.trim() === "NONE") return [];

        return parseGoalProposals(content, existingTitles);
    } catch (err) {
        console.warn("[GOAL-ENGINE] Goal proposal failed:", (err as Error).message);
        return [];
    }
}

function parseGoalProposals(response: string, existingTitles: string[]): Goal[] {
    const goals: Goal[] = [];
    const blocks = response.split(/GOAL:\s*/i).filter(b => b.trim());

    for (const block of blocks.slice(0, 3)) {
        const title = block.split("\n")[0].trim();
        const descMatch = block.match(/DESCRIPTION:\s*(.+)/i);
        const sourceMatch = block.match(/SOURCE:\s*(\w+)/i);
        const evidenceMatch = block.match(/EVIDENCE:\s*(.+)/i);

        if (!title || title.length < 5) continue;
        if (existingTitles.includes(title.toLowerCase())) continue;

        const goal = saveGoal({
            title,
            description: descMatch?.[1]?.trim() || "",
            source: (sourceMatch?.[1]?.trim() || "pattern_observed") as Goal["source"],
            evidence: evidenceMatch?.[1]?.trim() || "",
            priority: 0.5,
        });

        if (goal) goals.push(goal);
    }

    return goals;
}

// ── Goal Lifecycle ────────────────────────────

export function saveGoal(data: {
    title: string;
    description: string;
    source: Goal["source"];
    evidence: string;
    priority: number;
}): Goal | null {
    if (!db) return null;

    db.run(
        `INSERT INTO proactive_goals (title, description, source, evidence, priority)
         VALUES (?, ?, ?, ?, ?)`,
        [data.title, data.description, data.source, data.evidence, data.priority]
    );

    const result = db.exec("SELECT last_insert_rowid() as id");
    const id = (result[0]?.values[0]?.[0] as number) || 0;
    if (id === 0) return null;

    console.log(`[GOAL-ENGINE] New goal #${id}: "${data.title}" (${data.source})`);

    return {
        id,
        title: data.title,
        description: data.description,
        source: data.source,
        priority: data.priority,
        status: "proposed",
        parentGoalId: null,
        evidence: data.evidence,
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

export function updateGoalStatus(goalId: number, status: Goal["status"]): void {
    if (!db) return;
    db.run("UPDATE proactive_goals SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, goalId]);
}

export function updateGoalProgress(goalId: number, progress: number): void {
    if (!db) return;
    db.run("UPDATE proactive_goals SET progress = ?, updated_at = datetime('now') WHERE id = ?", [Math.min(1, progress), goalId]);
}

// ── Query ─────────────────────────────────────

export function getGoalsByStatus(statuses: string[]): Goal[] {
    if (!db) return [];

    const placeholders = statuses.map(() => "?").join(",");
    const results = db.exec(
        `SELECT id, title, description, source, priority, status, parent_goal_id,
                evidence, progress, created_at, updated_at
         FROM proactive_goals WHERE status IN (${placeholders})
         ORDER BY priority DESC`,
        statuses
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        id: row[0] as number,
        title: row[1] as string,
        description: row[2] as string,
        source: row[3] as Goal["source"],
        priority: row[4] as number,
        status: row[5] as Goal["status"],
        parentGoalId: row[6] as number | null,
        evidence: row[7] as string,
        progress: row[8] as number,
        createdAt: row[9] as string,
        updatedAt: row[10] as string,
    }));
}

export function getActiveGoals(): Goal[] {
    return getGoalsByStatus(["active", "accepted"]);
}

export function getGoalTasks(goalId: number): GoalTask[] {
    if (!db) return [];

    const results = db.exec(
        `SELECT id, goal_id, description, status, result, created_at
         FROM goal_tasks WHERE goal_id = ? ORDER BY created_at`,
        [goalId]
    );

    if (!results[0]?.values) return [];

    return results[0].values.map(row => ({
        id: row[0] as number,
        goalId: row[1] as number,
        description: row[2] as string,
        status: row[3] as GoalTask["status"],
        result: row[4] as string | null,
        createdAt: row[5] as string,
    }));
}

// ── Goal Decay (via Rust) ─────────────────────

export function applyGoalDecay(): void {
    if (!db) return;

    const activeGoals = getGoalsByStatus(["proposed", "accepted", "active"]);
    if (activeGoals.length === 0) return;

    try {
        const native = loadNative();
        if (native) {
            const nativeGoals = activeGoals.map(g => ({
                id: g.id,
                title: g.title,
                priority: g.priority,
                progress: g.progress,
                daysSinceUpdate: (Date.now() - new Date(g.updatedAt).getTime()) / 86400000, // napi: camelCase
                source: g.source,
            }));

            const results = native.applyGoalDecay(nativeGoals);

            for (const [goalId, newPriority, shouldAbandon] of results) {
                if (shouldAbandon > 0) {
                    updateGoalStatus(goalId, "abandoned");
                    console.log(`[GOAL-ENGINE] Abandoned goal #${goalId} (priority decayed to 0)`);
                } else {
                    db.run("UPDATE proactive_goals SET priority = ?, updated_at = datetime('now') WHERE id = ?",
                        [newPriority, goalId]);
                }
            }
        }
    } catch { /* native not available */ }
}

// ── Native Module ─────────────────────────────


function loadNative(): any {
    // A static import: `require` doesn't exist in ESM (nor in the esbuild bundle),
    // so the old createRequire path always returned null and the native scorers
    // never ran.
    return nativeModule;
}
