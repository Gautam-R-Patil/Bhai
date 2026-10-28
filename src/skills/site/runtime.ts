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
//   • the site's own "no" to the submit (judgeCommit not_done) clears the
//     "sent" mark once, so the owner can say yes again; never twice, and never
//     when the page moved on or shows the confirmation (confirmPattern);
//   • a stopped task says who can move it on (retry): fix the input, the owner,
//     later, by hand — or never, once the order may exist;
//   • write-ahead commit mark: the checkpoint says
//     "sent" before the click, so a submit that timed out is never sent again —
//     the result says it may have gone through, and the next step is to check;
//   • the task never leaves the skill's sites (navigate or redirect → off_site),
//     except a redirect to one of its paymentDomains after the consented
//     submit, which hands the page to the owner (needs_user: finish payment);
//   • questions to the owner come from the skill's manifest, never page text;
//   • a skill that throws/hangs/crashes/returns garbage ends the task as failed;
//   • a minted skill's runs are logged, and a run that stopped because the
//     site changed (drift, nothing sent) leaves a capture for its repair
//     (drift.ts; __tests__ in mint/__tests__/self-heal.test.ts).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalArgsHash } from "../../agents/tool-call-guardrail.js";
import { captureDrift, isDrift, noteRun } from "./drift.js";
import { type SiteAction, SkillHost } from "./host.js";

export const MAX_STEPS = 40;
const MAX_USER_PROMPTS = 3;
// Bhai never types card details: on the gateway the owner finishes it.
export const PAY_ON_PAGE = "Finish the payment on the page, then tell me when it's done.";
export const QUESTION_TTL_MS = 10 * 60_000;
const TRANSIENT = /net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|Navigation failed|NS_ERROR_NET/i;

export interface Snapshot {
    url: string;
    title: string;
    text: string;
    elements: Array<Record<string, unknown>>;
}

/** What the site answered to the submit (page-driver judgeCommit). */
export interface CommitVerdict {
    verdict: "done" | "not_done" | "unclear";
    detail?: string; // the site's own message, when it gave one
}
/** `outcome`: the expect outcome that won; `verdict`: for the submit only. */
export type ActResult = { outcome?: string; verdict?: CommitVerdict } | undefined;

export interface PageDriver {
    snapshot(): Promise<Snapshot>;
    /**
     * `submit`: the consented commit — the driver may accept one native confirm.
     * Otherwise `commits` (the manifest's): the driver refuses, with an
     * `unconsented_submit` error and before acting, any click (or Enter/Space)
     * that lands on one of them, a control with the same label, or a money-word
     * submit, whatever selector the skill used.
     */
    // biome-ignore lint/suspicious/noConfusingVoidType: a driver with nothing to report returns nothing
    // `domains`: the skill's sites; only their requests count (progress, the submit's verdict).
    act(action: SiteAction, opts?: { submit?: boolean; commits?: SiteAction[]; domains?: string[] }): Promise<ActResult | void>;
    /** The page's DOM as the user saw it (for a drift capture); optional. */
    html?(): Promise<string>;
}

export type Phase = "search" | "select" | "confirm" | "after_confirm" | "resume";
export type Status = "options" | "confirm" | "needs_user" | "done" | "failed" | "aborted" | "refused";
/** What happened to the order. */
export type WriteStatus = "not_attempted" | "may_have_applied" | "applied";
/**
 * Who can move a stopped task on: fix_input (the owner picks another value
 * from what the site offers, then search again), ask_owner (the owner acts:
 * a captcha, a sign-in, the spend cap), later (the site or network was down;
 * the same call may run again), manual (the skill no longer fits the site:
 * carry on with the browser tools), never (the order may exist: check, never
 * place it again).
 */
export type Retry = "fix_input" | "ask_owner" | "later" | "manual" | "never";
export type FailKind = "input_rejected" | "needs_owner" | "site_error" | "unexpected_page";

interface Manifest {
    domains: string[];
    commits: SiteAction[]; // the actions that place/pay; only confirm may run them
    questions: Array<{ id: string; kind: string; prompt: string }>;
    paymentDomains: string[]; // a gateway the consented submit may redirect to
    confirmPattern?: string; // the site's order confirmation (an order id)
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
    commitReverted?: boolean; // the site's "no" cleared "sent" once already
    lastError?: string;
    lastOutcome?: string; // the expect outcome the last action ended on
    searchInput?: unknown; // what search was given (a drift capture keeps it, locally)
    options?: Array<{ id: string; label: string }>; // what search offered
    choice?: string; // the label of the option select was given (a drift capture keeps it, locally)
}

export interface SiteTaskResult {
    status: Status;
    options?: Array<{ id: string; label: string; price?: number }>;
    confirm?: { summary: string; amount: number };
    needsUser?: { kind: string; prompt: string; retry?: string };
    refused?: { field: string; available: string[] };
    summary?: string;
    reason?: string;
    writeStatus: WriteStatus;
    retry?: Retry; // failed, aborted and refused only
    repairQueued?: boolean; // the site changed under a minted skill: a repair can run from a recorded session
    task: SiteTask;
}

