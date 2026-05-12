// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Task Queue & Progress Tracker ─────────────
// Enables: "Do X, then Y, then Z" with sequential execution and rich progress.

import type { ToolDefinition } from "./get-current-time.js";

// ═══════════════════════════════════════════════
// 1. RICH PROGRESS TRACKER
// ═══════════════════════════════════════════════

export interface ProgressStep {
    label: string;
    status: "pending" | "running" | "done" | "error";
    startedAt?: number;
    completedAt?: number;
    detail?: string;
}

export class ProgressTracker {
    private steps: ProgressStep[] = [];
    private title: string;
    private onUpdate: ((message: string) => Promise<void>) | null = null;
    private lastUpdateTime = 0;
    private throttleMs = 3000; // Don't update more than every 3s

    constructor(title: string) {
        this.title = title;
    }

    /** Set the callback for sending progress updates */
    setUpdateHandler(fn: (message: string) => Promise<void>): void {
        this.onUpdate = fn;
    }

    /** Add a step to the tracker */
    addStep(label: string): number {
        this.steps.push({ label, status: "pending" });
        return this.steps.length - 1;
    }

    /** Add multiple steps at once */
    addSteps(labels: string[]): void {
        for (const label of labels) {
            this.steps.push({ label, status: "pending" });
        }
    }

    /** Mark a step as running */
    async startStep(index: number, detail?: string): Promise<void> {
        if (index < 0 || index >= this.steps.length) return;
        this.steps[index].status = "running";
        this.steps[index].startedAt = Date.now();
        if (detail) this.steps[index].detail = detail;
        await this.sendUpdate();
    }

    /** Mark a step as complete */
    async completeStep(index: number, detail?: string): Promise<void> {
        if (index < 0 || index >= this.steps.length) return;
        this.steps[index].status = "done";
        this.steps[index].completedAt = Date.now();
        if (detail) this.steps[index].detail = detail;
        await this.sendUpdate();
    }

    /** Mark a step as errored */
    async errorStep(index: number, detail?: string): Promise<void> {
        if (index < 0 || index >= this.steps.length) return;
        this.steps[index].status = "error";
        this.steps[index].completedAt = Date.now();
        if (detail) this.steps[index].detail = detail;
        await this.sendUpdate();
    }

    /** Get the formatted progress message */
    formatMessage(): string {
        const lines: string[] = [];
        lines.push(`📋 **${this.title}**\n`);

        const completedCount = this.steps.filter((s) => s.status === "done").length;
        const totalCount = this.steps.length;
        const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

        // Progress bar
        const barLen = 10;
        const filled = Math.round((percent / 100) * barLen);
        const bar = "▓".repeat(filled) + "░".repeat(barLen - filled);
        lines.push(`${bar} ${percent}%\n`);

        // Steps
        for (const step of this.steps) {
            let icon: string;
            switch (step.status) {
                case "pending":
                    icon = "⬜";
                    break;
                case "running":
                    icon = "🔄";
                    break;
                case "done":
                    icon = "✅";
                    break;
                case "error":
                    icon = "❌";
                    break;
            }
            let line = `${icon} ${step.label}`;
            if (step.status === "running" && step.startedAt) {
                const elapsed = Math.round((Date.now() - step.startedAt) / 1000);
                if (elapsed > 5) line += ` _(${elapsed}s)_`;
            }
            if (step.detail) line += ` — ${step.detail}`;
            lines.push(line);
        }

        // ETA
        const doneSteps = this.steps.filter((s) => s.status === "done" && s.startedAt && s.completedAt);
        if (doneSteps.length >= 2 && completedCount < totalCount) {
            const avgMs = doneSteps.reduce((sum, s) => sum + (s.completedAt! - s.startedAt!), 0) / doneSteps.length;
            const remaining = totalCount - completedCount;
            const etaSeconds = Math.round((remaining * avgMs) / 1000);
            if (etaSeconds > 10) {
                lines.push(`\n⏱ ~${etaSeconds}s remaining`);
            }
        }

        return lines.join("\n");
    }

    /** Send throttled progress update */
    private async sendUpdate(): Promise<void> {
        if (!this.onUpdate) return;
        const now = Date.now();
        if (now - this.lastUpdateTime < this.throttleMs) return;
        this.lastUpdateTime = now;
        try {
            await this.onUpdate(this.formatMessage());
        } catch {
            /* don't let progress errors break execution */
        }
    }

    /** Force-send final update (bypasses throttle) */
    async sendFinal(): Promise<void> {
        this.lastUpdateTime = 0;
        await this.sendUpdate();
    }
}

// ═══════════════════════════════════════════════
// 2. TASK QUEUE
// ═══════════════════════════════════════════════

interface QueuedTask {
    id: string;
    description: string;
    status: "pending" | "running" | "done" | "error";
    result?: string;
    error?: string;
    addedAt: number;
    startedAt?: number;
    completedAt?: number;
}

type TaskExecutor = (task: QueuedTask, onProgress: (msg: string) => Promise<void>) => Promise<string>;

const taskQueue: QueuedTask[] = [];
let isProcessingQueue = false;
let taskExecutor: TaskExecutor | null = null;
let queueProgressCallback: ((msg: string) => Promise<void>) | null = null;

/**
 * Set the function that will process each queued task.
 * This should be wired to the agent's processMessage or similar.
 */
export function setTaskExecutor(fn: TaskExecutor): void {
    taskExecutor = fn;
}

/**
 * Set the callback for queue status updates (Telegram messages).
 */
