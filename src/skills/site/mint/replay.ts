// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Offline replay: proves a Site Skill does what the recorded session did, with
// no model call, no network and no write. The real SkillHost runs the skill on
// every recorded snapshot; each action it returns is resolved, with the live
// driver's own rules (page-driver locateTarget: visible, exactly one), in the
// recorded HTML of that page, inside headless Chromium with JavaScript off and
// every request aborted. Visibility comes from the recorder's per-element
// data-bhai-hidden stamp, so the replay counts what the user could see even
// though the site's stylesheets are never fetched.
//
//   search      every action hits the element the session hit, in order (op and
//               typed value too); options contain the chosen item, and exactly
//               one option's select() clicks what the session clicked
//   select      the same, up to confirm on the review page
//   confirm     submit is the recorded commit, and so is every commit skill.json
//               lists (what the runtime's guard refuses); the amount is the payable one
//               the page shows (the rupee value labelled "to pay" / "total",
//               else the largest); select with no input on that page returns
//               the same confirm (the runtime's re-check before paying)
//   after_confirm  questions are declared and answered where the session typed
//               the answer; done quotes the site's order id (confirmPattern)
//
// An action with an expect must end on one of its outcomes in the page the
// session saw next (else expect_unmatched), and the one that holds first, in
// the skill's order, reaches the next step as lastOutcome, as at run time.
//
// Plus generalization probes: search with a different value for each input,
// from the first page and every page search acted on, must type or navigate
// with that value and never with the session's; a different option must click
// a different element; options must come from the page. A navigate must go
// where the session went, with the same query values. The commit is never
// repeated: any other action on the commit element (or, for an Enter commit,
// that Enter), or on a money-word control, fails as commit_outside_confirm.
// Pages off the traced domain are skipped. Phases the trace never reached are
// "unverified", not failures. A session that starts mid-task (the owner
// finishing by hand after a skill stopped in select) replays from that phase.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type ExpectSpec, type SiteAction, SkillHost, type StepResult } from "../host.js";
import { EXPECT_JS, lib, locateTarget, MONEY_WORDS, pickTarget } from "../page-driver.js";
import { commitEvent, type Descriptor, type LoadedTrace, loadTrace, type TraceEvent } from "./recorder.js";

export { lib };

export type PhaseName = "search" | "select" | "confirm" | "after_confirm";
export type Verdict = "pass" | "fail" | "unverified";
export interface ReplayFailure {
    phase: PhaseName;
    k: number;
    verdict: string;
    expected?: string;
    got?: string;
}
export interface ReplayReport {
    ok: boolean;
    phases: Record<PhaseName, Verdict>;
    failures: ReplayFailure[];
    warnings: string[];
    calls: number; // skill calls made
    ms: number;
}

const MAX_CALLS = 80; // the runtime allows 40 steps per task; probes add a few
const brief = (v: unknown) =>
    v === undefined ? undefined : (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 300);
const urlOf = (url: string) => {
    try {
        return new URL(url);
    } catch {
        return null;
    }
};
const pageKey = (url: string) => {
    const u = urlOf(url);
    return u ? u.origin + u.pathname : url;
};
const hostOf = (url: string) => urlOf(url)?.hostname ?? "";
// A navigate lands where the session went: the same page, and every query
// value it sets is the one the session's URL had (extra site params, such as
// a session id, may be left out).
const sameDestination = (want: string, got: string) => {
    const w = urlOf(want);
    const g = urlOf(got);
    if (!w || !g || pageKey(want) !== pageKey(got)) return false;
    for (const key of new Set(g.searchParams.keys())) {
        if (w.searchParams.getAll(key).join("\0") !== g.searchParams.getAll(key).join("\0")) return false;
    }
    return true;
};
// The values a navigate carries: its path segments and query values, decoded.
const urlValues = (url: string) => {
    const u = urlOf(url);
    if (!u) return [url];
    return [...u.pathname.split("/").map((p) => safeDecode(p)), ...u.searchParams.values()];
};
const safeDecode = (s: string) => {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
};
// Rupee amounts on a page; `payable` marks one labelled as what is to be paid
// ("To pay", "Total", "Amount payable"; not "Item total" or "Subtotal").
const MONEY = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)/gi;
const PAYABLE = /(?:\bto pay|payable|amount due|you pay|(?<!item |sub|sub-|sub )\btotal)\b[^₹\d\n]{0,20}$/i;
function amounts(text: string): Array<{ value: number; payable: boolean }> {
    return [...text.matchAll(MONEY)].map((m) => ({
        value: Number(m[1].replace(/,/g, "")),
        payable: PAYABLE.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index)),
    }));
}
/** The amount a review page asks to be paid: a labelled payable value, else the largest rupee value. */
export function payableOk(text: string, amount: number): boolean {
    const all = amounts(text);
    const labelled = all.filter((a) => a.payable).map((a) => a.value);
    if (labelled.length) return labelled.includes(amount);
    return all.length > 0 && amount === Math.max(...all.map((a) => a.value));
}