// ── Manifest ──────────────────────────────────

function readManifest(skillPath: string): Manifest {
    const p = path.join(path.dirname(skillPath), "skill.json");
    try {
        const m = JSON.parse(readFileSync(p, "utf8")) as Partial<Manifest>;
        return {
            domains: m.domains ?? [],
            commits: m.commits ?? [],
            questions: m.questions ?? [],
            paymentDomains: m.paymentDomains ?? [],
            confirmPattern: m.confirmPattern,
        };
    } catch {
        return { domains: [], commits: [], questions: [], paymentDomains: [] };
    }
}

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
};
/** On one of `domains` (or any site, when there are none). */
export const onSite = (url: string, domains: string[] = []) => {
    const h = hostOf(url);
    return !domains.length || domains.some((d) => h === d || h.endsWith(`.${d}`));
};
const pathOf = (url: string) => {
    try {
        return new URL(url).pathname;
    } catch {
        return "";
    }
};
const pageKey = (url: string) => {
    try {
        const u = new URL(url);
        return u.origin + u.pathname;
    } catch {
        return url;
    }
};
/** A stopped task's retry class; `kind` is the skill's own (fail.kind), else read off the reason. */
export function retryOf(status: Status, reason: string | undefined, writeStatus: WriteStatus, kind?: FailKind): Retry | undefined {
    if (status !== "failed" && status !== "aborted" && status !== "refused") return undefined;
    if (writeStatus !== "not_attempted") return "never";
    if (status === "refused") return "fix_input";
    const r = reason ?? "";
    const k = kind ?? (r.startsWith("input_rejected") ? "input_rejected" : r.startsWith("needs_owner") ? "needs_owner" : undefined);
    if (k === "input_rejected") return "fix_input";
    if (k === "needs_owner" || /^(spend_cap|consent_required)$/.test(r)) return "ask_owner";
    if (k === "site_error" || r === "network_error" || (r.startsWith("driver_error") && TRANSIENT.test(r))) return "later";
    return "manual";
}

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

