// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// site_task: book/order on a site that has a Site Skill (src/skills/site) in
// ~3 calls instead of 20-40 raw browser steps. Checkout goes through the
// consent gate in tools/index.ts (DESTRUCTIVE_ACTIONS.site_task = confirm), so
// this handler only runs a confirm after the owner said yes in a new message;
// it then mints the single-use token the runtime requires.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { currentSwarmRun } from "../agents/swarm-context.js";
import { getDataDir } from "../config/paths.js";
import { checkConsent } from "../security/consent.js";
import { pendingRepair, repairBlocked } from "../skills/site/drift.js";
import { drainTrace, startTrace, tracing } from "../skills/site/mint/recorder.js";
import { pageDriver } from "../skills/site/page-driver.js";
import { findSiteSkill } from "../skills/site/registry.js";
import {
    loadCheckpoint,
    mintConsent,
    type PageDriver,
    type Phase,
    runSiteTask,
    type SiteTask,
    type SiteTaskResult,
    saveCheckpoint,
} from "../skills/site/runtime.js";
import { getActivePage } from "./browser/core.js";
import type { ToolDefinition } from "./get-current-time.js";

// ponytail: one site task at a time; key by task_id if parallel bookings matter.
let current: SiteTask | null = null;
const checkpointDir = () => path.join(getDataDir(), "site-tasks");

/** After a restart: the newest task still waiting on a choice, a confirm or a code. */
function restoreParked(): SiteTask | null {
    const dir = checkpointDir();
    if (!existsSync(dir)) return null;
    const newest = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
    const task = newest ? loadCheckpoint(dir, newest.f.replace(/\.json$/, "")) : null;
    return task && ["options", "confirm", "needs_user"].includes(task.status ?? "") ? task : null;
}
let busy = false;

/**
 * Records the agent's browser session on this site (locally, for the Skill
 * Minter), unless that's off or the backend can't (the Chrome extension has no
 * init scripts). True when a recording is running. `fresh` starts a new one
 * even when this site is already recorded (a repair needs a session that
 * starts after the skill failed).
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function recordSession(page: any, fresh = false): Promise<boolean> {
    if (process.env.BHAI_NO_SITE_MINT === "true" || process.env.BHAI_NO_SITE_TRACE === "true") return false;
    if (typeof page?.context !== "function") return false;
    let domain = "";
    try {
        domain = new URL(page.url()).hostname.replace(/^www\./, "");
    } catch {}
    if (!domain) return false;
    if (tracing(page) === domain && !fresh) return true;
    try {
        await startTrace(page.context(), domain);
        await drainTrace(page);
        return true;
    } catch {
        return false;
    }
}

const REPAIR_NEXT =
    "The site changed and the learned skill no longer fits it (nothing was ordered). Tell the user. Only if they want, finish the task with the browser tools (this session is recorded on this machine); when it's done, call site_skill_mint with action repair: Bhai fixes the skill in the background from it.";

// A CAPTCHA mid-task goes to the CAPTCHA pipeline right in the snapshot (solvers,
// then the owner) and the skill carries on. Only one the owner didn't finish either
// stops the task; resume then re-runs the phase it stopped in.
// ponytail: in memory only; a restart mid-wait drops it (the owner starts again).
const HUMAN_CHECK = "human_check";
let humanCheck: { phase: Phase; input?: Record<string, unknown> } | null = null;
/** Tests: forget the task in memory (its checkpoint is the caller's to remove). */
export function _resetSiteTask(): void {
    current = null;
    humanCheck = null;
}
const HANDOFF =
    "The site has a step only the owner can finish (they were asked and it's still open). Tell them in one line.";

const NEXT: Record<SiteTaskResult["status"], string> = {
    options: "Show the user these options and ask which one. Then call site_task with action select and option_id.",
    confirm:
        "Tell the user exactly what will be ordered and the total, and ask them to confirm. Only after they say yes, call site_task with action confirm, the same amount, and confirmed: true.",
    needs_user:
        "Ask the user for this (e.g. the code they received). Then call site_task with action resume and answer.",
    done: "Tell the user it's done, with the summary.",
    // write_status may_have_applied: the order may exist. Never place it again.
    failed: "Tell the user what went wrong; you can continue with the browser tools if they want.",
    aborted: "A safety limit stopped this task; tell the user and continue manually only if they ask.",
    refused:
        "The site doesn't offer that as asked (no match, sold out, or two that fit equally). Show the user `available` and ask which one; then start again with action search and their choice.",
};

