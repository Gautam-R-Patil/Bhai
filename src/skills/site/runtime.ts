// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Site Skill runtime: drives one site task (search → options → select →
// confirm → done) with a small per-site skill that decides the next page
// actions from a snapshot. The LLM makes ~3 calls per booking instead of 20-40.
//
//   runSiteTask({ phase: "search", input: { query } })   → options
//   runSiteTask({ task, phase: "select", input: { id } }) → confirm {summary, amount}
//   runSiteTask({ task, phase: "confirm", consentToken }) → done | needs_user
//   runSiteTask({ task, phase: "resume", answer })        → done | needs_user
//
// Guarantees (each has a test in __tests__/runtime.test.ts):
//   • at most MAX_STEPS skill calls + actions per task, across resumes;
//   • the 3rd identical action (same op/target/value) aborts before it runs;
//   • the submit only runs through confirm (the driver also refuses a click,
//     or an Enter/Space, that reaches a commit, a twin of it or a money-word
//     submit through another route), with a consent token minted for
//     exactly this confirm (task, skill version, page, summary, amount, submit),
//     after the total is re-read unchanged, within the spend cap;
//   • write-ahead commit mark: the checkpoint says
//     "sent" before the click, so a submit that timed out is never sent again —
//     the result says it may have gone through, and the next step is to check;
//   • the task never leaves the skill's sites (navigate or redirect → off_site);
//   • questions to the owner come from the skill's manifest, never page text;
//   • a skill that throws/hangs/crashes/returns garbage ends the task as failed.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalArgsHash } from "../../agents/tool-call-guardrail.js";
import { type SiteAction, SkillHost } from "./host.js";

export const MAX_STEPS = 40;
const MAX_USER_PROMPTS = 3;
export const QUESTION_TTL_MS = 10 * 60_000;
const TRANSIENT = /net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|Navigation failed|NS_ERROR_NET/i;

export interface Snapshot {
    url: string;
    title: string;
    text: string;
    elements: Array<Record<string, unknown>>;
}

export interface PageDriver {
    snapshot(): Promise<Snapshot>;
    /**
     * `submit`: the consented commit — the driver may accept one native confirm.
     * Otherwise `commits` (the manifest's): the driver refuses, with an
     * `unconsented_submit` error and before acting, any click (or Enter/Space)
     * that lands on one of them, a control with the same label, or a money-word
     * submit, whatever selector the skill used.
     */
    act(action: SiteAction, opts?: { submit?: boolean; commits?: SiteAction[] }): Promise<void>;
}

export type Phase = "search" | "select" | "confirm" | "after_confirm" | "resume";
export type Status = "options" | "confirm" | "needs_user" | "done" | "failed" | "aborted";
/** What happened to the order. */
export type WriteStatus = "not_attempted" | "may_have_applied" | "applied";

interface Manifest {
    domains: string[];
    commits: SiteAction[]; // the actions that place/pay; only confirm may run them
    questions: Array<{ id: string; kind: string; prompt: string }>;
}

export interface SiteTask {
    taskId: string;
    skillPath: string;
    skillHash: string;
    phase: Phase;
    status?: Status | "superseded";
    stepCount: number;
    repeats: Record<string, number>;
    state: Record<string, unknown>;
    userPrompts: number;
    waitingUntil?: number; // a needs_user answer after this is too late
    pendingConfirm?: { summary: string; amount: number; submit: SiteAction; page: string };
    commit?: { hash: string; state: "sent" | "confirmed" };
    lastError?: string;
}

export interface SiteTaskResult {
    status: Status;
    options?: Array<{ id: string; label: string; price?: number }>;
    confirm?: { summary: string; amount: number };
    needsUser?: { kind: string; prompt: string; retry?: string };
    summary?: string;
    reason?: string;
    writeStatus: WriteStatus;
    task: SiteTask;
}

// ── Manifest ──────────────────────────────────

