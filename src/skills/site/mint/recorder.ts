// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Records a browser session (the agent driving a site with browser tools) as a
// trace a Site Skill can be minted from and replayed against offline:
//
//   startTrace(context | page, domain)  installs RECORDER_JS on every page;
//                                       only pages on domain (or a subdomain)
//                                       record anything
//   drainTrace(page)                    after each browser tool call: takes the
//                                       events and captures the page (snapshot +
//                                       stamped HTML)
//   stopTrace(page)                     closes the trace
//
// A trace also closes by itself: when a new one starts on the same browser,
// when a browser step comes after TRACE_IDLE_MS with none (that step is not
// recorded), or after MAX_TRACE_PAGES pages. Trace folders older than 14
// days are deleted (sweepTraces, at boot and on every startTrace).
//
// On disk, data/site-mint/traces/<id>/:
//   meta.json      {id, domain, startedAt}
//   trace.jsonl    one line per captured page: {k, url, title, events} where
//                  events are what was done ON page k (the line is written when
//                  the next drain shows what happened there); a page off the
//                  domain is {k, url: its origin, offsite: true} and no files
//   pages/<k>.json the live snapshot (page-driver's SNAPSHOT_JS)
//   pages/<k>.html the DOM, each element the user could not see stamped
//                  data-bhai-hidden, form state copied into attributes, script
//                  bodies dropped (JSON data kept), password values never kept
//
// Typed values stay raw here (except known secrets: saved vault values and
// revealed codes are written as their tokens), on this machine only; anything an LLM sees is
// redacted from it first (P2). A password is recorded as null and a one-time
// code (page-driver's IS_CODE_FIELD_JS) as "{{answer}}", and neither value is
// kept in the captured HTML or snapshot. Nothing is ever written into the
// site's own storage.

import { randomBytes } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { getDataDir } from "../../../config/paths.js";
import { maskKnownValues } from "../../../security/pii-vault.js";
import { CAPTURE_JS, IS_CODE_FIELD_JS, MONEY_WORDS, SNAPSHOT_JS } from "../page-driver.js";
import type { Snapshot } from "../runtime.js";

/** What identifies an element across captures; `path` is the fallback identity. */
export interface Descriptor {
    tag: string;
    id?: string;
    name?: string;
    type?: string;
    testid?: string;
    role?: string;
    aria?: string;
    text?: string;
    dataId?: string;
    href?: string;
    path: string;
}

export interface TraceEvent {
    op: "click" | "fill" | "typeCode" | "press" | "select";
    target: Descriptor;
    value?: string | null; // fill/select; null = a password (never recorded)
    key?: string; // press
    url: string;
    consented?: boolean; // the click (or Enter) the owner said yes to: the commit
    box?: boolean; // typeCode: typed into a one-character box of a code row
}

export interface TracePage {
    k: number;
    url: string;
    title: string;
    events: TraceEvent[];
    offsite?: true; // off the traced domain: url is its origin, nothing else is kept
}

export interface LoadedTrace {
    id: string;
    dir: string;
    domain: string;
    pages: Array<TracePage & { snapshot: Snapshot; html: string }>;
}

