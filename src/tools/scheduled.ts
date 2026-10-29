// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import cron from "node-cron";
import type { ToolDefinition } from "./get-current-time.js";

// ── Types ─────────────────────────────────────

interface ScheduledTask {
    id: string;
    expression: string;
    description: string;
    action: string;
    status: "active" | "paused";
    created_at: string;
    task: cron.ScheduledTask;
}

// ── Task Store ────────────────────────────────

const tasks = new Map<string, ScheduledTask>();
let taskCounter = 0;
let onTaskTrigger: ((taskId: string, action: string) => Promise<void>) | null = null;

export function setTaskTriggerHandler(handler: (taskId: string, action: string) => Promise<void>): void {
    onTaskTrigger = handler;
}

// ── Schedule Task Tool ────────────────────────

export const scheduleTask: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "schedule_task",
            description:
                "Schedule a recurring task. Use cron expressions (e.g. '0 9 * * *' for 9 AM daily) or common patterns.",
            parameters: {
                type: "object",
                properties: {
                    expression: {
                        type: "string",
                        description:
                            "Cron expression. Common: '*/5 * * * *' (every 5 min), '0 9 * * *' (9 AM daily), '0 9 * * 1' (Mon 9 AM)",
                    },
                    description: { type: "string", description: "Human-readable description of the task" },
                    action: { type: "string", description: "What to do when triggered (message to send to the agent)" },
                },
                required: ["expression", "description", "action"],
            },
        },
    },
    async handler(input) {
        const expression = input.expression as string;
        const description = input.description as string;
        const action = input.action as string;

        if (!cron.validate(expression)) {
            return JSON.stringify({ error: `Invalid cron expression: "${expression}"` });
        }

        const id = `task_${++taskCounter}`;
        const task = cron.schedule(expression, async () => {
            console.log(`⏰ Scheduled task triggered: ${id} - ${description}`);
            if (onTaskTrigger) {
                await onTaskTrigger(id, action);
            }
        });

        tasks.set(id, {
            id,
            expression,
            description,
            action,
            status: "active",
            created_at: new Date().toISOString(),
            task,
        });

        return JSON.stringify({ success: true, id, expression, description, next_run: "Scheduled" });
    },
};

// ── List Tasks ────────────────────────────────

export const listTasks: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_scheduled_tasks",
            description: "List all scheduled tasks.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    async handler() {
        const taskList = Array.from(tasks.values()).map((t) => ({
            id: t.id,
            expression: t.expression,
            description: t.description,
            status: t.status,
            created_at: t.created_at,
        }));
        return JSON.stringify({ tasks: taskList, count: taskList.length });
    },
};

// ── Cancel Task ───────────────────────────────

export const cancelTask: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "cancel_task",
            description: "Cancel a scheduled task by ID.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Task ID to cancel" },
                },
                required: ["id"],
            },
        },
    },
    async handler(input) {
        const id = input.id as string;
        const task = tasks.get(id);
        if (!task) {
            return JSON.stringify({ error: `Task "${id}" not found` });
        }
        task.task.stop();
        tasks.delete(id);
        return JSON.stringify({ success: true, cancelled: id });
    },
};

// ── Set Reminder (One-Off) ────────────────────

export const setReminder: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_reminder",
            description:
                "Set a one-off reminder to trigger after a specific number of minutes. This is easier and more reliable than schedule_task for simple reminders.",
            parameters: {
                type: "object",
                properties: {
                    minutes: {
                        type: "number",
                        description: "Number of minutes from now to trigger the reminder (e.g., 5 for 5 minutes).",
                    },
                    description: { type: "string", description: "Human-readable description of the reminder." },
                    action: {
                        type: "string",
                        description:
                            "What to do when triggered (message to send to the agent, e.g., 'Remind the user to drink water').",
                    },
                },
                required: ["minutes", "description", "action"],
            },
        },
    },
    async handler(input) {
        const minutes = input.minutes as number;
        const description = input.description as string;
        const action = input.action as string;

        if (minutes <= 0) {
            return JSON.stringify({ error: "Minutes must be greater than 0" });
        }

        const id = `reminder_${++taskCounter}`;
        const timeoutMs = minutes * 60 * 1000;

        // Emulate cron.ScheduledTask for compatibility with our task mapper
        const fakeTask = {
            stop: () => clearTimeout(timer),
            start: () => {},
        } as unknown as cron.ScheduledTask;

        const timer = setTimeout(async () => {
            console.log(`⏰ Reminder triggered: ${id} - ${description}`);
            tasks.delete(id); // Auto-cleanup one-off tasks
            if (onTaskTrigger) {
                await onTaskTrigger(id, action);
            }
        }, timeoutMs);

        tasks.set(id, {
            id,
            expression: `In ${minutes} minutes`,
            description,
            action,
            status: "active",
            created_at: new Date().toISOString(),
            task: fakeTask,
        });

        const triggerTime = new Date(Date.now() + timeoutMs).toLocaleTimeString();
        return JSON.stringify({ success: true, id, description, triggers_at: triggerTime });
    },
};
