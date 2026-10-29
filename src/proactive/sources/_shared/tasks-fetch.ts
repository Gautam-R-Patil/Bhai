// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { listGoogleTasksRaw } from "../../../tools/google-api.js";
import type { TaskEntry } from "../../../../native/index.js";

const TTL_MS = 15 * 60_000;

let cache: { tasks: TaskEntry[]; expires: number } | null = null;

function parsePriority(title: string): "high" | "normal" | "low" {
    const t = title.trim();
    if (t.startsWith("[!]") || t.startsWith("!")) return "high";
    if (t.startsWith("[?]")) return "low";
    return "normal";
}

function toTaskEntry(item: { id: string; title: string; due?: string; status: string }): TaskEntry {
    return {
        id: item.id,
        title: item.title,
        dueMs: item.due ? Date.parse(item.due) : undefined,
        priority: parsePriority(item.title),
        completed: item.status === "completed",
    };
}

export async function fetchTasksToday(): Promise<TaskEntry[]> {
    if (cache && cache.expires > Date.now()) return cache.tasks;
    const endOfTomorrow = new Date();
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    endOfTomorrow.setHours(23, 59, 59, 999);
    const raw = await listGoogleTasksRaw({
        showCompleted: false,
        dueMax: endOfTomorrow.toISOString(),
    });
    const tasks: TaskEntry[] = raw.map(toTaskEntry);
    cache = { tasks, expires: Date.now() + TTL_MS };
    return tasks;
}

export function _resetTasksCache(): void {
    cache = null;
}