/** Books a spend against today's cap (the vault's card/UPI authorizations share it). */
export function recordSpend(amount: number): void {
    spent.push({ at: Date.now(), amount });
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
    if (opts.phase === "search") task.searchInput = opts.input;
    if (opts.phase === "select") task.choice = task.options?.find((o) => o.id === (opts.input as { id?: unknown })?.id)?.label;
    const manifest = readManifest(skillPath);
    const commitKeys = new Set(manifest.commits.map(actionKey));
    const writeStatus = (): WriteStatus => (task.commit ? (task.commit.state === "confirmed" ? "applied" : "may_have_applied") : "not_attempted");
    const started = Date.now();
    let pageUrl = ""; // the last page seen
    let lastActions: SiteAction[] = []; // what the skill last asked for
    let drifted = false;
    const end = (status: Status, extra: Partial<SiteTaskResult> = {}, kind?: FailKind): SiteTaskResult => {
        task.status = status;
        if (status === "done" && task.commit) task.commit.state = "confirmed";
        saveCheckpoint(opts.checkpointDir, task);
        const retry = retryOf(status, extra.reason, writeStatus(), kind);
        drifted = isDrift(status, extra.reason, writeStatus(), kind);
        noteRun(skillPath, {
            skillHash: task.skillHash,
            phase: opts.phase,
            status,
            reason: extra.reason,
            steps: task.stepCount,
            ms: Date.now() - started,
            pagePath: pathOf(pageUrl),
            writeStatus: writeStatus(),
            drift: drifted,
        });
        return { status, task, writeStatus: writeStatus(), ...(retry && { retry }), ...extra };
    };

    if (task.commit?.state === "sent" && opts.phase === "confirm") return end("failed", { reason: "commit_unresolved" });
    if (opts.phase === "resume" && task.waitingUntil && Date.now() > task.waitingUntil) {
        return end("failed", { reason: "no_response" }); // a late code is never typed
    }

    const host = new SkillHost(skillPath);
    let result: SiteTaskResult;
    try {
        result = await drive();
    } catch (e) {
        // A page or bridge error mid-task still ends with the task's real state: after
        // the submit that is "may have been placed", never a bare error that invites
        // a second checkout.
        result = end("failed", { reason: `driver_error: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    } finally {
        host.close();
    }
    if (drifted) {
        const captured = await captureDrift(
            skillPath,
            {
                skillHash: task.skillHash,
                phase: opts.phase,
                reason: result.reason,
                input: opts.input,
                searchInput: task.searchInput,
                choice: task.choice,
                lastError: task.lastError,
                lastActions,
                pagePath: pathOf(pageUrl),
            },
            opts.driver,
        );
        if (captured) result.repairQueued = true;
    }
    return result;

    // After the site's "no": does the page say the order went through anyway?
    async function placedAnyway(page: string): Promise<boolean> {
        task.stepCount++;
        const snap = await opts.driver.snapshot();
        if (pageKey(snap.url) !== page) return true;
        try {
            return !!manifest.confirmPattern && new RegExp(manifest.confirmPattern).test(snap.text);
        } catch {
            return false;
        }
    }

    async function drive(): Promise<SiteTaskResult> {
        let verdict: CommitVerdict | undefined; // the submit's, from the driver
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
                    task.lastOutcome = undefined;
                    for (let i = 0; i < n; i++) {
                        const r = await opts.driver.act(
                            a,
                            viaConfirm ? { submit: true, domains: manifest.domains } : { commits: manifest.commits, domains: manifest.domains },
                        );
                        task.lastOutcome = r?.outcome;
                        if (viaConfirm) verdict = r?.verdict;
                    }
                    task.lastError = undefined;
                    break;
                } catch (e) {
                    const msg = String((e as Error).message ?? e);
                    if (msg.startsWith("unconsented_submit")) return end("aborted", { reason: "unconsented_submit" });
                    if (msg.startsWith("refused:")) {
                        // pick: nothing on the page fits the input, or two fit equally.
                        let available: string[] = [];
                        try {
                            available = (JSON.parse(msg.slice(8)) as unknown[]).map(String).slice(0, 50);
                        } catch {}
                        return end("refused", { refused: { field: a.field ?? "choice", available } });
                    }
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
                pageUrl = snap.url;
                if (pageKey(snap.url) !== pending.page) return end("failed", { reason: "page_changed" });
                again = await host.call("select", { snapshot: snap, input: undefined, state: task.state });
                if (!again.actions?.length) break;
                lastActions = again.actions;
                for (const a of again.actions) {
                    const stop = await exec(a);
                    if (stop) return stop;
                }
            }
            // The skill itself failed (timeout, crash): say so; nothing was sent.
            if (again.fail) return end("failed", { reason: again.fail.reason });
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
            const booked = { at: Date.now(), amount: pending.amount };
            spent.push(booked);
            saveCheckpoint(opts.checkpointDir, task);
            const stop = await exec(pending.submit, true);
            if (stop) return stop;
            // The site said no to this order in so many words: nothing was placed,
            // so the owner may say yes again — once. A second "no" keeps "sent"
            // (a site that answers no and charges anyway gets one retry, not a loop),
            // and so does a page that says otherwise: it moved on, or it shows the
            // order's confirmation (the "no" was some other request's).
            if (verdict?.verdict === "not_done" && !task.commitReverted && !(await placedAnyway(pending.page))) {
                task.commit = undefined;
                task.commitReverted = true;
                spent.splice(spent.indexOf(booked), 1);
                const why = verdict.detail ? `commit_rejected: ${verdict.detail}` : "commit_rejected";
                return end("confirm", { reason: why, confirm: { summary: pending.summary, amount: pending.amount } });
            }
            task.pendingConfirm = undefined;
            task.phase = "after_confirm";
        }

        for (;;) {
            if (task.stepCount >= MAX_STEPS) return end("aborted", { reason: "max_steps" });
            task.stepCount++;
            const snapshot = await opts.driver.snapshot();
            pageUrl = snapshot.url;
            if (snapshot.url.startsWith("chrome-error://")) return end("failed", { reason: "network_error" });
            if (!onSite(snapshot.url, manifest.domains)) {
                // The consented submit went on to the site's payment gateway: the owner pays there.
                if (task.commit?.state === "sent" && manifest.paymentDomains.length && onSite(snapshot.url, manifest.paymentDomains)) {
                    if (++task.userPrompts > MAX_USER_PROMPTS) return end("failed", { reason: "too_many_prompts" });
                    return end("needs_user", { needsUser: { kind: "payment", prompt: PAY_ON_PAGE } });
                }
                return end("aborted", { reason: "off_site" });
            }
            const r = await host.call(task.phase, {
                snapshot,
                input: opts.input,
                answer,
                state: task.state,
                lastError: task.lastError,
                lastOutcome: task.lastOutcome,
            });
            answer = undefined; // a code is typed once; a re-prompt asks again
            if (r.state) task.state = r.state;

            if (r.fail) return end("failed", { reason: r.fail.reason }, r.fail.kind);
            if (r.refused) return end("refused", { refused: r.refused });
            if (r.done) return end("done", { summary: r.done.summary });
            if (r.options) {
                task.options = r.options.map((o) => ({ id: String(o.id), label: String(o.label) }));
                return end("options", { options: r.options });
            }
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
            lastActions = r.actions;
            for (const a of r.actions) {
                const stop = await exec(a);
                if (stop) return stop;
            }
        }
    }
}
