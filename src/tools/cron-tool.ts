// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { toolError, toolSuccess } from "./tool-result.js";
import { addJob, cancelJob, getJobs } from "../cron/store.js";

type Op = "schedule" | "list" | "cancel" | "trigger";

function getStringParam(
    input: Record<string, unknown>,
    key: string,
): string | null {
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
                        description:
                            "(schedule only, optional) User id / chat id for routing delivery.",
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
                nextRunAtHuman: j.nextRunAt
                    ? new Date(j.nextRunAt).toISOString()
                    : null,
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