// In the page, top frame only, once per document. Each event goes straight to
// Node through the context's __bhaiTrace binding (never into the site's own
// storage), so a click that navigates away, even to another origin, is kept
// with the page it was made on. The document first asks Node which domain is
// being traced: events made before the answer wait for it, and a document off
// that domain, or one loaded with no trace running, records nothing. Calling
// window.__bhaiRec() asks again (startTrace / stopTrace do, for open pages).
// Node coalesces typing (one fill per field, its final value); the synthetic
// click a <label> sends to its control is dropped here, so one user action is
// one event.
export const RECORDER_JS = `(() => {
  if (window.top !== window) return;
  if (window.__bhaiRec) return window.__bhaiRec();
  const rec = window.__bhaiTrace;
  if (typeof rec !== "function") return;
  try { delete window.__bhaiTrace; } catch {}
  let on = null; // null: waiting for Node's answer
  const queue = [];
  const send = (ev) => { ev.url = location.href; if (on === true) rec(ev).catch(() => {}); else if (on === null) queue.push(ev); };
  window.__bhaiRec = () => rec(null).then((domain) => {
    const h = location.hostname;
    on = !!domain && (h === domain || h.endsWith("." + domain));
    if (on) for (const ev of queue) rec(ev).catch(() => {});
    queue.length = 0;
  }, () => { on = false; queue.length = 0; });
  window.__bhaiRec();
  // Interactive roles only: a landmark (role=main, role=dialog) is not what was clicked.
  const PICK = "a,button,input,select,textarea,label,[role=button],[role=link],[role=option],[role=tab],[role=checkbox]," +
    "[role=radio],[role=menuitem],[role=switch],[role=combobox],[data-testid],[onclick]";
  const nth = (el) => { const parts = [];
    for (let e = el; e && e !== document.body && e.parentElement; e = e.parentElement)
      parts.unshift(e.tagName.toLowerCase() + ":nth-child(" + ([...e.parentElement.children].indexOf(e) + 1) + ")");
    return ["body", ...parts].join(" > "); };
  const hrefPath = (h) => { try { const u = new URL(h, location.href); return /^https?:$/.test(u.protocol) ? u.pathname + u.search : undefined; } catch { return undefined; } };
  const typing = (el) => el.tagName === "TEXTAREA" || el.isContentEditable ||
    (el.tagName === "INPUT" && !/^(checkbox|radio|submit|button|image|reset|file|range|color)$/i.test(el.type));
  // An input's own value is what was typed, never its label: read placeholder/aria/label instead.
  const label = (el) => (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
    ? el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.labels && el.labels[0] ? el.labels[0].innerText : "")
    : el.innerText || el.getAttribute("aria-label") || "") || "";
  const desc = (el) => ({ tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute("name") || undefined,
    type: el.getAttribute("type") || undefined, testid: el.getAttribute("data-testid") || undefined,
    role: el.getAttribute("role") || undefined, aria: el.getAttribute("aria-label") || undefined,
    text: label(el).replace(/\\s+/g, " ").trim().slice(0, 80) || undefined, dataId: el.getAttribute("data-id") || undefined,
    href: el.hasAttribute("href") ? hrefPath(el.getAttribute("href")) : undefined, path: nth(el) });
  const isCode = ${IS_CODE_FIELD_JS};
  let labelled = null; // the control a just-clicked <label> is about to click
  document.addEventListener("click", (e) => {
    const t = (e.target instanceof Element && (e.target.closest(PICK) || e.target)) || null;
    if (!t) return;
    if (labelled && t === labelled) { labelled = null; return; }
    labelled = t.tagName === "LABEL" ? t.control : null;
    if (typing(t) || t.tagName === "SELECT") return; // focusing a field is not an action
    send({ op: "click", target: desc(t) });
  }, true);
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !typing(t)) return;
    if (t.type === "password") return send({ op: "fill", target: desc(t), value: null });
    if (isCode(t)) return send({ op: "typeCode", target: desc(t), value: "{{answer}}", box: t.maxLength === 1 });
    send({ op: "fill", target: desc(t), value: t.isContentEditable ? t.innerText : t.value });
  }, true);
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement) send({ op: "select", target: desc(t), value: t.value });
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!["Enter", "Tab", "Escape"].includes(e.key)) return;
    const t = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.documentElement;
    send({ op: "press", key: e.key, target: desc(t) });
  }, true);
})()`;

/** A trace with no browser step for this long is over (the task ended or was abandoned). */
export const TRACE_IDLE_MS = 30 * 60_000;
/** A task is 20–40 steps; a trace this long is not one task any more. */
export const MAX_TRACE_PAGES = 200;
/** Traces hold typed values (raw, on this machine only): kept this long, then deleted. */
export const TRACE_RETENTION_MS = 14 * 24 * 60 * 60_000;

