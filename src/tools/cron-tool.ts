// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
export interface CronCallerContext {
    isOwner: boolean;
    autonomous?: boolean;
    /** A private chat with Bhai (not a group or shared channel): owner memories may be shown. */
    isPrivate?: boolean;
    /** The owner's words this turn: memory_store supersedes only when they read like a correction. */
    message?: string;
    /** The last memory memory_store saved in this owner turn, for the reply's "Forget that" button. */
    storedMemory?: { id: number; at: number };
    /** Memory ids the main loop showed the model this turn: the only ones memory_store may supersede. */
    shownMemories?: Set<number>;
    superseded?: boolean;
    pinChanged?: boolean;
    newPinned?: boolean;
    commitmentDone?: boolean;
    /** storedMemory is a supersede's new row: its undo is the only way back to the old one. */
    undoPinned?: boolean;
}
const _callerStorage = new AsyncLocalStorage<CronCallerContext>();
// The tool the owner's main loop (agent.ts) is running; a sub-agent or swarm that tool
// starts inherits the outer name, so its own memory_store/memory_search don't match.
const _mainLoopTool = new AsyncLocalStorage<string>();

export function runAsMainLoopTool<T>(name: string, fn: () => T): T {
    return _mainLoopTool.run(name, fn);
}
export const isMainLoopCall = (tool: string): boolean => _mainLoopTool.getStore() === tool;

/** Run `fn` with `ctx` as the ambient caller context for cron-scheduling. */
export function runWithCallerContext<T>(ctx: CronCallerContext, fn: () => Promise<T> | T): Promise<T> | T {
    return _callerStorage.run(ctx, fn);
}

/** The owner, speaking in this turn: not a contact, not a scheduled/autonomous run. */
export function isOwnerCaller(): boolean {
    const ctx = _callerStorage.getStore();
    return ctx?.isOwner === true && !ctx.autonomous;
}

/** The owner, in a private chat with Bhai. */
export const isPrivateOwnerCaller = (): boolean => isOwnerCaller() && _callerStorage.getStore()?.isPrivate === true;

/** The owner's own message this turn, or "" for contacts and autonomous runs. */
export function ownerTurnMessage(): string {
    return isOwnerCaller() ? (_callerStorage.getStore()?.message ?? "") : "";
}

/**
 * memory_store saved `id` on the owner's live turn: the reply may offer a one-tap undo.
 * A supersede's row (`retired`) keeps the button, since tapping it brings the old memory back.
 */
export function noteStoredMemory(id: number, retired = false): void {
    const ctx = _callerStorage.getStore();
    if (!ctx || !isOwnerCaller() || (ctx.undoPinned && !retired)) return;
    ctx.storedMemory = { id, at: Date.now() };
    ctx.undoPinned = retired;
}

/** The main loop showed the model these memory ids on the owner's turn. */
export function noteShownMemories(ids: number[]): void {
    const ctx = _callerStorage.getStore();
    if (!ctx || !isOwnerCaller()) return;
    ctx.shownMemories ??= new Set();
    for (const id of ids) ctx.shownMemories.add(id);
}

/**
 * The owner's main-loop memory_store may retire `id`: it was shown this turn, and it is the
 * turn's first supersede (so injected text riding an owner turn can't retire arbitrary ids).
 */
export function claimSupersede(id: number): boolean {
    const ctx = _callerStorage.getStore();
    // Private chats only: that's where the reply's "Forget that" tap can bring the old memory back.
    if (!ctx?.isPrivate || !canPinMemory(id) || ctx.superseded) return false;
    ctx.superseded = true;
    return true;
}

/** Like claimSupersede, for pin_id: one pin/unpin of a shown memory per turn. */
export function claimPin(id: number): boolean {
    const ctx = _callerStorage.getStore();
    if (!ctx || !canPinMemory(id) || ctx.pinChanged) return false;
    ctx.pinChanged = true;
    return true;
}

/** pin:true on a new row: once per turn, so injected text riding a "remember…" turn can't pin a batch. */
export function claimNewPin(): boolean {
    const ctx = _callerStorage.getStore();
    if (!ctx || !canPinMemory() || ctx.newPinned) return false;
    ctx.newPinned = true;
    return true;
}

/** Like claimPin, for done_id: one commitment marked done per turn. */
export function claimCommitmentDone(id: number): boolean {
    const ctx = _callerStorage.getStore();
    if (!ctx || !canPinMemory(id) || ctx.commitmentDone) return false;
    ctx.commitmentDone = true;
    return true;
}

/** The owner's main-loop memory_store may pin a new row (no id) or memory `id` shown this turn. */
export function canPinMemory(id?: number): boolean {
    const ctx = _callerStorage.getStore();
    if (!ctx || !isOwnerCaller() || !isMainLoopCall("memory_store")) return false;
    return id === undefined || ctx.shownMemories?.has(id) === true;
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