// Replay's "visible": the element itself was not stamped hidden at capture.
// biome-ignore lint/suspicious/noExplicitAny: Playwright Locator
const stampedVisible = (page: any) => (loc: any) => loc.and(page.locator(":not([data-bhai-hidden])"));

// A recorded element in a recorded page: a unique visible id / test id / data-id
// / name of the same tag first (robust to markup the parser rebuilt), then the
// nth-child path (robust to duplicate ids).
function eventSelectors(d: Descriptor): string[] {
    const q = JSON.stringify;
    const attr = (k: string, v?: string) => (v ? `${d.tag}[${k}=${q(v)}]:not([data-bhai-hidden])` : "");
    return [
        attr("id", d.id),
        attr("data-testid", d.testid),
        attr("data-id", d.dataId),
        attr("name", d.name),
        d.path,
    ].filter(Boolean);
}

/**
 * Replays the skill at `skillPath` (its skill.json beside it) against a trace
 * folder (or a loaded trace). `input` is the search input the owner gave, and
 * `answer` the code typed at a question, both as they really were (the trace
 * keeps them locally). Pass a running Chromium as `browser` to reuse it, and
 * `signal` to stop it between skill steps (it then throws "cancelled").
 */
export async function replaySkill(
    skillPath: string,
    trace: string | LoadedTrace,
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Browser
    opts: {
        input: Record<string, unknown>;
        answer?: string;
        browser?: any;
        signal?: AbortSignal;
        phase?: "search" | "select"; // where the session starts; `input` is that phase's input
    },
): Promise<ReplayReport> {
    const started = Date.now();
    const t = typeof trace === "string" ? loadTrace(trace) : trace;
    const pages = t.pages.filter((p) => !p.offsite); // never shown to a skill: the runtime fences them off
    const manifest = (() => {
        try {
            return JSON.parse(readFileSync(path.join(path.dirname(skillPath), "skill.json"), "utf8")) as {
                questions?: Array<{ id: string }>;
                confirmPattern?: string;
                commits?: SiteAction[];
            };
        } catch {
            return {};
        }
    })();
    const commit = commitEvent(t);
    const siteHosts = new Set(pages.map((p) => hostOf(p.url)));
    const phases: Record<PhaseName, Verdict> = {
        search: "unverified",
        select: "unverified",
        confirm: "unverified",
        after_confirm: "unverified",
    };
    const failures: ReplayFailure[] = [];
    const warnings: string[] = [];
    let calls = 0;

    const own = !opts.browser;
    const browser = opts.browser ?? (await (await import("playwright-core")).chromium.launch({ headless: true }));
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**", (r: { abort(): Promise<void> }) => r.abort());
    const page = await context.newPage();
    const visible = stampedVisible(page);
    const host = new SkillHost(skillPath);
    const call = (phase: string, ctx: Record<string, unknown>): Promise<StepResult> => {
        if (opts.signal?.aborted) throw new Error("cancelled"); // stops between steps
        calls++;
        return host.call(phase, ctx);
    };

    // The recorded page k, loaded once while it's the one being checked.
    let shownK = -1;
    const show = async (k: number) => {
        if (k === shownK) return;
        await page.setContent(pages[k].html, { waitUntil: "domcontentloaded" });
        shownK = k;
    };
    // biome-ignore lint/suspicious/noExplicitAny: Playwright ElementHandle
    const resolveEvent = async (e: TraceEvent): Promise<any> => {
        for (const sel of eventSelectors(e.target)) {
            const loc = page.locator(sel);
            if ((await loc.count().catch(() => 0)) === 1) return loc.elementHandle();
        }
        return null;
    };
    // The action's element is the recorded one, inside it (a span in the
    // button), or its label/control pair.
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Locator / ElementHandle
    const sameNode = (loc: any, h: any): Promise<boolean> =>
        h
            ? loc.evaluate(
                  /* javascript-obfuscator:disable */ (
                      x: Element & { control?: Element | null },
                      y: Element & { control?: Element | null },
                  ) => x === y || y.contains(x) || y.control === x || x.control === y,
                  /* javascript-obfuscator:enable */ h,
              )
            : Promise.resolve(false);

    // The cursor: k is the page the skill sees (once everything done on a page
    // is matched, the session had moved on to the next one), i the next event
    // on it. The next event may sit on a later page when the pages between saw
    // nothing done (a screenshot, a page still loading): the action is checked
    // on that page.
    let k = 0;
    let i = 0;
    const settle = () => {
        while (k < pages.length - 1 && pages[k].events.length > 0 && i >= pages[k].events.length) {
            k++;
            i = 0;
        }
    };
    const nextPos = (): { j: number; e: TraceEvent } | null => {
        if (i < pages[k].events.length) return { j: k, e: pages[k].events[i] };
        for (let j = k + 1; j < pages.length; j++) if (pages[j].events.length) return { j, e: pages[j].events[0] };
        return null;
    };
    const nextEvent = () => nextPos()?.e;
    const consume = (j: number) => {
        if (j !== k) i = 0;
        k = j;
        i++;
    };

    let label: PhaseName = opts.phase ?? "search";
    const fail = (verdict: string, expected?: unknown, got?: unknown) => {
        phases[label] = "fail";
        failures.push({ phase: label, k: pages[k]?.k ?? k, verdict, expected: brief(expected), got: brief(got) });
        return null;
    };

    // An action the live driver would refuse outside confirm: it lands on the
    // recorded commit, or on a submit-like control labelled like a payment.
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Locator
    const hitsCommit = async (loc: any): Promise<boolean> => {
        const c = commit?.event.op === "click" ? await resolveEvent(commit.event) : null;
        if (c && (await sameNode(loc, c))) return true;
        const { text, submitLike } = await loc.evaluate(
            /* javascript-obfuscator:disable */ (e: HTMLElement) => {
                const ctl = e.closest(
                    "button,a,[role=button],input[type=submit],input[type=button],input[type=image]",
                ) as HTMLElement | null;
                const h = ctl?.getAttribute("href");
                return {
                    text: ctl
                        ? [ctl.innerText, (ctl as HTMLInputElement).value, ctl.getAttribute("aria-label")].join(" ")
                        : "",
                    submitLike: !!ctl && (ctl.tagName !== "A" || !h || h === "#" || /^javascript:/i.test(h)),
                };
            },
            /* javascript-obfuscator:enable */ undefined,
        );
        return submitLike && MONEY_WORDS.test(text);
    };

    // The pages search acted on: the probes re-run them with different inputs.
    const searchKs = new Set<number>([0]);
    const valueOk = (a: SiteAction, e: TraceEvent) =>
        e.value === "{{answer}}" ? a.value === opts.answer : e.value !== null && a.value === e.value;
    const opOk = (a: SiteAction, e: TraceEvent) =>
        a.op === "click" || a.op === "pick"
            ? e.op === "click"
            : a.op === "type" || a.op === "typeCode"
              ? (e.op === "fill" || e.op === "typeCode") && valueOk(a, e)
              : a.op === "press" && e.op === "press" && e.key === (a.value ?? "Enter");

    // The outcome of `spec` that holds first on page `after` (the session's next
    // page after acting on page `before`), checked with the live driver's own
    // in-page test; a URL outcome needs the URL to have changed.
    const outcomeOf = async (spec: ExpectSpec, before: number, after: number): Promise<string | null> => {
        await show(after);
        for (const [name, o] of Object.entries(spec)) {
            if ("url" in o) {
                if (pages[after].url !== pages[before].url && new RegExp(o.url, "i").test(pages[after].url)) return name;
                continue;
            }
            const r = await page.evaluate(EXPECT_JS({ [name]: o }, false, { url: "", seen: [name] })).catch(() => null);
            if (r?.won) return name;
        }
        return null;
    };
    // The pages the last matched action was done on and led to.
    let acted: { before: number; after: number } | null = null;

    /** One action: matched (true), allowed but unverified (false), or a failure (null). */
    const matchAction = async (a: SiteAction): Promise<boolean | null> => {
        settle();
        acted = null;
        const next = nextPos();
        if (a.op === "navigate") {
            if (!siteHosts.has(hostOf(a.value ?? ""))) return fail("off_site", [...siteHosts].join(","), a.value);
            // To a page the session went to next, with nothing left to do before it.
            const stop = next ? next.j : pages.length - 1;
            const j = pages.findIndex((p, jj) => jj > k && jj <= stop && sameDestination(p.url, a.value ?? ""));
            if (j < 0 || i < pages[k].events.length)
                return fail("mismatch", next?.e.target ?? "the session did not go there", a);
            acted = { before: k, after: j };
            k = j;
            i = 0;
            return true;
        }
        if (a.op === "press" && !a.target) {
            if (next && next.e === commit?.event)
                return fail("commit_outside_confirm", "only confirm.submit may press the commit", a);
            if (!next || !opOk(a, next.e)) return fail("mismatch", next?.e ?? "nothing", a);
            consume(next.j);
            acted = { before: next.j, after: next.j + 1 };
            return true;
        }
        // Checked on the page of the next event (the same state as k when the
        // pages between saw nothing done), or on k when the session ended.
        const j = next?.j ?? k;
        await show(j);
        // biome-ignore lint/suspicious/noExplicitAny: Playwright Locator
        let loc: any;
        try {
            // pick: the choice its value ranks first among the recorded page's list.
            loc = a.op === "pick" ? await pickTarget(page, a, visible, 0) : await locateTarget(page, a.target, visible);
        } catch (err) {
            if (a.op === "waitFor" && j !== k) {
                await show(k); // waiting, on the page the skill sees, for something already there
                const here = await locateTarget(page, a.target, visible).then(Boolean, () => false);
                if (here) return false;
            }
            return fail(
                "mismatch",
                next?.e.target ?? "nothing",
                `${brief(a)} → ${String((err as Error).message).split(":")[0]}`,
            );
        }
        if (a.op === "waitFor") {
            if (j === k) return false;
            acted = { before: k, after: j };
            k = j; // what it waited for is on the next state the session saw
            i = 0;
            return true;
        }
        if (await hitsCommit(loc)) return fail("commit_outside_confirm", "only confirm.submit may press the commit", a);
        if (!next) {
            warnings.push(`unverified_extra k=${pages[j].k} ${brief(a)}`.slice(0, 200));
            return false;
        }
        const e = next.e;
        const same = await sameNode(loc, await resolveEvent(e));
        if (same && opOk(a, e)) {
            if (e === commit?.event)
                return fail("commit_outside_confirm", "only confirm.submit may press the commit", a);
            consume(j);
            acted = { before: j, after: j + 1 };
            return true;
        }
        // The right element done wrong, or one the session used later on this page: out of step.
        if (same) return fail("mismatch", e, a);
        for (const other of pages[j].events.slice(j === k ? i + 1 : 1)) {
            if (await sameNode(loc, await resolveEvent(other))) return fail("mismatch", e.target, a);
        }
        warnings.push(`unverified_extra k=${pages[j].k} ${brief(a)}`.slice(0, 200));
        return false;
    };

    // The action's outcome, as the runtime would see it: undefined when it has no
    // expect or the session has no next page to check; null after a failure.
    let lastOutcome: string | undefined;
    const expectOk = async (a: SiteAction, at: { before: number; after: number } | null): Promise<boolean> => {
        lastOutcome = undefined;
        if (!a.expect || !at || at.after >= pages.length) return true;
        const won = await outcomeOf(a.expect, at.before, at.after);
        if (!won) {
            k = at.before;
            fail("expect_unmatched", `one of ${Object.keys(a.expect).join(", ")} on the next page`, pages[at.after].url);
            return false;
        }
        lastOutcome = won;
        return true;
    };

    try {
        let phase: string = label;
        let input: unknown = opts.input;
        let answer: string | undefined;
        let state: Record<string, unknown> = {};
        for (;;) {
            if (calls >= MAX_CALLS) {
                fail("max_calls", MAX_CALLS, calls);
                break;
            }
            settle();
            const S = pages[k].snapshot;
            const callK = k;
            const atEnd = !nextPos();
            const r = await call(phase, { snapshot: S, input, answer, state, lastOutcome });
            answer = undefined;
            if (r.state) state = r.state;

            if (r.fail) {
                fail("skill_failed", "a result", r.fail.reason);
                break;
            }
            if (r.refused) {
                // The session got through with this very input: refusing it is wrong.
                fail("skill_refused", "a result", r.refused);
                break;
            }

            if (r.options) {
                if (phase !== "search") {
                    fail("wrong_phase", "options only from search", phase);
                    break;
                }
                const text = lib.fold(S.text);
                if (!r.options.some((o) => lib.fold(o.label) && text.includes(lib.fold(o.label)))) {
                    fail(
                        "constant_output",
                        "option labels shown on the page",
                        r.options.map((o) => o.label),
                    );
                    break;
                }
                for (const [field, orig] of Object.entries(opts.input)) {
                    if (typeof orig !== "string" || !orig) continue;
                    const probe = `zz-probe-${randomBytes(3).toString("hex")}`;
                    const used: string[] = []; // every value typed or navigated with
                    let usedOrigAt = 0; // the page where the session's value was used anyway
                    for (const pk of searchKs) {
                        const pr = await call("search", {
                            snapshot: pages[pk].snapshot,
                            input: { ...opts.input, [field]: probe },
                            state: {},
                        });
                        for (const a of pr.actions ?? []) {
                            if (a.op === "type" || a.op === "typeCode" || a.op === "pick") used.push(a.value ?? "");
                            else if (a.op === "navigate") used.push(...urlValues(a.value ?? ""));
                        }
                        if (!usedOrigAt && used.includes(orig)) usedOrigAt = pk;
                    }
                    if (!used.some((v) => v.includes(probe)) || used.includes(orig)) {
                        k = usedOrigAt;
                        fail("generalization", `input.${field}="${probe}" is typed or navigated with`, used);
                        break;
                    }
                }
                if (failures.length) break;
                const next = nextPos();
                if (!next) {
                    phases.search = "pass"; // the session stopped at the results: the choice can't be checked
                    break;
                }
                const e = next.e;
                await show(next.j);
                const chosen = e.op === "click" ? await resolveEvent(e) : null;
                const hits: string[] = [];
                const firstEl = async (id: string) => {
                    const s = await call("select", { snapshot: S, input: { id }, state });
                    const a = s.actions?.[0];
                    if (!a?.target || a.op !== "click") return false;
                    try {
                        return await sameNode(await locateTarget(page, a.target, visible), chosen);
                    } catch {
                        return false;
                    }
                };
                for (const o of r.options.slice(0, 50)) if (chosen && (await firstEl(o.id))) hits.push(o.id);
                if (hits.length !== 1) {
                    fail(
                        hits.length ? "options_ambiguous" : "options_missing_choice",
                        e.target,
                        hits.length ? hits : r.options.map((o) => o.id),
                    );
                    break;
                }
                phases.search = "pass";
                const other = r.options.find((o) => o.id !== hits[0]);
                label = "select";
                if (other && (await firstEl(other.id))) {
                    fail("generalization", `option ${other.id} clicks a different element`, "the recorded choice");
                    break;
                }
                phase = "select";
                input = { id: hits[0] };
                continue;
            }

            if (r.confirm) {
                if (phase !== "select") {
                    fail("wrong_phase", "confirm only from select", phase);
                    break;
                }
                phases.select = "pass";
                label = "confirm";
                if (!commit || atEnd) break; // the session never committed: confirm and after it stay unverified
                const next = nextPos();
                if (next?.e !== commit.event) {
                    fail("confirm_too_early", next?.e.target ?? "the commit", "confirm");
                    break;
                }
                await show(next.j);
                // An Enter commit is pressed on what is focused: the same key, on the
                // same field when the action names one.
                const isCommit = async (a: SiteAction): Promise<boolean> => {
                    try {
                        return commit.event.op === "press"
                            ? a.op === "press" &&
                                  (a.value ?? "Enter") === commit.event.key &&
                                  (!a.target ||
                                      (await sameNode(
                                          await locateTarget(page, a.target, visible),
                                          await resolveEvent(commit.event),
                                      )))
                            : a.op === "click" &&
                                  (await sameNode(
                                      await locateTarget(page, a.target, visible),
                                      await resolveEvent(commit.event),
                                  ));
                    } catch {
                        return false;
                    }
                };
                if (!(await isCommit(r.confirm.submit))) {
                    fail("submit_not_commit", commit.event.target, r.confirm.submit);
                    break;
                }
                // The runtime's guard refuses the manifest's commits outside confirm:
                // each must be this very control, or the guard guards something else.
                const stray = [];
                for (const c of manifest.commits ?? []) if (!(await isCommit(c))) stray.push(c);
                if (stray.length) {
                    fail("commit_target_mismatch", commit.event.target, stray);
                    break;
                }
                if (!payableOk(S.text, r.confirm.amount)) {
                    fail("amount_not_on_page", "the amount payable shown on the page", r.confirm.amount);
                    break;
                }
                const again = await call("select", { snapshot: S, input: undefined, state });
                if (JSON.stringify(again.confirm) !== JSON.stringify(r.confirm)) {
                    fail("recheck_differs", r.confirm, again);
                    break;
                }
                // Its outcome, in the page the commit led to, reaches after_confirm.
                if (!(await expectOk(r.confirm.submit, { before: next.j, after: next.j + 1 }))) break;
                phases.confirm = "pass";
                consume(next.j); // the commit happened once, in the session; it is never replayed
                label = "after_confirm";
                phase = "after_confirm";
                input = undefined;
                continue;
            }

            if (r.needsUser) {
                if (!manifest.questions?.some((q) => q.id === r.needsUser?.question)) {
                    fail("undeclared_question", "an id from skill.json questions", r.needsUser.question);
                    break;
                }
                const e = nextEvent();
                if (
                    !e ||
                    (e.op !== "fill" && e.op !== "typeCode") ||
                    !opts.answer ||
                    (e.value !== "{{answer}}" && e.value !== opts.answer)
                ) {
                    fail("question_not_answered_here", "the session typed the answer on this page", e ?? "nothing");
                    break;
                }
                answer = opts.answer;
                phase = "resume"; // as the runtime resumes
                continue;
            }

            if (r.done) {
                if (label !== "after_confirm") {
                    fail("done_too_early", "done only after the submit", phase);
                    break;
                }
                const m = manifest.confirmPattern ? new RegExp(manifest.confirmPattern).exec(r.done.summary) : null;
                if (!m || !S.text.includes(m[0])) {
                    fail("confirm_pattern", manifest.confirmPattern ?? "skill.json confirmPattern", r.done.summary);
                    break;
                }
                phases.after_confirm = "pass";
                break;
            }

            if (!r.actions?.length) {
                fail("skill_no_progress", "a result", r);
                break;
            }
            if (phase === "search") searchKs.add(callK);
            let progressed = false;
            let stopped = false;
            for (const a of r.actions) {
                const m = await matchAction(a);
                if (m === null || !(await expectOk(a, m ? acted : null))) {
                    stopped = true;
                    break;
                }
                progressed ||= m;
            }
            if (stopped) break;
            // The session ran out here: what the skill does next can't be checked.
            if (!progressed && atEnd) break;
            if (!progressed) {
                fail("no_progress", nextEvent()?.target ?? "an action the session did", r.actions);
                break;
            }
        }
    } finally {
        host.close();
        await context.close().catch(() => {});
        if (own) await browser.close().catch(() => {});
    }
    return {
        ok: failures.length === 0,
        phases,
        failures,
        warnings: warnings.slice(0, 20),
        calls,
        ms: Date.now() - started,
    };
}
