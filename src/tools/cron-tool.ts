// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { AsyncLocalStorage } from "node:async_hooks";
import { addJob, cancelJob, getJobs } from "../cron/store.js";
import type { ToolDefinition } from "./get-current-time.js";
import { toolError, toolSuccess } from "./tool-result.js";

type Op = "schedule" | "list" | "cancel" | "trigger";

// AsyncLocalStorage-scoped caller context. Two concurrent runAgent calls
// (e.g. telegram-owner + whatsapp-contact) each run inside their own ALS
// frame, so a contact-agent never sees the owner's isOwner:true even when
// both turns are interleaving LLM awaits on the same event loop.
interface CronCallerContext {
    isOwner: boolean;
}
const _callerStorage = new AsyncLocalStorage<CronCallerContext>();

/** Run `fn` with `ctx` as the ambient caller context for cron-scheduling. */
export function runWithCallerContext<T>(ctx: CronCallerContext, fn: () => Promise<T> | T): Promise<T> | T {
    return _callerStorage.run(ctx, fn);
}

/** The current turn's caller: true owner, false guest/contact, undefined outside any turn (background work). */
export function callerIsOwner(): boolean | undefined {
    return _callerStorage.getStore()?.isOwner;
}

/** Legacy setter preserved for callers that can't wrap — always overwrites
 * nothing (ALS-scoped reads ignore it). Kept as a no-op so existing call
 * sites don't break while we roll the ALS wrapper out. */
export function setCronCallerContext(_ctx: CronCallerContext | null): void {
    // Intentionally empty: reads go through ALS now.
}

function getStringParam(input: Record<string, unknown>, key: string): string | null {
    const v = input[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

export const cronTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "cron",
            description:
                "Schedule, list, or cancel recurring or one-shot agent tasks. Use for 'remind me at X', 'every morning summarize Y', or 'run Z daily' kinds of requests. The scheduled prompt will run as if the user typed it when the time comes, and the response delivers back to the same channel.",
            parameters: {
                type: "object",
                properties: {
                    op: {
                        type: "string",
                        enum: ["schedule", "list", "cancel"],
                        description:
                            "schedule = create a new job, list = see existing jobs, cancel = remove a job by id",
                    },
                    prompt: {
                        type: "string",
                        description:
                            "(schedule only) The prompt to run when the schedule fires — phrased as a user message the agent would act on.",
                    },
                    schedule: {
                        type: "string",
                        description:
                            "(schedule only) One of: '30m' / '2h' / '1d' (one-shot relative), 'every 30m' / 'every 2h' (recurring), '0 9 * * *' (cron — 5 fields), '2026-05-04T15:30:00Z' (ISO absolute).",
                    },
                    deliverTo: {
                        type: "string",
                        description:
                            "(schedule only, optional) Channel to deliver the response to. Defaults to the channel this request came from.",
                    },
                    userId: {
                        type: "string",
                        description: "(schedule only, optional) User id / chat id for routing delivery.",
                    },
                    id: {
                        type: "string",
                        description: "(cancel only) The job id to cancel.",
                    },
                },
                required: ["op"],
            },
        },
    },

    async handler(input) {
        const op = getStringParam(input, "op") as Op | null;
        if (!op) return toolError("'op' is required");

        if (op === "schedule") {
            const prompt = getStringParam(input, "prompt");
            const schedule = getStringParam(input, "schedule");
            if (!prompt) return toolError("'prompt' is required for op=schedule");
            if (!schedule) return toolError("'schedule' is required for op=schedule");
            try {
                const job = await addJob({
                    prompt,
                    schedule,
                    deliverTo: getStringParam(input, "deliverTo") ?? undefined,
                    userId: getStringParam(input, "userId") ?? undefined,
                    // isOwner comes from ALS-scoped caller context — never
                    // the LLM args. Absent wrapper → non-owner default.
                    isOwner: _callerStorage.getStore()?.isOwner === true,
                });
                return toolSuccess({
                    success: true,
                    job: {
                        id: job.id,
                        prompt: job.prompt,
                        schedule: job.schedule,
                        scheduleKind: job.scheduleKind,
                        nextRunAt: job.nextRunAt,
                        nextRunAtHuman: new Date(job.nextRunAt).toISOString(),
                    },
                });
            } catch (err) {
                return toolError((err as Error).message);
            }
        }

        if (op === "list") {
            const jobs = getJobs().map((j) => ({
                id: j.id,
                prompt: j.prompt,
                schedule: j.schedule,
                scheduleKind: j.scheduleKind,
                enabled: j.enabled,
                nextRunAt: j.nextRunAt,
                nextRunAtHuman: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
                lastStatus: j.lastStatus,
                lastRunAt: j.lastRunAt,
                lastError: j.lastError,
            }));
            return toolSuccess({ jobs });
        }

        if (op === "cancel") {
            const id = getStringParam(input, "id");
            if (!id) return toolError("'id' is required for op=cancel");
            const removed = await cancelJob(id);
            if (!removed) return toolError(`job not found: ${id}`);
            return toolSuccess({ success: true, id });
        }

        return toolError(`unknown op: ${op}`);
    },
};
