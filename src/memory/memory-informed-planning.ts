// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Memory-Informed Planning ─────────────────────
 * Bridge between memory retrieval and task decomposition.
 * Before decomposing a task, queries memory for relevant past executions,
 * learnings, and entity states to inform the planning process.
 */

import { recall } from "./sqlite.js";
import { embedText, cosineSimilarity, isReady } from "./embeddings.js";

// ── Types ─────────────────────────────────────

export interface PlanningContext {
    /** Relevant memories from past similar tasks */
    relevantMemories: string[];
    /** Task learnings (strategies that worked/failed) */
    taskLearnings: string[];
    /** Summary for injection into decomposition prompt */
    contextSummary: string;
}

// ── Main Function ─────────────────────────────

/**
 * Gather memory-informed context for task planning.
 * Called before task decomposition in swarm.ts and mesh.ts.
 */
export async function getMemoryInformedContext(
    taskDescription: string,
    maxMemories = 5,
    maxLearnings = 3
): Promise<PlanningContext> {
    const context: PlanningContext = {
        relevantMemories: [],
        taskLearnings: [],
        contextSummary: "",
    };

    try {
        // ── 1. Recall relevant memories ──
        const memories = await recall(taskDescription, maxMemories);
        if (memories && memories.length > 0) {
            context.relevantMemories = memories.map((m: any) => m.content);
        }

        // ── 2. Get task learnings ──
        try {
            const { getTaskLearningsContext } = await import("./task-learnings.js");
            const learningsText = getTaskLearningsContext(taskDescription);
            if (learningsText) {
                context.taskLearnings = [learningsText];
            }
        } catch { /* task-learnings not available */ }

        // ── 3. Build summary ──
        const parts: string[] = [];

        if (context.relevantMemories.length > 0) {
            parts.push(`PAST EXPERIENCE:\n${context.relevantMemories.map(m => `- ${m}`).join("\n")}`);
        }

        if (context.taskLearnings.length > 0) {
            parts.push(`TASK LEARNINGS (what worked before):\n${context.taskLearnings.map(l => `- ${l}`).join("\n")}`);
        }

        context.contextSummary = parts.join("\n\n");
    } catch (err) {
        console.warn("[MEMORY-PLANNING] Context gathering failed:", (err as Error).message);
    }

    return context;
}