export function setQueueProgress(fn: (msg: string) => Promise<void>): void {
    queueProgressCallback = fn;
}

/**
 * Add task(s) to the queue.
 */
export function queueTasks(descriptions: string[]): QueuedTask[] {
    const added: QueuedTask[] = [];
    for (const desc of descriptions) {
        const task: QueuedTask = {
            id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            description: desc.trim(),
            status: "pending",
            addedAt: Date.now(),
        };
        taskQueue.push(task);
        added.push(task);
    }

    // Auto-start processing if not already running
    if (!isProcessingQueue && taskExecutor) {
        processQueue().catch((err) => console.error("[QUEUE] Processing error:", err));
    }

    return added;
}

/**
 * Get current queue status.
 */
export function getQueueStatus(): {
    total: number;
    pending: number;
    running: string | null;
    completed: number;
    tasks: QueuedTask[];
} {
    const pending = taskQueue.filter((t) => t.status === "pending").length;
    const running = taskQueue.find((t) => t.status === "running");
    const completed = taskQueue.filter((t) => t.status === "done" || t.status === "error").length;

    return {
        total: taskQueue.length,
        pending,
        running: running?.description || null,
        completed,
        tasks: taskQueue.map((t) => ({ ...t })),
    };
}

/**
 * Cancel all pending tasks.
 */
export function cancelQueue(): { cancelled: number } {
    let cancelled = 0;
    for (const task of taskQueue) {
        if (task.status === "pending") {
            task.status = "error";
            task.error = "Cancelled by user";
            cancelled++;
        }
    }
    return { cancelled };
}

/**
 * Clear completed / errored tasks from the queue.
 */
export function clearCompletedTasks(): void {
    const active = taskQueue.filter((t) => t.status === "pending" || t.status === "running");
    taskQueue.length = 0;
    taskQueue.push(...active);
}

/**
 * Format queue status for display in Telegram.
 */
function formatQueueStatus(): string {
    if (taskQueue.length === 0) return "📋 Task queue is empty.";

    const lines: string[] = ["📋 **Task Queue**\n"];

    for (let i = 0; i < taskQueue.length; i++) {
        const task = taskQueue[i];
        let icon: string;
        switch (task.status) {
            case "pending":
                icon = "⬜";
                break;
            case "running":
                icon = "🔄";
                break;
            case "done":
                icon = "✅";
                break;
            case "error":
                icon = "❌";
                break;
        }
        const desc = task.description.length > 60 ? task.description.substring(0, 57) + "..." : task.description;
        let line = `${icon} ${i + 1}. ${desc}`;
        if (task.status === "running" && task.startedAt) {
            const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
            line += ` _(${elapsed}s)_`;
        }
        if (task.error) line += ` — ${task.error}`;
        lines.push(line);
    }

    return lines.join("\n");
}

/**
 * Process queued tasks sequentially.
 */
async function processQueue(): Promise<void> {
    if (isProcessingQueue || !taskExecutor) return;
    isProcessingQueue = true;

    try {
        while (true) {
            const nextTask = taskQueue.find((t) => t.status === "pending");
            if (!nextTask) break;

            nextTask.status = "running";
            nextTask.startedAt = Date.now();

            // Send queue status update
            if (queueProgressCallback) {
                try {
                    await queueProgressCallback(formatQueueStatus());
                } catch {
                    /* */
                }
            }

            try {
                const result = await taskExecutor(nextTask, queueProgressCallback || (async () => {}));
                nextTask.status = "done";
                nextTask.result = result;
                nextTask.completedAt = Date.now();
            } catch (err) {
                nextTask.status = "error";
                nextTask.error = (err as Error).message;
                nextTask.completedAt = Date.now();
            }
        }

        // Send final status
        if (queueProgressCallback) {
            try {
                await queueProgressCallback(formatQueueStatus() + "\n\n✅ All tasks complete!");
            } catch {
                /* */
            }
        }
    } finally {
        isProcessingQueue = false;
    }
}

// ═══════════════════════════════════════════════
// 3. TOOL DEFINITION (for LLM to use)
// ═══════════════════════════════════════════════

export const taskQueueTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "task_queue",
            description: "Manage a sequential task queue. Queue multiple tasks, check status, or cancel pending tasks.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["add", "status", "cancel", "clear"],
                        description:
                            "Action: 'add' = queue new tasks, 'status' = check queue, 'cancel' = cancel pending, 'clear' = remove completed",
                    },
                    tasks: {
                        type: "array",
                        items: { type: "string" },
                        description: "Task descriptions to queue (for 'add' action)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        if (action === "add") {
            const tasks = input.tasks as string[];
            if (!tasks || tasks.length === 0) {
                return JSON.stringify({ error: "Provide 'tasks' array with task descriptions." });
            }
            const added = queueTasks(tasks);
            return JSON.stringify({
                success: true,
                queued: added.length,
                tasks: added.map((t) => ({ id: t.id, description: t.description })),
                note: taskExecutor
                    ? "Tasks will execute sequentially."
                    : "No executor wired — tasks are queued but won't auto-execute yet.",
            });
        }

        if (action === "status") {
            return JSON.stringify({ success: true, ...getQueueStatus() });
        }

        if (action === "cancel") {
            const result = cancelQueue();
            return JSON.stringify({ success: true, ...result });
        }

        if (action === "clear") {
            clearCompletedTasks();
            return JSON.stringify({ success: true, message: "Completed/errored tasks cleared." });
        }

        return JSON.stringify({ error: `Unknown action: ${action}` });
    },
};