interface ActiveTrace {
    id: string;
    dir: string;
    domain: string;
    next: number;
    lastAt: number; // the last drain (or the start)
    pending?: TracePage;
    events: WeakMap<object, TraceEvent[]>; // per page, since its last drain
}
// biome-ignore lint/suspicious/noExplicitAny: Playwright BrowserContext
const active = new Map<any, ActiveTrace>(); // holds each context until its stopTrace
const armed = new WeakSet<object>(); // contexts that have the binding and RECORDER_JS
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or BrowserContext
const contextOf = (pageOrContext: any) =>
    typeof pageOrContext?.context === "function" ? pageOrContext.context() : pageOrContext;
const urlOf = (url: string) => {
    try {
        return new URL(url);
    } catch {
        return null;
    }
};
/** The traced site: `domain` itself or a subdomain of it. */
export const onDomain = (url: string, domain: string) => {
    const h = urlOf(url)?.hostname ?? "";
    return h === domain || h.endsWith(`.${domain}`);
};

export const tracesDir = () => path.join(getDataDir(), "site-mint", "traces");

/** Deletes trace folders not written to for TRACE_RETENTION_MS (never one still recording). */
export function sweepTraces(root = tracesDir(), now = Date.now()): number {
    if (!existsSync(root)) return 0;
    const live = new Set([...active.values()].map((t) => t.dir));
    let removed = 0;
    for (const id of readdirSync(root)) {
        const dir = path.join(root, id);
        try {
            const log = path.join(dir, "trace.jsonl");
            const at = statSync(existsSync(log) ? log : dir).mtimeMs;
            if (live.has(dir) || now - at < TRACE_RETENTION_MS) continue;
            rmSync(dir, { recursive: true, force: true });
            removed++;
        } catch {}
    }
    return removed;
}

/** The domain traced on `target`'s context (a Page or BrowserContext); with no target, any traced domain. */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or BrowserContext
export function tracing(target?: any): string | null {
    if (target === undefined) return active.size ? [...active.values()][0].domain : null;
    return active.get(contextOf(target))?.domain ?? null;
}

// Typing is one event per field: the next keystroke in the same field (same
// path, same page) or the next box of a one-character-box code row replaces
// the last event's value instead of adding one.
function addEvent(evs: TraceEvent[], ev: TraceEvent): void {
    const last = evs[evs.length - 1];
    if (last && last.op === ev.op && (ev.op === "fill" || ev.op === "typeCode")) {
        const same =
            ev.op === "typeCode" && ev.box ? !!last.box : last.target.path === ev.target.path && last.url === ev.url;
        if (same) {
            last.value = ev.value;
            return;
        }
    }
    evs.push(ev);
    if (evs.length > 500) evs.shift();
}

