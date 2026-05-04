// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getDueJobs, markRun, type CronJob } from "./store.js";

export interface CronJobContext {
    deliverTo?: string;
    userId?: string;
    jobId: string;
}

/** Async prompt runner injected by the caller — ATLAS passes runAgent(). */
export type RunPromptFn = (
    prompt: string,
    ctx: CronJobContext,
) => Promise<string>;

/** Channel-agnostic delivery — ATLAS wires this to the per-platform sender. */
export type DeliverFn = (job: CronJob, response: string) => Promise<void>;

export interface CronTickOptions {
    runPrompt: RunPromptFn;
    deliver: DeliverFn;
}

/**
 * Fire every due cron job once. Returns the number of jobs attempted.
 * Isolated failures: prompt errors are caught + recorded; delivery errors
 * don't mask the run status.
 */
export async function runCronTick(opts: CronTickOptions): Promise<number> {
    const due = getDueJobs(Date.now());
    if (due.length === 0) return 0;

    for (const job of due) {
        const ctx: CronJobContext = {
            deliverTo: job.deliverTo,
            userId: job.userId,
            jobId: job.id,
        };
        try {
            const response = await opts.runPrompt(job.prompt, ctx);
            await markRun(job.id, "success");
            try {
                await opts.deliver(job, response);
            } catch (deliverErr) {
                console.warn(
                    `[CRON] Delivery failed for ${job.id}:`,
                    (deliverErr as Error).message,
                );
            }
        } catch (runErr) {
            const msg = (runErr as Error).message ?? String(runErr);
            console.warn(`[CRON] Job ${job.id} failed:`, msg);
            try {
                await markRun(job.id, "error", msg);
            } catch {
                /* persistence failure — log via console and move on */
            }
        }
    }

    return due.length;
}

// ── Long-running ticker (wire into ATLAS boot) ─────────────

let tickerHandle: ReturnType<typeof setInterval> | null = null;

export function startCronTicker(
    opts: CronTickOptions,
    intervalMs: number = 60_000,
): void {
    if (tickerHandle !== null) return; // idempotent
    tickerHandle = setInterval(() => {
        runCronTick(opts).catch((err) => {
            console.warn("[CRON] Ticker iteration failed:", (err as Error).message);
        });
    }, intervalMs);
    // Don't keep the Node process alive solely for the ticker.
    tickerHandle.unref();
}

export function stopCronTicker(): void {
    if (tickerHandle === null) return;
    clearInterval(tickerHandle);
    tickerHandle = null;
}
