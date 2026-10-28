// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// site_task: book/order on a site that has a Site Skill (src/skills/site) in
// ~3 calls instead of 20-40 raw browser steps. Checkout goes through the
// consent gate in tools/index.ts (DESTRUCTIVE_ACTIONS.site_task = confirm), so
// this handler only runs a confirm after the owner said yes in a new message;
// it then mints the single-use token the runtime requires.

import { pageDriver } from "../skills/site/page-driver.js";
import { findSiteSkill } from "../skills/site/registry.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { loadCheckpoint, mintConsent, type PageDriver, type Phase, runSiteTask, saveCheckpoint, type SiteTask, type SiteTaskResult } from "../skills/site/runtime.js";
import { checkConsent } from "../security/consent.js";
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

// A human check (CAPTCHA) stopped the task: the owner ticks it via
// browser_wait_for_human, then resume re-runs the phase it stopped in.
// ponytail: in memory only; a restart mid-wait drops it (the owner starts again).
const HUMAN_CHECK = "human_check";
let humanCheck: { phase: Phase; input?: Record<string, unknown> } | null = null;
const HANDOFF =
    "The site is showing a human-verification check (CAPTCHA). Don't tick or solve it yourself: call browser_wait_for_human so the owner can do it.";

const NEXT: Record<SiteTaskResult["status"], string> = {
    options: "Show the user these options and ask which one. Then call site_task with action select and option_id.",
    confirm:
        "Tell the user exactly what will be ordered and the total, and ask them to confirm. Only after they say yes, call site_task with action confirm, the same amount, and confirmed: true.",
    needs_user: "Ask the user for this (e.g. the code they received). Then call site_task with action resume and answer.",
    done: "Tell the user it's done, with the summary.",
    // write_status may_have_applied: the order may exist. Never place it again.
    failed: "Tell the user what went wrong; you can continue with the browser tools if they want.",
    aborted: "A safety limit stopped this task; tell the user and continue manually only if they ask.",
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
        if (busy) return JSON.stringify({ error: "A site task step is still running. Wait for it before the next call." });
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
        const base = pageDriver(page, 5000, () => getActivePage()); // a closed tab is reopened
        // Stop before the skill sees a CAPTCHA page: it must never click it.
        const driver: PageDriver = {
            ...base,
            snapshot: async () => {
                const { quickCaptchaCheck } = await import("./browser/captcha.js"); // lazy: avoids an import cycle via the bridge
                if (await quickCaptchaCheck(page)) throw new Error(HUMAN_CHECK);
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
                    needsUser: { kind: HUMAN_CHECK, prompt: "Complete the human-verification check on the site" },
                    writeStatus: r.writeStatus,
                    task_id: r.task.taskId,
                    steps: r.task.stepCount,
                    next_step: `${HANDOFF} When it returns cleared, ${again ? "call site_task with action confirm again with the same amount" : "call site_task with action resume (no answer needed)"}.`,
                });
            }
            current = r.status === "done" || r.status === "failed" || r.status === "aborted" ? null : r.task;
            const { task, ...rest } = r;
            const next =
                r.writeStatus === "may_have_applied" && r.status !== "done"
                    ? "The order may already have been placed (the submit didn't confirm). Do NOT order again: tell the user, and check the site's orders page with the browser tools."
                    : r.reason === "total_changed"
                      ? "The total changed since the user agreed. Show the new total (if any) and ask again before confirming."
                      : NEXT[r.status];
            // Showing the total is the "ask": record it, so the owner's next yes
            // grants the confirm call (else the gate would need a second yes).
            if (r.status === "confirm" && r.confirm) {
                const { consentKey } = await import("./index.js");
                checkConsent(consentKey("site_task", { action: "confirm", amount: r.confirm.amount }), false);
            }
            return JSON.stringify({ ...rest, task_id: task.taskId, steps: task.stepCount, next_step: next });
        };

        const dir = checkpointDir();
        if (action === "search") {
            const skillPath = findSiteSkill(page.url());
            if (!skillPath) return JSON.stringify({ error: `No site skill for ${page.url()}. Use the browser tools instead.` });
            if (current?.commit?.state === "sent") {
                return JSON.stringify({ error: "The last order may already have been placed. Check the site's orders page before starting another one." });
            }
            if (current) {
                current.status = "superseded"; // a new search abandons the parked one
                saveCheckpoint(dir, current);
            }
            const searchInput = { query: input.query };
            return view(await runSiteTask({ skillPath, phase: "search", input: searchInput, driver, checkpointDir: dir }), searchInput);
        }
        current ??= restoreParked(); // a parked task survives a restart (its consent does not)
        if (!current) return JSON.stringify({ error: "No site task in progress. Start with action: search." });
        if (action === "select") {
            const selectInput = { id: input.option_id };
            return view(await runSiteTask({ task: current, phase: "select", input: selectInput, driver, checkpointDir: dir }), selectInput);
        }
        if (action === "confirm") {
            // Checkout needs a page that can take the "Place order?" dialog and prove one
            // match (the built-in browser). Refuse before anything is marked as sent.
            if (typeof (page as { on?: unknown }).on !== "function") {
                return JSON.stringify({ error: "Checkout through the Chrome extension isn't supported yet. Ask the user to place the order themselves, or use the built-in browser." });
            }
            if (current.commit?.state === "sent") {
                return JSON.stringify({ error: "The last order may already have been placed. Check the site's orders page before anything else; never order again blindly." });
            }
            if (!current.pendingConfirm || input.amount !== current.pendingConfirm.amount) {
                return JSON.stringify({ error: "Nothing is waiting for confirmation at that total. Show the user the current summary first." });
            }
            return view(await runSiteTask({ task: current, phase: "confirm", consentToken: mintConsent(current), driver, checkpointDir: dir }));
        }
        if (action === "resume" && humanCheck) {
            const { phase, input: phaseInput } = humanCheck;
            current.repeats = {}; // the same step again after the check is not a loop
            return view(await runSiteTask({ task: current, phase, input: phaseInput, driver, checkpointDir: dir }), phaseInput);
        }
        if (action === "resume") {
            return view(await runSiteTask({ task: current, phase: "resume", answer: input.answer as string, driver, checkpointDir: dir }));
        }
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
}