export const siteTask: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "site_task",
            description:
                "Search, pick and order on the site open in the browser when Bhai has a site skill for it (faster and safer than clicking step by step). Flow: search → the user picks an option → select → the user confirms the total → confirm → resume if the site asks for a code. Returns an error if there is no skill for the site; then use the browser tools.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["search", "select", "confirm", "resume"] },
                    query: { type: "string", description: "search: what to look for" },
                    option_id: { type: "string", description: "select: the id of the option the user picked" },
                    amount: { type: "number", description: "confirm: the total you showed the user" },
                    answer: { type: "string", description: "resume: the user's reply, e.g. the OTP" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        if (busy)
            return JSON.stringify({ error: "A site task step is still running. Wait for it before the next call." });
        busy = true;
        try {
            return await run(input);
        } finally {
            busy = false;
        }
    },
};

async function run(input: Record<string, unknown>): Promise<string> {
    {
        const action = input.action as string;
        const page = await getActivePage();
        // The owner's Stop (tools/index.ts STOPPABLE_TOOLS): the task ends at once.
        const signal = input._signal as AbortSignal | undefined;
        // A closed tab is reopened, and goes back to its last page only while no order may exist.
        const base = pageDriver(
            page,
            5000,
            () => getActivePage(),
            signal,
            () => !!current?.commit,
        );
        // The skill never sees a CAPTCHA page (it must never click one): the pipeline clears it first.
        const driver: PageDriver = {
            ...base,
            snapshot: async () => {
                const { clearCaptchaIfAny } = await import("./browser/captcha.js"); // lazy: avoids an import cycle via the bridge
                const check = await clearCaptchaIfAny(page, signal);
                if (check.present && !check.cleared) throw new Error(HUMAN_CHECK);
                return base.snapshot();
            },
        };
        const view = async (r: SiteTaskResult, phaseInput?: Record<string, unknown>) => {
            humanCheck = null;
            if (r.reason?.startsWith(`driver_error: ${HUMAN_CHECK}`)) {
                current = r.task;
                const again = r.task.phase === "confirm"; // re-confirming goes back through the consent gate
                if (!again) humanCheck = { phase: r.task.phase, input: phaseInput };
                return JSON.stringify({
                    status: "needs_user",
                    needsUser: { kind: HUMAN_CHECK, prompt: "Finish the open step on the site" },
                    writeStatus: r.writeStatus,
                    task_id: r.task.taskId,
                    steps: r.task.stepCount,
                    next_step: `${HANDOFF} When they say it's done, ${again ? "call site_task with action confirm again with the same amount" : "call site_task with action resume (no answer needed)"}.`,
                });
            }
            // An order that may exist keeps its task, so the next search stops at "may already have been placed".
            current =
                ["done", "failed", "aborted", "refused"].includes(r.status) && r.writeStatus !== "may_have_applied"
                    ? null
                    : r.task;
            const { task, ...rest } = r;
            // The site changed under a learned skill: the owner's task is finished by
            // hand while recording, and that session repairs the skill.
            const repair = r.repairQueued && (await recordSession(page, true));
            const next = repair
                ? REPAIR_NEXT
                : r.needsUser?.kind === "payment"
                  ? "The order is on the site's payment page. Ask the user to finish paying there themselves (never enter card or UPI details); when they say it's done, call site_task with action resume. Do NOT order again."
                  : r.writeStatus === "may_have_applied" && r.status !== "done" && r.status !== "needs_user"
                    ? "The order may already have been placed (the submit didn't confirm). Do NOT order again: tell the user, and check the site's orders page with the browser tools."
                    : r.reason === "stopped"
                      ? "The owner pressed Stop; nothing was ordered. Don't continue this task unless they ask."
                      : r.reason === "total_changed"
                        ? "The total changed since the user agreed. Show the new total (if any) and ask again before confirming."
                        : r.reason?.startsWith("commit_rejected")
                          ? "The site turned the order down (nothing was placed). Tell the user what it said and ask whether to try once more; only after a new yes, call site_task with action confirm again."
                          : NEXT[r.status];
            // Showing the total is the "ask": record it, so the owner's next yes
            // grants the confirm call (else the gate would need a second yes).
            // Not inside a swarm: the owner hasn't seen the total yet, so an "ok" sent
            // mid-run must not grant a later confirm; the main agent's own first
            // confirm attempt registers the ask after it shows the total.
            if (r.status === "confirm" && r.confirm && !currentSwarmRun()) {
                const { consentKey } = await import("./index.js");
                checkConsent(consentKey("site_task", { action: "confirm", amount: r.confirm.amount }), false);
            }
            return JSON.stringify({ ...rest, task_id: task.taskId, steps: task.stepCount, next_step: next });
        };

        const dir = checkpointDir();
        if (action === "search") {
            const skillPath = findSiteSkill(page.url());
            if (!skillPath) {
                // A learned skill that stopped fitting the site (drifted) waits for a repair, not a new mint.
                let host = "";
                try {
                    host = new URL(page.url()).hostname.replace(/^www\./, "");
                } catch {}
                const pending = host ? pendingRepair(host) : null;
                const fix = pending && !repairBlocked(pending.capture.skill, pending.capture.skillDir);
                const learn = await recordSession(page, !!fix);
                return JSON.stringify({
                    error: `No site skill for ${page.url()}. Use the browser tools instead.`,
                    ...(learn &&
                        (fix || !pending) && {
                            next_step: fix
                                ? REPAIR_NEXT
                                : "Do it with the browser tools; this session is recorded on this machine. When it's done, offer to learn this site so next time takes ~3 steps (site_skill_mint start, only if the user agrees: it costs a few credits).",
                        }),
                });
            }
            if (current?.commit?.state === "sent") {
                return JSON.stringify({
                    error: "The last order may already have been placed. Check the site's orders page before starting another one.",
                });
            }
            if (current) {
                current.status = "superseded"; // a new search abandons the parked one
                saveCheckpoint(dir, current);
            }
            const searchInput = { query: input.query };
            return view(
                await runSiteTask({
                    skillPath,
                    phase: "search",
                    input: searchInput,
                    driver,
                    checkpointDir: dir,
                    signal,
                }),
                searchInput,
            );
        }
        current ??= restoreParked(); // a parked task survives a restart (its consent does not)
        if (!current) return JSON.stringify({ error: "No site task in progress. Start with action: search." });
        if (action === "select") {
            const selectInput = { id: input.option_id };
            return view(
                await runSiteTask({
                    task: current,
                    phase: "select",
                    input: selectInput,
                    driver,
                    checkpointDir: dir,
                    signal,
                }),
                selectInput,
            );
        }
        if (action === "confirm") {
            // Checkout needs a page that can take the "Place order?" dialog and prove one
            // match (the built-in browser). Refuse before anything is marked as sent.
            if (typeof (page as { on?: unknown }).on !== "function") {
                return JSON.stringify({
                    error: "Checkout through the Chrome extension isn't supported yet. Ask the user to place the order themselves, or use the built-in browser.",
                });
            }
            if (current.commit?.state === "sent") {
                return JSON.stringify({
                    error: "The last order may already have been placed. Check the site's orders page before anything else; never order again blindly.",
                });
            }
            if (!current.pendingConfirm || input.amount !== current.pendingConfirm.amount) {
                return JSON.stringify({
                    error: "Nothing is waiting for confirmation at that total. Show the user the current summary first.",
                });
            }
            return view(
                await runSiteTask({
                    task: current,
                    phase: "confirm",
                    consentToken: mintConsent(current),
                    driver,
                    checkpointDir: dir,
                    signal,
                }),
            );
        }
        if (action === "resume" && humanCheck) {
            const { phase, input: phaseInput } = humanCheck;
            current.repeats = {}; // the same step again after the check is not a loop
            return view(
                await runSiteTask({ task: current, phase, input: phaseInput, driver, checkpointDir: dir, signal }),
                phaseInput,
            );
        }
        if (action === "resume" && humanCheck) {
            const { phase, input: phaseInput } = humanCheck;
            current.repeats = {}; // the same step again after the check is not a loop
            return view(
                await runSiteTask({ task: current, phase, input: phaseInput, driver, checkpointDir: dir, signal }),
                phaseInput,
            );
        }
        if (action === "resume") {
            return view(
                await runSiteTask({
                    task: current,
                    phase: "resume",
                    answer: input.answer as string,
                    driver,
                    checkpointDir: dir,
                    signal,
                }),
            );
        }
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
}