function readManifest(skillPath: string): Manifest {
    const p = path.join(path.dirname(skillPath), "skill.json");
    try {
        const m = JSON.parse(readFileSync(p, "utf8")) as Partial<Manifest>;
        return { domains: m.domains ?? [], commits: m.commits ?? [], questions: m.questions ?? [] };
    } catch {
        return { domains: [], commits: [], questions: [] };
    }
}

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
};
const onSite = (url: string, domains: string[]) => {
    const h = hostOf(url);
    return !domains.length || domains.some((d) => h === d || h.endsWith(`.${d}`));
};
const pageKey = (url: string) => {
    try {
        const u = new URL(url);
        return u.origin + u.pathname;
    } catch {
        return url;
    }
};
const actionKey = (a: SiteAction) => canonicalArgsHash(a.op, { target: a.target ?? null, value: a.value ?? null });

// ── Consent tokens ────────────────────────────
// Minted only by the user-facing layer after the owner said yes to the exact
// confirm shown (security/consent.ts), never by the LLM. Single use, 5 minutes.
// Bound to the skill version and page too: a hot-reloaded skill or a redirect
// between the yes and the click invalidates it.

const consents = new Map<string, { taskId: string; hash: string; exp: number }>();
const confirmHash = (task: SiteTask) => {
    const c = task.pendingConfirm as NonNullable<SiteTask["pendingConfirm"]>;
    return canonicalArgsHash("confirm", { skill: task.skillHash, page: c.page, summary: c.summary, amount: c.amount, submit: c.submit });
};

export function mintConsent(task: SiteTask): string {
    if (task.commit?.state === "sent") throw new Error("the last order may have gone through; check before ordering again");
    if (!task.pendingConfirm) throw new Error("nothing to confirm");
    const token = randomBytes(16).toString("hex");
    consents.set(token, { taskId: task.taskId, hash: confirmHash(task), exp: Date.now() + 5 * 60_000 });
    return token;
}

function takeConsent(token: string | undefined, task: SiteTask): boolean {
    const c = token ? consents.get(token) : undefined;
    if (token) consents.delete(token);
    return !!c && !!task.pendingConfirm && c.taskId === task.taskId && c.hash === confirmHash(task) && c.exp > Date.now();
}

// ── Spend cap (INR) ───────────────────────────
// ponytail: in-memory ledger, so a restart resets today's total; persist it
// next to the checkpoints when real checkout ships.
const spent: Array<{ at: number; amount: number }> = [];

export function spendAllowed(amount: number): boolean {
    const perOrder = Number(process.env.ATLAS_SPEND_CAP_ORDER_INR ?? 5000);
    const perDay = Number(process.env.ATLAS_SPEND_CAP_DAY_INR ?? 10000);
    const dayAgo = Date.now() - 86_400_000;
    const today = spent.filter((s) => s.at > dayAgo).reduce((sum, s) => sum + s.amount, 0);
    return amount <= perOrder && today + amount <= perDay;
}

// ── Checkpoints ───────────────────────────────

const fileHash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

export function saveCheckpoint(dir: string | undefined, task: SiteTask): void {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${task.taskId}.json`);
    writeFileSync(`${p}.tmp`, JSON.stringify(task));
    renameSync(`${p}.tmp`, p); // atomic: a crash never leaves half a checkpoint
}

export function loadCheckpoint(dir: string, taskId: string): SiteTask | null {
    const p = path.join(dir, `${taskId}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SiteTask) : null;
}

// ── Runtime ───────────────────────────────────

