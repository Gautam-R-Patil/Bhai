// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Automated Night Dreaming ─────────────────
// A proactive "sleep agent" that:
// 1. Detects when the user goes idle during night hours
// 2. Harvests pending tasks from recent conversations
// 3. Executes them in the background using long-task infrastructure
// 4. Delivers results when the user wakes up (first morning message)
//
// Also runs memory consolidation (dream replay) during the night.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { selectForPlanning } from "../model-router.js";
import { extractJSON } from "../utils/json-extract.js";
import { getTimezone } from "../location/index.js";
import { _selfEditIsUserFacing } from "./dreaming-self-edit.js";

// ── Configuration ────────────────────────────

/** Night hours (local timezone) when dreaming can activate. */
const NIGHT_START_HOUR = 23; // 11 PM
const NIGHT_END_HOUR = 6;   // 6 AM

/** Minutes of user inactivity before considering them "asleep". */
const SLEEP_IDLE_MINUTES = 120; // 2 hours

/** Maximum dream tasks to execute per night. */
const MAX_DREAM_TASKS = 3;

/** Maximum time budget for all dream tasks combined (ms). */
const DREAM_BUDGET_MS = 30 * 60_000; // 30 minutes

// ── State ────────────────────────────────────

let lastUserMessageTime = Date.now();
let dreamingActive = false;
let dreamedTonight = false;

/** Check if dreaming is currently in progress (used by other subsystems to avoid conflicts). */
export function isDreamingActive(): boolean { return dreamingActive; }
let todayDate = "";
let dreamResults: DreamResult[] = [];
let onDreamComplete: ((results: DreamResult[]) => Promise<void>) | null = null;

export interface DreamResult {
    task: string;
    result: string;
    success: boolean;
    durationMs: number;
}

// ── User Activity Tracking ───────────────────

/** Call this every time the user sends a message. */
export function recordUserActivity(): void {
    lastUserMessageTime = Date.now();
}

/** Set the callback for delivering dream results. */
export function setDreamDeliveryHandler(handler: (results: DreamResult[]) => Promise<void>): void {
    onDreamComplete = handler;
}

// ── Sleep Detection ──────────────────────────

/** Check if the user appears to be asleep (idle during night hours). */
function isUserAsleep(): boolean {
    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: getTimezone() }));
    const hour = nowLocal.getHours();

    // Must be during night hours
    const isNightTime = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
    if (!isNightTime) return false;

    // Must be idle for SLEEP_IDLE_MINUTES
    const idleMs = Date.now() - lastUserMessageTime;
    return idleMs >= SLEEP_IDLE_MINUTES * 60_000;
}

/** Check if we already dreamed tonight (reset at noon). */
function resetDailyState(): void {
    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: getTimezone() }));
    const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
    if (today !== todayDate) {
        todayDate = today;
        dreamedTonight = false;
        dreamResults = [];
    }
}

// ── Task Harvesting ──────────────────────────

/**
 * Scan recent conversation context for tasks the agent should work on overnight.
 * Uses LLM to identify: unanswered questions, pending research, promised follow-ups.
 */
async function harvestDreamTasks(
    llm: LLMClient,
    recentContext: string,
): Promise<string[]> {
    if (!recentContext || recentContext.length < 50) return [];

    const prompt = `Review this recent conversation and identify tasks that could be done in the background while the user sleeps. Look for:

1. Unanswered questions the user asked that weren't fully resolved
2. Research topics that were mentioned but not explored
3. Things you promised to follow up on
4. Data gathering or analysis that would take time

Return a JSON array of task descriptions (max ${MAX_DREAM_TASKS} tasks). Each should be a self-contained description that an agent can execute independently.

If there are NO pending tasks, return an empty array: []

Recent conversation:
${recentContext.substring(0, 3000)}

Output ONLY valid JSON array:`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You identify pending tasks from conversations. Output valid JSON arrays only.",
            modelOverride: selectForPlanning("harvest dream tasks").modelId,
        });

        const text = response.choices?.[0]?.message?.content || "[]";
        const jsonStr = extractJSON(text);
        if (!jsonStr) return [];

        const tasks = JSON.parse(jsonStr);
        if (!Array.isArray(tasks)) return [];

        return tasks
            .filter((t: unknown) => typeof t === "string" && t.length > 10)
            .slice(0, MAX_DREAM_TASKS);
    } catch {
        return [];
    }
}

// ── Night Worker ─────────────────────────────

/**
 * Execute a single dream task using a sub-agent.
 */
