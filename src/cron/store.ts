// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { atomicJsonWrite, safeJsonParse } from "../utils/atomic-io.js";
import {
    nextRunAt,
    parseSchedule,
    type ParsedSchedule,
} from "./parse-schedule.js";

export interface CronJob {
    id: string;
    prompt: string;
    /** Raw user-supplied schedule string — preserved for display + re-parse. */
    schedule: string;
    scheduleKind: ParsedSchedule["kind"];
    enabled: boolean;
    nextRunAt: number;
    createdAt: number;
    lastRunAt: number;
    lastStatus: "success" | "error" | null;
    lastError: string | null;
    /** Channel name (telegram/discord/overlay/...) or null = same channel that created the job. */
    deliverTo?: string;
    /** User id / chat id for routing on delivery. */
    userId?: string;
    /** Whether the scheduler runs the prompt with owner privileges. Defaults to false. */
    isOwner: boolean;
}

interface StoreFile {
    version: 1;
    jobs: CronJob[];
}

// The data dir, not the working directory: in the app that is inside the bundle,
// which an update replaces.
const DEFAULT_PATH = path.join(getDataDir(), "cron", "jobs.json");
let jobsPath: string = DEFAULT_PATH;
let jobs: CronJob[] = [];
let loaded = false;

export function setJobsPath(p: string): void {
    jobsPath = p;
    loaded = false;
}

export async function loadJobs(): Promise<void> {
    if (!fs.existsSync(jobsPath)) {
        jobs = [];
        loaded = true;
        return;
    }
    try {
        const raw = fs.readFileSync(jobsPath, "utf8");
        const parsed = safeJsonParse<StoreFile | null>(raw, null);
        jobs = parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
        jobs = [];
    }
    loaded = true;
}

async function persist(): Promise<void> {
    await atomicJsonWrite(jobsPath, { version: 1, jobs } satisfies StoreFile);
}

async function ensureLoaded(): Promise<void> {
    if (!loaded) await loadJobs();
}

function newId(): string {
    return `job_${crypto.randomBytes(6).toString("hex")}`;
}

export interface AddJobInput {
    prompt: string;
    schedule: string;
    deliverTo?: string;
    userId?: string;
    /** Set true only when the caller scheduling the job is the owner. */
    isOwner?: boolean;
}

export async function addJob(input: AddJobInput): Promise<CronJob> {
    await ensureLoaded();
    const parsed = parseSchedule(input.schedule); // throws on invalid
    const now = Date.now();
    const job: CronJob = {
        id: newId(),
        prompt: input.prompt,
        schedule: input.schedule,
        scheduleKind: parsed.kind,
        enabled: true,
        nextRunAt: nextRunAt(parsed, now),
        createdAt: now,
        lastRunAt: 0,
        lastStatus: null,
        lastError: null,
        deliverTo: input.deliverTo,
        userId: input.userId,
        isOwner: input.isOwner === true,
    };
    jobs.push(job);
    await persist();
    return job;
}

export function getJobs(): CronJob[] {
    return [...jobs];
}

export async function cancelJob(id: string): Promise<boolean> {
    await ensureLoaded();
    const before = jobs.length;
    jobs = jobs.filter((j) => j.id !== id);
    if (jobs.length === before) return false;
    await persist();
    return true;
}

export async function markRun(
    id: string,
    status: "success" | "error",
    error?: string,
): Promise<void> {
    await ensureLoaded();
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    const now = Date.now();
    job.lastRunAt = now;
    job.lastStatus = status;
    job.lastError = error ?? null;

    if (job.scheduleKind === "one-shot" || job.scheduleKind === "at") {
        // One-shots retire after a single run (regardless of success).
        job.enabled = false;
    } else {
        // Recurring: advance nextRunAt to the next occurrence. We pass
        // max(now, previousNext) + 1 as the base so the computation always
        // strictly advances past the slot we just ran — otherwise a cron
        // run completing in the same minute would recompute to the same
        // nextRunAt and fire again immediately.
        try {
            const parsed = parseSchedule(job.schedule);
            const base = Math.max(now, job.nextRunAt) + 1;
            job.nextRunAt = nextRunAt(parsed, base);
        } catch {
            job.enabled = false;
        }
    }
    await persist();
}

export function getDueJobs(nowMs: number): CronJob[] {
    return jobs.filter((j) => j.enabled && j.nextRunAt <= nowMs);
}

// ── Test seam ─────────────────────────────────

export function _setJobsForTests(next: CronJob[]): void {
    jobs = [...next];
    loaded = true;
}
