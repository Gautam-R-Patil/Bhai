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
    /** Knowledge graph entities relevant to this task */
    relevantEntities: string[];
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
        relevantEntities: [],
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

        // ── 3. Get relevant knowledge graph entities ──
        try {
            const { findEntities } = await import("./knowledge-graph.js");
            const { getRawDb } = await import("./sqlite.js");
            const memDb = getRawDb();
            if (memDb) {
                const entities = findEntities(memDb as any, taskDescription);
                if (entities && entities.length > 0) {
                    context.relevantEntities = entities.slice(0, 5).map((e: any) =>
                        `${e.name} (${e.type}): ${e.context || "no additional context"}`
                    );
                }
            }
        } catch { /* knowledge graph not available */ }

        // ── 4. Build summary ──
        const parts: string[] = [];

        if (context.relevantMemories.length > 0) {
            parts.push(`PAST EXPERIENCE:\n${context.relevantMemories.map(m => `- ${m}`).join("\n")}`);
        }

        if (context.taskLearnings.length > 0) {
            parts.push(`TASK LEARNINGS (what worked before):\n${context.taskLearnings.map(l => `- ${l}`).join("\n")}`);
        }

        if (context.relevantEntities.length > 0) {
            parts.push(`RELEVANT ENTITIES:\n${context.relevantEntities.map(e => `- ${e}`).join("\n")}`);
        }

        context.contextSummary = parts.join("\n\n");
    } catch (err) {
        console.warn("[MEMORY-PLANNING] Context gathering failed:", (err as Error).message);
    }

    return context;
}