/**
 * Starts recording every page of `target`'s browser context (a Page or a
 * BrowserContext) on `domain` and its subdomains: pages opened later get
 * RECORDER_JS before their own scripts, pages already open get it now.
 * Returns the trace id and folder.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or BrowserContext
export async function startTrace(
    target: any,
    domain: string,
    opts: { root?: string } = {},
): Promise<{ id: string; dir: string }> {
    const context = contextOf(target);
    const prev = active.get(context);
    if (prev)
        await closeTrace(context, prev, contextOf(target) === target ? [] : (await takeEvents(prev, target)).events);
    sweepTraces(opts.root ?? tracesDir());
    const id = `t_${randomBytes(6).toString("hex")}`;
    const dir = path.join(opts.root ?? tracesDir(), id);
    mkdirSync(path.join(dir, "pages"), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, domain, startedAt: new Date().toISOString() }));
    active.set(context, { id, dir, domain, next: 0, lastAt: Date.now(), events: new WeakMap() });
    if (!armed.has(context)) {
        armed.add(context);
        // null asks which domain is traced (null: none); anything else is an event.
        await context.exposeBinding("__bhaiTrace", ({ page }: { page: object }, ev: TraceEvent | null) => {
            const t = active.get(context);
            if (!t || ev === null) return t?.domain ?? null;
            if (!ev?.target || typeof ev.url !== "string" || !onDomain(ev.url, t.domain)) return null;
            const evs = t.events.get(page) ?? [];
            t.events.set(page, evs);
            addEvent(evs, ev);
            return null;
        });
        await context.addInitScript(RECORDER_JS);
    }
    for (const p of context.pages?.() ?? [target]) await p.evaluate(RECORDER_JS).catch(() => {}); // about:blank etc.
    return { id, dir };
}

// The page as the user saw it right now; retried once across a navigation
// that was still committing when the tool call returned.
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function evaluateSettled<T>(page: any, js: string): Promise<T> {
    await page.waitForLoadState?.("domcontentloaded").catch(() => {});
    try {
        return await page.evaluate(js);
    } catch {
        await page.waitForLoadState?.("domcontentloaded").catch(() => {});
        return await page.evaluate(js);
    }
}

// The events `page` sent since its last drain. The round trip first means every
// event the page sent before now has reached Node.
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
async function takeEvents(t: ActiveTrace, page: any): Promise<{ url: string; events: TraceEvent[] }> {
    const url = await evaluateSettled<string>(page, "location.href").catch(() => String(page.url?.() ?? ""));
    const events = t.events.get(page) ?? [];
    t.events.delete(page);
    return { url, events };
}

// `consented` marks the commit the owner said yes to: the call's last click,
// or, when it clicked nothing, its last Enter (a form submitted from a field).
function finishPending(t: ActiveTrace, events: TraceEvent[], consented: boolean): void {
    if (!t.pending) return;
    if (consented) {
        const last = [...events].reverse();
        const commit = last.find((e) => e.op === "click") ?? last.find((e) => e.op === "press" && e.key === "Enter");
        if (commit) commit.consented = true;
    }
    t.pending.events.push(...events);
    // A saved secret or revealed code typed on the page is written as its token.
    appendFileSync(path.join(t.dir, "trace.jsonl"), `${maskKnownValues(JSON.stringify(t.pending))}\n`);
    t.pending = undefined;
}

/**
 * After a browser tool call: the events since the last call go to the page they
 * happened on, and the current page is captured as the next k. A page off the
 * traced domain is kept as a stub (its origin only, nothing of its content).
 * `consented` marks this call's commit (see finishPending).
 * Returns the new page's k, or null when this page's context isn't tracing.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
export async function drainTrace(page: any, opts: { consented?: boolean } = {}): Promise<number | null> {
    const context = contextOf(page);
    const t = active.get(context);
    if (!t) return null;
    const { url, events } = await takeEvents(t, page);
    // Back after a long pause: the task is over, and this step is not part of it.
    if (Date.now() - t.lastAt > TRACE_IDLE_MS) {
        await closeTrace(context, t, []);
        return null;
    }
    t.lastAt = Date.now();
    finishPending(t, events, !!opts.consented);
    if (t.next >= MAX_TRACE_PAGES) {
        await closeTrace(context, t, []);
        return null;
    }
    const k = t.next++;
    if (!onDomain(url, t.domain)) {
        const u = urlOf(url);
        t.pending = {
            k,
            url: u && u.origin !== "null" ? `${u.origin}/` : (u?.protocol ?? ""),
            title: "",
            events: [],
            offsite: true,
        };
        return k;
    }
    const html = await evaluateSettled<string>(page, CAPTURE_JS);
    const snapshot = await evaluateSettled<Snapshot>(page, SNAPSHOT_JS);
    writeFileSync(path.join(t.dir, "pages", `${k}.json`), maskKnownValues(JSON.stringify(snapshot)));
    writeFileSync(path.join(t.dir, "pages", `${k}.html`), maskKnownValues(html));
    t.pending = { k, url: snapshot.url, title: snapshot.title, events: [] };
    return k;
}

/**
 * Ends the trace: the last page gets whatever was done on it since, and every
 * open page stops recording (as does every page loaded later, until the next
 * startTrace). Returns the folder.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page
export async function stopTrace(page: any): Promise<string | null> {
    const context = contextOf(page);
    const t = active.get(context);
    if (!t) return null;
    await closeTrace(context, t, (await takeEvents(t, page)).events);
    return t.dir;
}

// The last page gets `events`; every open page stops recording.
// biome-ignore lint/suspicious/noExplicitAny: Playwright BrowserContext
async function closeTrace(context: any, t: ActiveTrace, events: TraceEvent[]): Promise<void> {
    finishPending(t, events, false);
    if (active.get(context) === t) active.delete(context);
    for (const p of context.pages?.() ?? []) await p.evaluate("window.__bhaiRec && window.__bhaiRec()").catch(() => {});
}

export function loadTrace(dir: string): LoadedTrace {
    const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as { id: string; domain: string };
    const lines = readFileSync(path.join(dir, "trace.jsonl"), "utf8").split("\n").filter(Boolean);
    const pages = lines.map((l) => {
        const p = JSON.parse(l) as TracePage;
        if (p.offsite) return { ...p, snapshot: { url: p.url, title: "", text: "", elements: [] }, html: "" };
        return {
            ...p,
            snapshot: JSON.parse(readFileSync(path.join(dir, "pages", `${p.k}.json`), "utf8")) as Snapshot,
            html: readFileSync(path.join(dir, "pages", `${p.k}.html`), "utf8"),
        };
    });
    return { id: meta.id, dir, domain: meta.domain, pages };
}

// A control that submits, by the rule page-driver's describeControls uses: a
// button, a submit/button/image input, a role=button, or a link that goes
// nowhere. A label, radio or checkbox is a choice ("Pay on delivery"), not a
// submit.
function submitLike(e: TraceEvent): boolean {
    const d = e.target;
    if (d.tag === "button" || d.role === "button") return d.tag !== "label";
    if (d.tag === "input") return /^(submit|button|image)$/i.test(d.type ?? "");
    if (d.tag !== "a") return false;
    const u = urlOf(e.url);
    return !d.href || (!!u && d.href === u.pathname + u.search); // href="#" or javascript:
}

// The site's own confirmation that an order or booking went through, read off
// a page's title and the top of its text: "Order placed", "Booking
// confirmed", "Order ID: NS-48213", "Thank you for your order".
export const ORDER_CONFIRMED =
    /\b(?:order|booking)\s+(?:has\s+been\s+|is\s+|was\s+)?(?:placed|confirmed|successful)\b|\b(?:order|booking)\s*(?:id|no\.?|number|#)\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{2,}|\bthank you for (?:your )?(?:order|purchase|booking)\b/i;

type CommitAt = { k: number; i: number; event: TraceEvent };

/**
 * The commit: the click (or Enter) the owner consented to; else the last click
 * on a submit-like control labelled like a payment ("Place order", "Pay now");
 * else, when the session reached the site's order confirmation, the last
 * submit-like click (or Enter) before it, skipping pages where a one-time code
 * was typed (their Verify comes after the order was placed), so a checkout
 * labelled "Confirm order" or "Buy now" is still known to place orders.
 */
