// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { getDataDir } from "../config/paths.js";
import { isOwnerCaller } from "./cron-tool.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Types ─────────────────────────────────────

/** What survives a restart: tasks are saved to disk and re-armed at boot. */
interface SavedTask {
    id: string;
    /** A cron expression, or "In N minutes" for a one-off reminder. */
    expression: string;
    description: string;
    action: string;
    created_at: string;
    /** One-off reminders: when to fire (epoch ms). */
    fireAt?: number;
    /** Run `action` through the agent and send its answer, instead of just reminding. */
    doTask?: boolean;
    /** Scheduled by the owner, live: the run gets owner tools. */
    isOwner?: boolean;
}

export interface TriggerOptions {
    doTask: boolean;
    isOwner: boolean;
}

interface ScheduledTask extends SavedTask {
    status: "active" | "paused";
    task: { stop: () => void };
}

// ── Task Store ────────────────────────────────

const tasks = new Map<string, ScheduledTask>();
let taskCounter = 0;
type TriggerHandler = (taskId: string, action: string, description: string, opts: TriggerOptions) => Promise<void>;
let onTaskTrigger: TriggerHandler | null = null;
// setTimeout fires at once past ~24.8 days, so long waits go in steps.
const MAX_TIMER_MS = 2 ** 31 - 1;

export function setTaskTriggerHandler(handler: TriggerHandler): void {
    onTaskTrigger = handler;
}

const storePath = () => path.join(getDataDir(), "scheduled-tasks.json");

function save(): void {
    const saved: SavedTask[] = [...tasks.values()].map(({ status: _status, task: _timer, ...t }) => t);
    try {
        fs.mkdirSync(path.dirname(storePath()), { recursive: true });
        const tmp = `${storePath()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, storePath());
    } catch (err) {
        console.warn("[SCHEDULED] Could not save tasks:", (err as Error).message);
    }
}

async function trigger(t: SavedTask): Promise<void> {
    try {
        // Tasks saved before doTask existed: schedule_task ones were always meant to run.
        const doTask = t.doTask ?? t.id.startsWith("task_");
        await onTaskTrigger?.(t.id, t.action, t.description, { doTask, isOwner: t.isOwner === true });
    } catch (err) {
        console.error(`[SCHEDULED] ${t.id} failed:`, (err as Error).message);
    }
}

/** Start (or restart) a saved task's timer and keep it in the store. */
function arm(saved: SavedTask): ScheduledTask {
    let task: ScheduledTask["task"];
    if (saved.fireAt !== undefined) {
        const fireAt = saved.fireAt;
        let timer: ReturnType<typeof setTimeout>;
        const wait = () => {
            const left = fireAt - Date.now();
            if (left > 0) {
                timer = setTimeout(wait, Math.min(left, MAX_TIMER_MS));
                return;
            }
            console.log(`⏰ Reminder triggered: ${saved.id} - ${saved.description}`);
            tasks.delete(saved.id); // one-off: done once it fires
            save();
            void trigger(saved);
        };
        wait();
        task = { stop: () => clearTimeout(timer) };
    } else {
        task = cron.schedule(saved.expression, () => {
            console.log(`⏰ Scheduled task triggered: ${saved.id} - ${saved.description}`);
            void trigger(saved);
        });
    }
    const entry: ScheduledTask = { ...saved, status: "active", task };
    tasks.set(saved.id, entry);
    return entry;
}

/** Re-arm the tasks saved before a restart. A reminder due while Bhai was off fires now. */
export function restoreScheduledTasks(): number {
    let saved: SavedTask[] = [];
    try {
        if (fs.existsSync(storePath())) saved = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    } catch (err) {
        console.warn("[SCHEDULED] Could not read saved tasks:", (err as Error).message);
        return 0;
    }
    let n = 0;
    for (const t of Array.isArray(saved) ? saved : []) {
        if (!t?.id || tasks.has(t.id) || typeof t.action !== "string") continue;
        if (t.fireAt === undefined && !cron.validate(t.expression)) continue;
        taskCounter = Math.max(taskCounter, Number(t.id.split("_").pop()) || 0);
        // Due while Bhai was off: give the channels a moment to connect first.
        const soonest = Date.now() + 30_000;
        arm(t.fireAt !== undefined && t.fireAt < soonest ? { ...t, fireAt: soonest } : t);
        n++;
    }
    return n;
}

// ── Schedule Task Tool ────────────────────────

export const scheduleTask: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "schedule_task",
            description:
                "Schedule a recurring task: at each time Bhai runs the action and sends the owner its answer (e.g. 'Summarize my unread email'). Use cron expressions (e.g. '0 9 * * *' for 9 AM daily) or common patterns.",
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
        arm({
            id,
            expression,
            description,
            action,
            created_at: new Date().toISOString(),
            doTask: true,
            isOwner: isOwnerCaller(),
        });
        save();

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
        save();
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
                    description: {
                        type: "string",
                        description:
                            "What to remind the owner of, as they'll read it after '⏰ Reminder:' (e.g. 'Check the oven', not 'Oven reminder').",
                    },
                    action: {
                        type: "string",
                        description:
                            "What to do when triggered (message to send to the agent, e.g., 'Remind the user to drink water').",
                    },
                    do_task: {
                        type: "boolean",
                        description:
                            "true when Bhai must do something at that time (check, look up, summarize, then report), so the action runs and its answer is sent then. Don't also do it now: the owner asked for it later. Leave out for a plain reminder.",
                    },
                },
                required: ["minutes", "description", "action"],
            },
        },
    },
    async handler(input) {
        const minutes = Number(input.minutes);
        const description = input.description as string;
        const action = input.action as string;

        if (!Number.isFinite(minutes) || minutes <= 0) {
            return JSON.stringify({ error: "Minutes must be a number greater than 0" });
        }

        const id = `reminder_${++taskCounter}`;
        const fireAt = Date.now() + minutes * 60 * 1000;
        arm({
            id,
            expression: `In ${minutes} minutes`,
            description,
            action,
            created_at: new Date().toISOString(),
            fireAt,
            doTask: input.do_task === true,
            isOwner: isOwnerCaller(),
        });
        save();

        const triggerTime = new Date(fireAt).toLocaleString();
        return JSON.stringify({ success: true, id, description, triggers_at: triggerTime });
    },
};