async function executeDreamTask(
    llm: LLMClient,
    taskDescription: string,
): Promise<DreamResult> {
    const startTime = Date.now();

    try {
        const { runSubAgent } = await import("../agents/sub-agent.js");

        const result = await runSubAgent(llm, {
            id: `dream_${Date.now()}`,
            role: "researcher", // Dreams are typically research/planning tasks
            description: `[BACKGROUND TASK — User is sleeping] ${taskDescription}\n\nBe thorough but concise. The user will see these results when they wake up.`,
            maxIterations: 30,
            timeoutMs: Math.min(DREAM_BUDGET_MS / MAX_DREAM_TASKS, 10 * 60_000), // Max 10 min per task
        });

        return {
            task: taskDescription,
            result: result.output,
            success: result.success,
            durationMs: Date.now() - startTime,
        };
    } catch (err) {
        return {
            task: taskDescription,
            result: (err as Error).message,
            success: false,
            durationMs: Date.now() - startTime,
        };
    }
}

// ── Dream Orchestrator ───────────────────────

/**
 * Run the full dreaming pipeline:
 * 1. Run memory consolidation (dream replay)
 * 2. Harvest and execute background tasks
 * 3. Queue results for morning delivery
 */
async function runDreaming(llm: LLMClient, recentContext: string): Promise<void> {
    if (dreamingActive || dreamedTonight) return;
    dreamingActive = true;

    console.log("[DREAMING] 🌙 Night dreaming starting...");

    try {
        // Step 1: Memory consolidation (dream replay)
        try {
            const { runDreamReplay } = await import("../memory/reflection.js");
            await runDreamReplay(llm);
            console.log("[DREAMING] 💭 Dream replay completed");

            // Record dream replay as a thought in the journal
            try {
                const { recordThought } = await import("./thought-journal.js");
                recordThought(
                    "Dream replay: consolidated and reorganized recent memories during sleep cycle.",
                    "dream_replay",
                    { relevance: 0.3, urgency: 0, novelty: 0.2, appropriateness: 1, composite: 0.3 },
                    "suppressed"
                );
            } catch { /* thought journal not initialized — skip */ }
        } catch (err) {
            console.warn("[DREAMING] Dream replay failed:", (err as Error).message);
        }

        // Step 1b: SleepGate consolidation (conflict detection, selective forgetting, merging)
        try {
            const { runSleepGateConsolidation } = await import("../memory/sleep-gate.js");
            const { initMemoryDB } = await import("../memory/sqlite.js");
            const memDb = await initMemoryDB();
            const sgResult = await runSleepGateConsolidation(memDb);
            console.log(`[DREAMING] 🧹 SleepGate: ${sgResult.totalProcessed} processed, ${sgResult.conflictsDetected} conflicts, ${sgResult.memoriesForgotten} forgotten, ${sgResult.memoriesStrengthened} strengthened`);
        } catch (err) {
            console.warn("[DREAMING] SleepGate consolidation failed (non-fatal):", (err as Error).message);
        }

        // Step 1c: Knowledge graph relationship decay
        try {
            const { decayRelationships } = await import("../memory/knowledge-graph.js");
            const { initMemoryDB: getMemDb } = await import("../memory/sqlite.js");
            const kgDb = await getMemDb();
            decayRelationships(kgDb, 0.005); // gentle decay during dream
            console.log("[DREAMING] 🔗 Knowledge graph relationships decayed");
        } catch (err) {
            console.warn("[DREAMING] KG decay failed (non-fatal):", (err as Error).message);
        }

        // Step 2: Harvest pending tasks from conversation
        const tasks = await harvestDreamTasks(llm, recentContext);

        if (tasks.length === 0) {
            console.log("[DREAMING] 😴 No pending tasks found — just consolidated memories");
            dreamResults.push({
                task: "Memory consolidation",
                result: "Organized and consolidated recent memories while you slept.",
                success: true,
                durationMs: 0,
            });
        } else {
            console.log(`[DREAMING] 📋 Found ${tasks.length} tasks to work on overnight`);

            // Step 3: Execute tasks sequentially
            for (const taskDesc of tasks) {
                console.log(`[DREAMING] 🔧 Working on: ${taskDesc.substring(0, 80)}...`);
                const result = await executeDreamTask(llm, taskDesc);
                dreamResults.push(result);

                const status = result.success ? "✅" : "❌";
                console.log(`[DREAMING] ${status} Task done (${(result.durationMs / 1000).toFixed(1)}s)`);

                // Record dream task reflection in thought journal
                try {
                    const { recordThought } = await import("./thought-journal.js");
                    recordThought(
                        `Dream task ${result.success ? "completed" : "failed"}: ${taskDesc.substring(0, 200)}`,
                        "dream_task",
                        { relevance: 0.5, urgency: 0, novelty: 0.4, appropriateness: 1, composite: 0.4 },
                        "suppressed"
                    );
                } catch { /* thought journal not initialized — skip */ }
            }
        }

        // ── Step 4: Self-Edit Proposal — suggest instruction improvements from failure patterns ──
        try {
            const { proposeSelfEdit } = await import("../agents/self-editor.js");
            const { recall } = await import("../memory/sqlite.js");

            // Look for repeated failures in recent memories
            const recentFailures = await recall("failed error repeated", 10);
            const failureMessages = recentFailures
                .filter((m: any) => m.content && (m.content.includes("failed") || m.content.includes("error")))
                .map((m: any) => m.content);

            if (failureMessages.length >= 2) {
                console.log(`[DREAMING] 🔧 Found ${failureMessages.length} failure patterns — proposing self-edit...`);
                const { fetchSystemPrompt } = await import("../config/system-prompts.js");
                const full = await fetchSystemPrompt("rules");
                const rulesContent = full.substring(0, 1000);
                const rulesPath = "convex://system_prompts/rules";

                if (rulesContent) {
                    const edit = await proposeSelfEdit(
                        llm,
                        failureMessages[0],
                        failureMessages.slice(0, 3),
                        rulesContent,
                        rulesPath,
                    );
                    if (edit) {
                        const { appendSelfEditAudit, _recordSelfEditActuation } =
                            await import("./dreaming-self-edit.js");
                        const { remember } = await import("../memory/sqlite.js");
                        await appendSelfEditAudit(edit);
                        try {
                            remember(
                                _recordSelfEditActuation(edit),
                                "self-lesson",
                                "self-edit,dreaming",
                                8,
                                "reflection",
                            );
                            console.log(
                                `[DREAMING] 🧠 Self-lesson stored: ${edit.reason.slice(0, 80)}`,
                            );
                        } catch (memErr) {
                            console.warn(
                                "[DREAMING] Self-lesson memory write failed:",
                                (memErr as Error).message,
                            );
                        }
                    }
                }
            }
        } catch (seErr) {
            console.warn("[DREAMING] Self-edit proposal failed (non-fatal):", (seErr as Error).message);
        }

        // ── Step 5: Goal Proposals — suggest new goals from overnight patterns ──
        try {
            const { proposeGoals, applyGoalDecay } = await import("./goal-engine.js");

            // Decay stale goals first
            try { applyGoalDecay(); } catch { /* non-fatal */ }

            // Propose new goals from recent context
            const recentTopics = recentContext
                .split(/[.\n]/)
                .filter(s => s.trim().length > 20)
                .slice(0, 10)
                .map(s => s.trim().substring(0, 80));
            const newGoals = await proposeGoals(llm, recentContext.substring(0, 2000), recentTopics);
            if (newGoals.length > 0) {
                console.log(`[DREAMING] 🎯 Proposed ${newGoals.length} new goal(s): ${newGoals.map(g => g.title).join(", ")}`);
                dreamResults.push({
                    task: "Goal proposals",
                    result: `Proposed ${newGoals.length} goal(s): ${newGoals.map(g => `${g.title} — ${g.description}`).join("; ")}`,
                    success: true,
                    durationMs: 0,
                });
            }
        } catch (geErr) {
            console.warn("[DREAMING] Goal proposal failed (non-fatal):", (geErr as Error).message);
        }

        dreamedTonight = true;
        console.log(`[DREAMING] 🌙 Dreaming complete — ${dreamResults.length} results ready for morning`);

    } catch (err) {
        console.error("[DREAMING] Dreaming failed:", (err as Error).message);
    } finally {
        dreamingActive = false;
    }
}