export function commitEvent(trace: { pages: Array<TracePage & { snapshot?: Snapshot }> }): CommitAt | null {
    let fallback: CommitAt | null = null;
    for (const p of trace.pages) {
        for (const [i, e] of p.events.entries()) {
            if (e.consented && (e.op === "click" || e.op === "press")) return { k: p.k, i, event: e };
            if (e.op !== "click" || !submitLike(e)) continue;
            if (MONEY_WORDS.test(e.target.text ?? "") || MONEY_WORDS.test(e.target.aria ?? ""))
                fallback = { k: p.k, i, event: e };
        }
    }
    if (fallback) return fallback;
    const done = trace.pages.findIndex(
        (p) => !p.offsite && ORDER_CONFIRMED.test(`${p.title}\n${(p.snapshot?.text ?? "").slice(0, 600)}`),
    );
    for (let j = done - 1; j >= 0; j--) {
        const p = trace.pages[j];
        if (p.events.some((e) => e.op === "typeCode")) continue;
        for (let i = p.events.length - 1; i >= 0; i--) {
            const e = p.events[i];
            if (
                (e.op === "click" && (submitLike(e) || e.target.tag === "a")) ||
                (e.op === "press" && e.key === "Enter")
            )
                return { k: p.k, i, event: e };
        }
    }
    return null;
}
