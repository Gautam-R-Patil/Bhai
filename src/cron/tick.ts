// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getDueJobs, markRun, type CronJob } from "./store.js";

export interface CronJobContext {
    deliverTo?: string;
    userId?: string;
    jobId: string;
    /** Owner privilege flag persisted from when the job was scheduled. */
    isOwner: boolean;
}

/** Async prompt runner injected by the caller — Bhai passes runAgent(). */
export type RunPromptFn = (
    prompt: string,
    ctx: CronJobContext,
) => Promise<string>;

/** Channel-agnostic delivery — Bhai wires this to the per-platform sender.
 * Return `false` on a definite failure (e.g. unknown channel / missing
 * adapter) so the tick engine can mark the run as `error` rather than
 * silently leaving `success` in the store. Throwing is also acceptable
 * and treated the same; returning `void`/`true` means delivered-or-routed. */
export type DeliverFn = (job: CronJob, response: string) => Promise<boolean | void>;

export interface CronTickOptions {
    runPrompt: RunPromptFn;
    deliver: DeliverFn;
}

// Module-level in-flight set: a job whose runPrompt is still awaited must
// not be re-invoked by a later tick before markRun has run. setInterval does
// not await, so a long-running agent call + 60s cadence will overlap.
const inFlight = new Set<string>();

export async function runCronTick(opts: CronTickOptions): Promise<number> {
    const due = getDueJobs(Date.now()).filter((j) => !inFlight.has(j.id));
    if (due.length === 0) return 0;

    for (const job of due) {
        inFlight.add(job.id);
        const ctx: CronJobContext = {
            deliverTo: job.deliverTo,
            userId: job.userId,
            jobId: job.id,
            isOwner: job.isOwner,
        };
        try {
            const response = await opts.runPrompt(job.prompt, ctx);
            let delivered: boolean | void = undefined;
            let deliverErrMsg: string | null = null;
            try {
                delivered = await opts.deliver(job, response);
            } catch (deliverErr) {
                deliverErrMsg = (deliverErr as Error).message;
                console.warn(
                    `[CRON] Delivery failed for ${job.id}:`,
                    deliverErrMsg,
                );
            }
            if (deliverErrMsg !== null || delivered === false) {
                // Honest: runPrompt succeeded but the result never reached
                // the user. Mark the run as error so /cron status surfaces it.
                await markRun(
                    job.id,
                    "error",
                    deliverErrMsg ?? `misroute: deliverTo="${job.deliverTo ?? "(unset)"}"`,
                );
            } else {
                await markRun(job.id, "success");
            }
        } catch (runErr) {
            const msg = (runErr as Error).message ?? String(runErr);
            console.warn(`[CRON] Job ${job.id} failed:`, msg);
            try {
                await markRun(job.id, "error", msg);
            } catch {
                /* persistence failure — log via console and move on */
            }
        } finally {
            inFlight.delete(job.id);
        }
    }

    return due.length;
}

// ── Long-running ticker (wire into Bhai boot) ─────────────

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
