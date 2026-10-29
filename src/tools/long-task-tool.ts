// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Long Task Tools ───────────────────────────
// Exposes the long-running task executor to the LLM as callable tools.
// Three tools: start, check, and cancel long-running tasks.

import {
    cancelLongTask,
    getLongTaskStatus,
    type LongTaskProgress,
    listActiveLongTasks,
    listSavedTasks,
    loadCheckpoint,
    resumeLongTask,
    startLongTask,
} from "../agents/long-task.js";
import type { LLMClient } from "../llm.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── LLM Client Injection ──────────────────────

let _llm: LLMClient | null = null;
let _onProgress: ((msg: string) => Promise<void>) | null = null;

export function setLongTaskLLM(llm: LLMClient): void {
    _llm = llm;
}

export function setLongTaskProgress(fn: (msg: string) => Promise<void>): void {
    _onProgress = fn;
}

export function clearLongTaskProgress(): void {
    _onProgress = null;
}

// ── Progress adapter ──────────────────────────

/** Exactly what telegram.ts parses: /\[LONG-TASK:([^\]]+)\]\s*(.*)/ */
export function longTaskMarker(taskId: string, message: string): string {
    return `[LONG-TASK:${taskId}] ${message}`;
}

// The channel's callback outlives the turn on purpose: a Discord thread keeps
// posting phase updates and the result, while Telegram's ignores updates once
// its status message is gone. Completion also goes to the proactive bus below.
function makeProgressCallback(): ((progress: LongTaskProgress) => Promise<void>) | undefined {
    if (!_onProgress) return undefined;
    const fn = _onProgress;
    return async (progress: LongTaskProgress) => {
        const elapsed = (progress.elapsedMs / 1000).toFixed(0);
        if (progress.status === "completed") {
            // Completion notification — deliver reviewed result to user via the current channel
            const msg = `✅ **Task complete!** (${progress.phasesTotal} phases, ${elapsed}s)\n\n${progress.currentPhaseDescription}`;
            await fn(msg).catch(() => {});

            // Also emit to the proactive subsystem so the V2 scheduler + Composer handle it
            // across channels (template fast-path: "Done with X. <summary>").
            try {
                const { globalLongTaskBus } = await import("../proactive/long-task-events.js");
                globalLongTaskBus.emit({
                    taskId: progress.taskId,
                    task: progress.currentPhaseDescription.substring(0, 80) || "long task",
                    summary: progress.currentPhaseDescription,
                    durationSec: Number(elapsed),
                    ts: Date.now(),
                });
            } catch {
                // non-fatal — proactive module not loaded or not available
            }
        } else if (progress.currentPhaseId === "quality_review") {
            // Quality review in progress — brief status update
            await fn(`🔍 All phases done — reviewing quality of work...`).catch(() => {});
        } else {
            const eta = progress.estimatedRemainingMs
                ? ` (~${Math.round(progress.estimatedRemainingMs / 1000)}s remaining)`
                : "";
            const msg = `📋 Long task: phase ${progress.phasesCompleted + 1}/${progress.phasesTotal} — ${progress.currentPhaseDescription.substring(0, 80)} (${elapsed}s${eta})`;
            await fn(msg).catch(() => {});
        }
    };
}

// ── Start Long Task Tool ──────────────────────

export const startLongTaskTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "start_long_task",
            description: `Start a long-running, multi-phase task that may take minutes or hours to complete.
Use this for:
- Tasks with 10+ steps that need to run sequentially
- Downloads, builds, or installations that take a long time
- Complex multi-step workflows (e.g., "research X, then create a report, then format it")
- Any task where you'd normally hit iteration or timeout limits

The task is automatically decomposed into phases. Each phase runs with its own sub-agent.
Progress is checkpointed so tasks can resume if interrupted.
The task runs asynchronously — you'll get a task ID to check on it later.`,
            parameters: {
                type: "object",
                properties: {
                    description: {
                        type: "string",
                        description:
                            "Detailed description of the full task to execute. Be as specific as possible — include URLs, file paths, expected outcomes, etc.",
                    },
                },
                required: ["description"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({ error: "Long task system not initialized — LLM client not set" });
        }

        const description = input.description as string;
        if (!description) {
            return JSON.stringify({ error: "Missing 'description' parameter" });
        }

        try {
            const task = await startLongTask(_llm, description, makeProgressCallback());
            // Telegram (progressCallback in telegram.ts) turns this marker into Check/Cancel buttons.
            await _onProgress?.(
                longTaskMarker(task.id, `Long task started: ${task.phases.length} phases running in background`),
            ).catch(() => {});

            return JSON.stringify({
                success: true,
                task_id: task.id,
                status: task.status,
                phases: task.phases.length,
                phase_summary: task.phases.map((p) => `${p.id} [${p.role}]: ${p.description.substring(0, 80)}`),
                message: `Long task "${task.id}" started with ${task.phases.length} phases running in background.`,
                instruction:
                    "STOP: This task is now DELEGATED to background workers. Do NOT attempt this work yourself — do NOT use shell_exec, write, edit, browser, or any tools to do the same task. Simply tell the user the task is running in the background and they can check progress later. Make NO more tool calls for this task.",
            });
        } catch (err) {
            return JSON.stringify({
                error: `Failed to start long task: ${(err as Error).message}`,
            });
        }
    },
};