export async function runSiteTask(opts: {
    skillPath?: string;
    task?: SiteTask;
    phase: Phase;
    input?: unknown;
    answer?: string;
    consentToken?: string;
    driver: PageDriver;
    checkpointDir?: string;
}): Promise<SiteTaskResult> {
    const skillPath = opts.task?.skillPath ?? opts.skillPath;
    if (!skillPath) throw new Error("runSiteTask needs skillPath or task");
    const task: SiteTask = opts.task ?? {
        taskId: randomBytes(8).toString("hex"),
        skillPath,
        skillHash: "",
        phase: opts.phase,
        stepCount: 0,
        repeats: {},
        state: {},
        userPrompts: 0,
    };
    task.skillHash = fileHash(skillPath); // a fresh child per call picks up edits (hot reload)
    task.phase = opts.phase;
    const manifest = readManifest(skillPath);
    const commitKeys = new Set(manifest.commits.map(actionKey));
    const writeStatus = (): WriteStatus => (task.commit ? (task.commit.state === "confirmed" ? "applied" : "may_have_applied") : "not_attempted");
    const end = (status: Status, extra: Partial<SiteTaskResult> = {}): SiteTaskResult => {
        task.status = status;
        if (status === "done" && task.commit) task.commit.state = "confirmed";
        saveCheckpoint(opts.checkpointDir, task);
        return { status, task, writeStatus: writeStatus(), ...extra };
    };

    if (task.commit?.state === "sent" && opts.phase === "confirm") return end("failed", { reason: "commit_unresolved" });
    if (opts.phase === "resume" && task.waitingUntil && Date.now() > task.waitingUntil) {
        return end("failed", { reason: "no_response" }); // a late code is never typed
    }

    const host = new SkillHost(skillPath);
    try {
        return await drive();
    } catch (e) {
        // A page or bridge error mid-task still ends with the task's real state: after
        // the submit that is "may have been placed", never a bare error that invites
        // a second checkout.
        return end("failed", { reason: `driver_error: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    } finally {
        host.close();
    }

    async function drive(): Promise<SiteTaskResult> {
        // Runs one action under the step cap, the identical-args killer, the
        // same-site fence and the commit rule.
        const exec = async (a: SiteAction, viaConfirm = false): Promise<SiteTaskResult | null> => {
            if (task.stepCount >= MAX_STEPS) return end("aborted", { reason: "max_steps" });
            const key = actionKey(a);
            const isSubmit = commitKeys.has(key) || (task.pendingConfirm && key === actionKey(task.pendingConfirm.submit));
            if (isSubmit && !viaConfirm) return end("aborted", { reason: "unconsented_submit" });
            if (a.op === "navigate" && !onSite(a.value ?? "", manifest.domains)) return end("aborted", { reason: "off_site" });
            if (a.op !== "waitFor") {
                task.repeats[key] = (task.repeats[key] ?? 0) + 1;
                if (task.repeats[key] >= 3) return end("aborted", { reason: "loop_identical_args" });
            }
            task.stepCount++;
            // A dropped network is waited out on the same step (backoff up to ~15s),
            // so it neither burns steps nor trips the loop killer. A submit is never
            // retried: it may have reached the site (the write-ahead mark handles it).
            for (let attempt = 0; ; attempt++) {
                try {
                    const n = viaConfirm ? 1 : (a.times ?? 1); // the submit runs once, always
                    for (let i = 0; i < n; i++) await opts.driver.act(a, viaConfirm ? { submit: true } : { commits: manifest.commits });
                    task.lastError = undefined;
                    break;
                } catch (e) {
                    const msg = String((e as Error).message ?? e);
                    if (msg.startsWith("unconsented_submit")) return end("aborted", { reason: "unconsented_submit" });
                    if (!viaConfirm && attempt < 5 && TRANSIENT.test(msg)) {
                        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
                        continue;
                    }
                    task.lastError = msg.slice(0, 300); // the skill sees it next step
                    break;
                }
            }
            saveCheckpoint(opts.checkpointDir, task);
            return null;
        };

        let answer = opts.answer;
        task.waitingUntil = undefined;
        // A fresh answer is new input: the 3rd OTP attempt the prompt cap allows
        // mustn't trip the identical-action killer. MAX_STEPS still bounds it.
        if (opts.phase === "resume" && answer) task.repeats = {};

        if (opts.phase === "confirm") {
            const pending = task.pendingConfirm;
            if (!pending) return end("failed", { reason: "nothing_to_confirm" });
            if (!takeConsent(opts.consentToken, task)) return end("failed", { reason: "consent_required" });
            // Re-read the total right before paying: fees and prices move between
            // select and confirm. Any change goes back to the owner. If the page was
            // reloaded (a ticked box lost), the skill's preparation steps run again —
            // never the submit, which exec() refuses outside this path.
            let again: Awaited<ReturnType<typeof host.call>> = {};
            for (let round = 0; round < 3; round++) {
                task.stepCount++;
                const snap = await opts.driver.snapshot();
                if (pageKey(snap.url) !== pending.page) return end("failed", { reason: "page_changed" });
                again = await host.call("select", { snapshot: snap, input: undefined, state: task.state });
                if (!again.actions?.length) break;
                for (const a of again.actions) {
                    const stop = await exec(a);
                    if (stop) return stop;
                }
            }
            if (!again.confirm || again.confirm.amount !== pending.amount || again.confirm.summary !== pending.summary) {
                if (!again.confirm) {
                    task.pendingConfirm = undefined;
                    return end("failed", { reason: "total_changed" });
                }
                // Park the new total as a fresh confirm: the owner says yes to it (or not).
                task.pendingConfirm = { ...again.confirm, page: pending.page };
                return end("confirm", { reason: "total_changed", confirm: { summary: again.confirm.summary, amount: again.confirm.amount } });
            }
            if (!spendAllowed(pending.amount)) return end("failed", { reason: "spend_cap" });
            // Write-ahead: "sent" is on disk before the click, and the spend is booked.
            task.commit = { hash: actionKey(pending.submit), state: "sent" };
            spent.push({ at: Date.now(), amount: pending.amount });
            saveCheckpoint(opts.checkpointDir, task);
            const stop = await exec(pending.submit, true);
            if (stop) return stop;
            task.pendingConfirm = undefined;
            task.phase = "after_confirm";
        }

        for (;;) {
            if (task.stepCount >= MAX_STEPS) return end("aborted", { reason: "max_steps" });
            task.stepCount++;
            const snapshot = await opts.driver.snapshot();
            if (snapshot.url.startsWith("chrome-error://")) return end("failed", { reason: "network_error" });
            if (!onSite(snapshot.url, manifest.domains)) return end("aborted", { reason: "off_site" });
            const r = await host.call(task.phase, {
                snapshot,
                input: opts.input,
                answer,
                state: task.state,
                lastError: task.lastError,
            });
            answer = undefined; // a code is typed once; a re-prompt asks again
            if (r.state) task.state = r.state;

            if (r.fail) return end("failed", { reason: r.fail.reason });
            if (r.done) return end("done", { summary: r.done.summary });
            if (r.options) return end("options", { options: r.options });
            if (r.confirm) {
                // After a submit the order may already exist: never ask to pay again.
                if (task.commit?.state === "sent") return end("failed", { reason: "possible_commit" });
                task.pendingConfirm = { ...r.confirm, page: pageKey(snapshot.url) };
                return end("confirm", { confirm: { summary: r.confirm.summary, amount: r.confirm.amount } });
            }
            if (r.needsUser) {
                const q = manifest.questions.find((x) => x.id === r.needsUser?.question);
                if (!q) return end("failed", { reason: "undeclared_question" });
                if (++task.userPrompts > MAX_USER_PROMPTS) return end("failed", { reason: "too_many_prompts" });
                task.waitingUntil = Date.now() + QUESTION_TTL_MS;
                return end("needs_user", {
                    needsUser: { kind: q.kind, prompt: q.prompt, retry: r.needsUser.retry ? "That didn't work. Please check it and send it again." : undefined },
                });
            }
            if (!r.actions?.length) return end("failed", { reason: "skill_no_progress" });
            for (const a of r.actions) {
                const stop = await exec(a);
                if (stop) return stop;
            }
        }
    }
}