// ── Morning Delivery ─────────────────────────

/**
 * Get queued dream results and clear the queue.
 * Call this when the user sends their first morning message.
 */
export function getDreamResultsForDelivery(): DreamResult[] | null {
    if (dreamResults.length === 0) return null;
    const results = [...dreamResults];
    dreamResults = [];
    return results;
}

/**
 * Format dream results into a user-friendly message.
 */
export function formatDreamResults(results: DreamResult[]): string {
    const visible = results.filter((r) => _selfEditIsUserFacing(r.task, r.result));
    if (visible.length === 0) return "";
    const lines: string[] = [];
    lines.push("🌙 **While you were sleeping, I worked on a few things:**\n");

    for (const r of visible) {
        const icon = r.success ? "✅" : "⚠️";
        const duration = r.durationMs > 0 ? ` (${(r.durationMs / 1000).toFixed(0)}s)` : "";
        lines.push(`${icon} **${r.task}**${duration}`);
        if (r.result && r.task !== "Memory consolidation") {
            // Show first 300 chars of result
            const preview = r.result.substring(0, 300).trim();
            lines.push(preview + (r.result.length > 300 ? "..." : ""));
        }
        lines.push("");
    }

    return lines.join("\n");
}

// ── Heartbeat Integration ────────────────────

/**
 * Called from the heartbeat loop. Checks if conditions are right for dreaming.
 */
export async function checkDreamingConditions(
    llm: LLMClient,
    recentContext: string,
): Promise<void> {
    resetDailyState();

    if (dreamedTonight || dreamingActive) return;
    if (!isUserAsleep()) return;

    // All conditions met — start dreaming
    await runDreaming(llm, recentContext);
}