// ── Check Long Task Tool ──────────────────────

export const checkLongTaskTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "check_long_task",
            description:
                "Check the status and progress of a running long task. Also use this to list all active tasks (omit task_id).",
            parameters: {
                type: "object",
                properties: {
                    task_id: {
                        type: "string",
                        description: "Task ID to check. Omit to list all active tasks.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const taskId = input.task_id as string | undefined;

        if (!taskId) {
            // List all active tasks
            const active = listActiveLongTasks();
            const saved = await listSavedTasks();
            return JSON.stringify({
                active_tasks: active.map((t) => ({
                    id: t.id,
                    description: t.description.substring(0, 100),
                    status: t.status,
                    phases: `${t.currentPhase + 1}/${t.phases.length}`,
                    elapsed: `${(t.totalDurationMs / 1000).toFixed(0)}s`,
                })),
                saved_task_ids: saved,
            });
        }

        // Check specific task
        let task = getLongTaskStatus(taskId);

        // Try loading from disk if not in memory
        if (!task) {
            task = await loadCheckpoint(taskId);
        }

        if (!task) {
            return JSON.stringify({ error: `Task "${taskId}" not found` });
        }

        const completedPhases = Object.keys(task.checkpointData).length;

        return JSON.stringify({
            id: task.id,
            description: task.description,
            status: task.status,
            phases_total: task.phases.length,
            phases_completed: completedPhases,
            current_phase: task.currentPhase,
            current_phase_description: task.phases[task.currentPhase]?.description || "done",
            elapsed_seconds: (task.totalDurationMs / 1000).toFixed(1),
            started_at: task.startedAt,
            updated_at: task.updatedAt,
            error: task.error,
            phase_results: Object.entries(task.checkpointData).map(([id, output]) => ({
                phase_id: id,
                output_preview: output.substring(0, 200),
            })),
        });
    },
};

// ── Cancel Long Task Tool ─────────────────────

export const cancelLongTaskTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "cancel_long_task",
            description: "Cancel a running long task by its ID.",
            parameters: {
                type: "object",
                properties: {
                    task_id: {
                        type: "string",
                        description: "Task ID to cancel",
                    },
                },
                required: ["task_id"],
            },
        },
    },

    async handler(input) {
        const taskId = input.task_id as string;
        if (!taskId) {
            return JSON.stringify({ error: "Missing 'task_id' parameter" });
        }

        const cancelled = cancelLongTask(taskId);
        if (cancelled) {
            return JSON.stringify({ success: true, message: `Task "${taskId}" cancelled.` });
        }
        return JSON.stringify({ error: `Task "${taskId}" not found or already completed.` });
    },
};

// ── Resume Long Task Tool ─────────────────────

export const resumeLongTaskTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "resume_long_task",
            description:
                "Resume a previously started long task from its last checkpoint. Use this if a task was interrupted or paused.",
            parameters: {
                type: "object",
                properties: {
                    task_id: {
                        type: "string",
                        description: "Task ID to resume",
                    },
                },
                required: ["task_id"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({ error: "Long task system not initialized" });
        }

        const taskId = input.task_id as string;
        if (!taskId) {
            return JSON.stringify({ error: "Missing 'task_id' parameter" });
        }

        try {
            const task = await resumeLongTask(_llm, taskId, makeProgressCallback());
            if (!task) {
                return JSON.stringify({ error: `Task "${taskId}" not found in checkpoints.` });
            }
            await _onProgress?.(
                longTaskMarker(task.id, `Long task resumed from phase ${task.currentPhase + 1}/${task.phases.length}`),
            ).catch(() => {});

            return JSON.stringify({
                success: true,
                task_id: task.id,
                status: task.status,
                resumed_from_phase: task.currentPhase + 1,
                total_phases: task.phases.length,
                message: `Task resumed from phase ${task.currentPhase + 1}/${task.phases.length}.`,
            });
        } catch (err) {
            return JSON.stringify({ error: `Failed to resume: ${(err as Error).message}` });
        }
    },
};
