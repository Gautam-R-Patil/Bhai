// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// PageDriver over a Playwright Page (or the Chrome bridge's ChromePageProxy,
// which mirrors the same subset). The snapshot is a string expression, not a
// function, so the packaged app's obfuscator can't rewrite it.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScript } from "../../config/paths.js";
import { AGENT_UI_HOST_ID, agentCursor } from "../../tools/browser/agent-cursor.js";
import {
    CONSENT_MARK,
    CONSENT_TEXT,
    IS_CODE_FIELD_JS,
    KEEP_OVERLAY_JS,
    MONEY_WORDS,
    REJECT_BUTTON_TEXT,
} from "../../tools/browser/popup-guard.js";
import type { ExpectSpec, SiteAction } from "./host.js";
import { type ActResult, type CommitVerdict, onSite, type PageDriver, type Snapshot } from "./runtime.js";

/** The helpers a skill gets as step()'s lib; pick ranks its choices with the same rank(). */
export const lib = createRequire(import.meta.url)(
    resolveScript("site-skill-lib.cjs") ??
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/site-skill-lib.cjs"),
) as {
    fold(t: unknown): string;
    price(t: unknown): number | undefined;
    rank<T>(choices: T[], wanted: unknown): { best: T | null; ambiguous: T[] };
};
// A control that spends money (outside the consented submit, pressing one is
// refused even when the manifest forgot to list it), and an input that takes
// a one-time code: shared with the popup guard, which never dismisses either.
export { IS_CODE_FIELD_JS, MONEY_WORDS };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A password's or one-time code's value never shows as element text (not to
// the skill, not in a recorded trace); its label or placeholder still does.
export const SNAPSHOT_JS = `(() => {
  const isCode = ${IS_CODE_FIELD_JS};
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  // Path only, http(s) only (no mailto:/tel: addresses), and a segment that
  // looks like a token or id (16+ chars, not a lowercase word slug) becomes ":id".
  const path = (h) => { try { const u = new URL(h, location.href); if (!/^https?:$/.test(u.protocol)) return undefined;
    return u.pathname.split("/").map((p) => p.length >= 16 && !/^[a-z]+(?:[-_][a-z0-9]+)*$/.test(p) ? ":id" : p).join("/"); } catch { return undefined; } };
  const els = [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=option],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=link],[data-testid],[data-id]")]
    .filter(visible).slice(0, 200).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.getAttribute("name") || undefined,
      type: el.getAttribute("type") || undefined,
      checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
      text: (el.innerText || (el.type === "password" || isCode(el) ? "" : el.value) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 120),
      dataId: el.getAttribute("data-id") || undefined,
      testid: el.getAttribute("data-testid") || undefined,
      role: el.getAttribute("role") || undefined,
      aria: el.getAttribute("aria-label") || undefined,
      href: el.hasAttribute("href") ? path(el.getAttribute("href")) : undefined,
      context: ((el.closest("li,tr,article,[data-item]") || {}).innerText || "").trim().slice(0, 200) || undefined,
    }));
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 4000), elements: els };
})()`;

// In the page: the DOM as the user saw it (a recorded trace page, a repair capture). Works on a deep clone, so the live
// page is never touched. Visibility is judged per element the way Playwright's
// visible filter does (checkVisibility, visibility, a non-empty box), so the
// offline replay counts exactly the elements the live driver would.
export const CAPTURE_JS = `(() => {
  const isCode = ${IS_CODE_FIELD_JS};
  const clone = document.documentElement.cloneNode(true);
  clone.querySelector("#${AGENT_UI_HOST_ID}")?.remove(); // Bhai's own cursor host is not the site
  const live = document.body ? [...document.body.querySelectorAll("*")] : [];
  const cbody = clone.querySelector("body");
  const copy = cbody ? [...cbody.querySelectorAll("*")] : [];
  const seen = (el) => { const s = getComputedStyle(el); if (s.display === "contents") return true;
    if (el.checkVisibility && !el.checkVisibility()) return false; if (s.visibility !== "visible") return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  live.forEach((el, i) => { const c = copy[i]; if (!c || c.tagName !== el.tagName) return;
    if (!seen(el)) c.setAttribute("data-bhai-hidden", "");
    if (el.tagName === "INPUT") {
      if (el.type === "password" || isCode(el)) c.removeAttribute("value"); // secrets stay out
      else if (el.type === "checkbox" || el.type === "radio") el.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked");
      else c.setAttribute("value", el.value);
    } else if (el.tagName === "TEXTAREA") c.textContent = el.value;
    else if (el.tagName === "OPTION") el.selected ? c.setAttribute("selected", "") : c.removeAttribute("selected");
  });
  for (const s of clone.querySelectorAll("script")) {
    const json = /^application\\/(ld\\+)?json$/i.test(s.type || "");
    if (!json || s.textContent.length > 200000) s.textContent = "";
    s.removeAttribute("src");
  }
  return clone.outerHTML.slice(0, 2000000);
})()`;

// A one-time code into the field the skill names. When that field opens a row
// of one-character boxes, each box takes one character; otherwise the whole
// code goes into the field. A row whose length differs from the code's gets
// nothing. Each value is set through the input's own setter and announced with
// input/change events (what UI frameworks listen for), then read back.
const TYPE_CODE_JS = (sel: string, code: string) => `(() => {
  const code = ${JSON.stringify(code)};
  const field = document.querySelector(${JSON.stringify(sel || 'input[autocomplete="one-time-code"]')});
  if (!field) return "not_found";
  const usable = (i) => i.tagName === "INPUT" && /^(|text|tel|number|password)$/i.test(i.getAttribute("type") || "")
    && !i.disabled && !i.readOnly && i.getBoundingClientRect().width > 0;
  if (!usable(field)) return "not_editable";
  if (field.maxLength !== 1) return "single";
  const row = [...(field.closest("form") || field.getRootNode()).querySelectorAll('input[maxlength="1"]')].filter(usable);
  if (row[0] !== field) return "not_first_box";
  if (row.length !== code.length) return "count_mismatch:" + row.length + "_boxes";
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  for (let n = 0; n < row.length; n++) {
    row[n].focus();
    setValue.call(row[n], code.charAt(n));
    for (const type of ["input", "change"]) row[n].dispatchEvent(new Event(type, { bubbles: true }));
  }
  return row.every((box, n) => box.value === code.charAt(n)) ? "ok" : "readback_failed";
})()`;

const norm = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// ── pick ──────────────────────────────────────
// In the page: the labels of the visible elements `sel` matches (a recorded
// page's data-bhai-hidden counts as hidden). With `stamp`, the one at that
// index is marked for a locator, if its label is still the one ranked (a
// typeahead may have re-rendered in between).
const PICK_JS = (sel: string, stamp?: { i: number; label: string; token: string }) => `(() => {
  const visible = (el) => { if (el.closest("[data-bhai-hidden]")) return false; const r = el.getBoundingClientRect();
    const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  let els;
  try { els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(visible); } catch { return null; }
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 200);
  const stamp = ${JSON.stringify(stamp ?? null)};
  if (!stamp) return els.slice(0, 50).map(label);
  const el = els[stamp.i];
  if (!el || label(el) !== stamp.label) return false;
  el.setAttribute("data-bhai-pick", stamp.token);
  return true;
})()`;

/**
 * The one choice, among the visible matches of `a.target.sel`, whose label fits
 * `a.value` (lib.rank: the same text, then the same words, then every word; a
 * tie is never broken). Waits up to `timeout` for the list (a typeahead renders
 * after typing). No list → not_found; none fits, or several fit equally →
 * `refused:` with what the page offers (the tied ones, else every choice).
 * `visible` as in locateTarget (offline replay passes its own).
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
export async function pickTarget(page: any, a: SiteAction, visible: (loc: any) => any = shown, timeout = 5000) {
    const sel = a.target?.sel ?? "";
    const until = Date.now() + timeout;
    let labels: string[] | null;
    for (;;) {
        labels = (await page.evaluate(PICK_JS(sel))) as string[] | null;
        if (!labels || labels.length || Date.now() > until) break;
        await sleep(100); // poll
    }
    if (!labels?.length) throw new Error(`not_found: ${JSON.stringify(a.target)}`);
    const choices = labels.map((label, i) => ({ label, i }));
    const { best, ambiguous } = lib.rank(choices, a.value);
    if (!best)
        throw new Error(`refused: ${JSON.stringify((ambiguous.length ? ambiguous : choices).map((c) => c.label))}`);
    const token = randomBytes(6).toString("hex");
    if (!(await page.evaluate(PICK_JS(sel, { ...best, token }))))
        throw new Error("pick: the list changed while choosing");
    return locateTarget(page, { sel: `[data-bhai-pick="${token}"]` }, visible);
}

// ── expect: the outcome race ──────────────────
// In the page. Armed before the action: marks what already shows (so a stale
// copy never wins) and the live regions' text, and returns the URL and the
// `gone` targets showing. Checked after: the first outcome, in the skill's
// order, that holds now — an element that wasn't showing at arm time, a target
// that was seen (at arm time or since) and is gone, a new URL that matches, a
// live region that is new or changed and matches — plus a count of DOM
// changes (progress: added/removed nodes and text, not attributes; a node that
// keeps changing, a countdown or a carousel, stops counting after 3). A
// navigation starts a fresh count ("fresh"); `seen` carries the gone targets
// seen across it.
// ponytail: text-only targets match within one text node; give sel for text
// split across tags.
export const EXPECT_JS = (spec: ExpectSpec, arm: boolean, pre: { url: string; seen: string[] }) => `(() => {
  const spec = ${JSON.stringify(spec)}, arm = ${arm}, pre = ${JSON.stringify(pre)};
  const visible = (el) => { if (el.closest("[data-bhai-hidden]")) return false; const r = el.getBoundingClientRect();
    const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const norm = (t) => (t || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const find = (t) => {
    let els = [];
    if (t.sel) { try { els = [...document.querySelectorAll(t.sel)]; } catch { return []; } }
    if (t.text) {
      const want = norm(t.text);
      if (t.sel) els = els.filter((el) => norm(el.innerText).includes(want));
      else { const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode()); ) if (n.parentElement && norm(n.nodeValue).includes(want)) els.push(n.parentElement); }
    }
    return els.filter(visible);
  };
  const REGIONS = '[aria-live]:not([aria-live="off"]),[role=alert],[role=status]';
  const gones = Object.entries(spec).filter(([, o]) => o.gone);
  let st = window.__bhaiExpect, fresh = false;
  if (arm || !st) {
    if (st) st.obs.disconnect();
    st = window.__bhaiExpect = { mut: 0, hits: new Set(), counts: new WeakMap() };
    st.obs = new MutationObserver((list) => {
      for (const r of list) {
        if (r.type === "attributes") continue;
        const n = (st.counts.get(r.target) || 0) + 1;
        st.counts.set(r.target, n);
        if (n <= 3) st.mut++;
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        const region = el && el.closest(REGIONS);
        if (region) region.__bhaiTouched = true;
      }
      for (const [name, o] of gones) if (!st.hits.has(name) && find(o.gone).length) st.hits.add(name);
    });
    st.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    fresh = !arm;
  }
  if (arm) {
    for (const o of Object.values(spec)) if (o.sel || o.text) for (const el of find(o)) el.__bhaiSeen = true;
    for (const el of document.querySelectorAll(REGIONS)) { el.__bhaiSaid = visible(el) ? el.innerText : undefined; el.__bhaiTouched = false; }
    return { url: location.href, seen: gones.filter(([, o]) => find(o.gone).length).map(([n]) => n) };
  }
  const seen = gones.filter(([n, o]) => pre.seen.includes(n) || st.hits.has(n) || find(o.gone).length).map(([n]) => n);
  const said = (re) => [...document.querySelectorAll(REGIONS)].some((el) => visible(el)
    && (el.__bhaiSaid === undefined || el.__bhaiSaid !== el.innerText || el.__bhaiTouched) && re.test(el.innerText));
  for (const [name, o] of Object.entries(spec)) {
    if (o.gone ? seen.includes(name) && !find(o.gone).length
      : o.url !== undefined ? location.href !== pre.url && new RegExp(o.url, "i").test(location.href)
      : o.announced !== undefined ? said(new RegExp(o.announced, "i"))
      : find(o).some((el) => !el.__bhaiSeen)) return { won: name, mut: st.mut, fresh, seen };
  }
  return { won: null, mut: st.mut, fresh, seen };
})()`;
// No outcome after this long without progress (no DOM change, no request to
// the skill's sites in flight — for its first REQUEST_PROGRESS_MS only: a
// long-poll or an event stream is not progress), or after the cap whatever
// happens, is a failed step the skill sees.
const REQUEST_PROGRESS_MS = 5000;
const expectIdleMs = () => Number(process.env.BHAI_SITE_EXPECT_IDLE_MS ?? 8000);
const expectCapMs = () => Number(process.env.BHAI_SITE_EXPECT_CAP_MS ?? 30_000);

// ── The submit's verdict ──────────────────────
const UNCLEAR: CommitVerdict = { verdict: "unclear" };
const FAILED = /^(error|errored|fail|failed|failure|declined|rejected|denied|invalid|cancell?ed|unavailable)$/i;
const SUCCEEDED =
    /^(ok|success|succeeded|successful|confirmed|placed|created|accepted|paid|booked|complete|completed)$/i;
const ORDER_ID =
    /^(order_?id|order_?no|order_?number|booking_?id|booking_?ref(erence)?|pnr|confirmation_?(id|no|number|code))$/i;
// A key that holds an order (order, orderDetails, booking, reservation, …).
const ORDERISH = /order|booking|reservation|pnr|confirmation/i;
// "already placed" is not a refusal: an order exists.
const EXISTS = /duplicate|already (been )?(placed|exists|submitted|booked|paid)/i;
// A value that says something: not empty, and not a "no error" code (0, "0", {}).
const filled = (v: unknown): boolean =>
    v !== undefined &&
    v !== null &&
    v !== false &&
    v !== "" &&
    v !== 0 &&
    v !== "0" &&
    !(Array.isArray(v) && !v.length) &&
    !(typeof v === "object" && !Array.isArray(v) && !Object.values(v as object).some(filled));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const message = (v: unknown): string =>
    typeof v === "string"
        ? v
        : Array.isArray(v)
          ? message(v[0])
          : v && typeof v === "object"
            ? message((v as Record<string, unknown>).message ?? (v as Record<string, unknown>).error)
            : "";

/**
 * What the site answered to the submit's write request (POST/PUT/… of the
 * page, a fetch or an XHR), from the status and a JSON body only:
 *   not_done  it says the order failed: ok/success false, a failed status, or
 *             errors (not a "no error" 0 / {}), with no sign of an order (no
 *             order id, no order/booking field with anything in it) — on a 2xx
 *             or a 4xx;
 *   done      a 2xx that says it worked (ok/success true, a done status, an
 *             order id) with no error;
 *   unclear   everything else: a 5xx (it may have run halfway), a redirect
 *             (the next page tells), HTML, both signs, or "already placed".
 * Only not_done changes anything (the runtime may revert the "sent" mark once),
 * so every doubt reads unclear.
 */
export function judgeCommit(status: number, contentType: string, body: string): CommitVerdict {
    if (!(status >= 200 && status < 300) && !(status >= 400 && status < 500)) return UNCLEAR;
    let j: unknown;
    if (/json/i.test(contentType) || /^\s*\{/.test(body)) {
        try {
            j = JSON.parse(body);
        } catch {}
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) return UNCLEAR;
    const o = j as Record<string, unknown>;
    const levels = [o, ...(["data", "result"] as const).map((k) => o[k]).filter(isObj)];
    let failed = false;
    let worked = false;
    let order = false; // any sign an order exists, even beside an error
    for (const l of levels) {
        const state = [l.status, l.state, l.result].find((v) => typeof v === "string") as string | undefined;
        failed ||=
            l.ok === false || l.success === false || FAILED.test(state ?? "") || filled(l.error) || filled(l.errors);
        worked ||=
            l.ok === true ||
            l.success === true ||
            SUCCEEDED.test(state ?? "") ||
            Object.keys(l).some((k) => ORDER_ID.test(k) && filled(l[k]));
        order ||= Object.entries(l).some(([k, v]) => ORDERISH.test(k) && filled(v));
    }
    const detail =
        message(o.message ?? o.error ?? o.errors ?? levels.map((l) => l.message ?? l.error).find(Boolean)).slice(
            0,
            100,
        ) || undefined;
    if (failed && !worked && !order && !EXISTS.test(JSON.stringify(o))) return { verdict: "not_done", detail };
    if (worked && !failed && status < 300) return { verdict: "done" };
    return UNCLEAR;
}

// How long the submit's writes must be quiet before its verdict is read.
const WRITE_QUIET_MS = 1000;
/** Several write requests: not_done only when every one said so, done when one did and none failed. */
const combine = (vs: CommitVerdict[]): CommitVerdict =>
    vs.length && vs.every((v) => v.verdict === "not_done")
        ? vs[0]
        : vs.some((v) => v.verdict === "done") && !vs.some((v) => v.verdict === "not_done")
          ? { verdict: "done" }
          : UNCLEAR;

export type Control = { labels: string[]; submitLike: boolean };
// In the page: the controls an action on `el` (default: the focused element)
// would press — its own control, or with `form` (Enter) every control of the
// form it would submit. Nothing is focused (body) → none. A link that goes
// somewhere is navigation, not a submit; labels, radios and checkboxes are not
// controls here ("Pay on delivery" is a choice, not a payment).
export const describeControls = /* javascript-obfuscator:disable */ (el: Element | null, form: boolean): Control[] => {
    const e = el || document.activeElement;
    if (!e || e === document.body || e === document.documentElement) return [];
    const CONTROL = "button,a,[role=button],input[type=submit],input[type=button],input[type=image]";
    const scope = form ? (e as HTMLInputElement).form || e.closest("form") : null;
    const own = e.closest(CONTROL);
    const list = scope ? [...scope.querySelectorAll(CONTROL)] : own ? [own] : [];
    return list.map((c) => {
        const h = c.getAttribute("href");
        return {
            labels: [(c as HTMLElement).innerText, (c as HTMLInputElement).value, c.getAttribute("aria-label")].filter(
                (x): x is string => !!x,
            ),
            submitLike: c.tagName !== "A" || !h || h === "#" || /^javascript:/i.test(h),
        };
    });
} /* javascript-obfuscator:enable */;

// Why these controls are a commit, or "": a control labelled exactly as a
// declared commit is that commit (a header and footer copy of "Confirm
// booking"), and a submit-like control with a money word is one too.
export const judge = (controls: Control[], commits: SiteAction[]): string => {
    const texts = commits.map((c) => norm(c.target?.text)).filter(Boolean);
    for (const c of controls) {
        for (const l of c.labels.map(norm)) {
            if (texts.includes(l)) return `commit "${l.slice(0, 60)}"`;
            if (c.submitLike && MONEY_WORDS.test(l)) return `money-word control "${l.slice(0, 60)}"`;
        }
    }
    return "";
};
// Keys that press the focused control; Enter also submits its form.
const PRESSES = /^(Enter|NumpadEnter|Space| )$/;

// ── unblock: an overlay over the target ───────
// In the page: does the target (stamped data-bhai-target) get its own centre's
// click? If not, the overlay on top (the outermost positioned or dialog
// ancestor of what is hit) and what may be done about it:
//   keep    never touched: it holds the target or a commit, or KEEP_OVERLAY_JS
//           says so (a frame, a password / card / code input, a money word, a price);
//   click   a cookie banner's reject (never its accept), else a close control,
//           stamped data-bhai-unblock=`mark`;
//   escape  no such control, but it says something;
//   wait    an empty shield.
const CLOSE_WORDS = /^(×|✕|✖|close|dismiss|no,? thanks|not now|maybe later|skip|later)$/i;
const UNBLOCK_JS = (token: string, mark: string, commits: SiteAction[]) => `(() => {
  const keep = ${KEEP_OVERLAY_JS}, mark = ${JSON.stringify(mark)};
  const texts = ${JSON.stringify(commits.map((c) => norm(c.target?.text)).filter(Boolean))};
  const sels = ${JSON.stringify(commits.flatMap((c) => (c.target?.sel ? [c.target.sel] : [])))};
  const rejects = ${JSON.stringify(REJECT_BUTTON_TEXT.map(norm))};
  const t = document.querySelector('[data-bhai-target="${token}"]');
  const said = (o) => (o.innerText || "").replace(/\\s+/g, " ").trim();
  const out = (state, o) => ({ state, url: location.href, text: o ? said(o).slice(0, 80) : "" });
  if (!t) return out("clear");
  t.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = t.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || hit === t || t.contains(hit) || hit.contains(t)) return out("clear");
  let o = null;
  for (let n = hit; n && n !== document.body && n !== document.documentElement; n = n.parentElement)
    if (/^(fixed|absolute|sticky)$/.test(getComputedStyle(n).position) || /^(dialog|alertdialog)$/.test(n.getAttribute("role") || "")
      || n.getAttribute("aria-modal") === "true") o = n;
  if (!o) return out("clear");
  const label = (c) => [c.innerText, c.value, c.getAttribute("aria-label")].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
  const controls = [...o.querySelectorAll("button,a,[role=button],input[type=submit],input[type=button]")]
    .filter((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  const commit = controls.some((c) => texts.includes(label(c).toLowerCase()))
    || sels.some((s) => { try { return o.matches(s) || !!o.querySelector(s); } catch { return false; } });
  if (o.contains(t) || commit || keep(o)) return out("keep", o);
  const consent = (c) => { for (let n = c.parentElement, i = 0; i < 6 && n; i++, n = n.parentElement) {
    if (new RegExp(${JSON.stringify(CONSENT_MARK.source)}, "i").test(n.id + " " + (typeof n.className === "string" ? n.className : "") + " " + (n.getAttribute("aria-label") || ""))) return true;
    if (said(n).length < 600 && new RegExp(${JSON.stringify(CONSENT_TEXT.source)}, "i").test(said(n))) return true; } return false; };
  const close = controls.find((c) => rejects.includes(label(c).toLowerCase()) && consent(c))
    || controls.find((c) => new RegExp(${JSON.stringify(CLOSE_WORDS.source)}, "i").test(label(c))
      || /^(close|dismiss)\\b/i.test(c.getAttribute("aria-label") || "") || c.matches("[data-dismiss],[data-close]"));
  if (close) { close.setAttribute("data-bhai-unblock", mark); return out("click", o); }
  return out(said(o) ? "escape" : "wait", o);
})()`;
const UNBLOCK_TRIES = 2; // dismissals per action: a popup that keeps coming back can slow a run, never loop it

// Only what the user can see counts: a hidden mobile copy of a button is not a
// second match. (The Chrome bridge proxy has no filter().)
// biome-ignore lint/suspicious/noExplicitAny: Playwright Locator or ChromeLocatorProxy
const shown = (loc: any) => (typeof loc.filter === "function" ? loc.filter({ visible: true }) : loc);

/**
 * Exactly one element, or no action: the selector first, then the visible text
 * when the selector no longer matches (a site renamed its ids). Two matches
 * means we don't know which one the skill meant. `visible` narrows a locator to
 * what the user saw (offline replay passes its own, from the recorded page).
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
export async function locateTarget(page: any, target: SiteAction["target"], visible: (loc: any) => any = shown) {
    const bySel = target?.sel ? visible(page.locator(target.sel)) : null;
    const byText = target?.text ? visible(page.getByText(target.text, { exact: false })) : null;
    for (const loc of [bySel, byText]) {
        if (!loc) continue;
        if (typeof loc.count !== "function") return loc.first(); // Chrome bridge proxy: no count()
        const n = await loc.count();
        if (n > 1) throw new Error(`ambiguous_target: ${n} elements match ${JSON.stringify(target)}`);
        if (n === 1) return loc;
    }
    throw new Error(`not_found: ${JSON.stringify(target)}`);
}

/**
 * `reopen` (optional) gives a fresh page when the user closed the tab: the
 * driver opens the last URL there and carries on. `signal` (the owner's Stop)
 * ends the driver's own waits, and no click, key or typing outside the
 * consented submit is dispatched after it.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
export function pageDriver(
    initial: any,
    timeout = 5000,
    reopen?: () => Promise<any>,
    signal?: AbortSignal,
): PageDriver {
    let page = initial;
    // A wait Stop cuts short (throws "stopped").
    const nap = (ms: number) =>
        new Promise<void>((res, rej) => {
            if (signal?.aborted) return rej(new Error("stopped"));
            const stop = () => {
                clearTimeout(t);
                rej(new Error("stopped"));
            };
            const t = setTimeout(() => {
                signal?.removeEventListener("abort", stop);
                res();
            }, ms);
            signal?.addEventListener("abort", stop, { once: true });
        });
    let lastUrl = "";
    let lastWasSubmit = false;
    let submitted = false; // this driver ran the consented submit
    // One dialog handler per page, for its whole life (shared by every driver
    // on that page, so its state lives on the page): "Leave site?" is always
    // accepted (dismissing it cancels the navigation the skill asked for); ONE
    // native confirm ("Place order for ₹249?") is accepted only inside the
    // consented submit; every other dialog is dismissed.
    const watchDialogs = (p: any) => {
        if (typeof p?.on !== "function" || p.__bhaiDialogs) return;
        p.__bhaiDialogs = true;
        p.on("dialog", (d: { type(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => {
            const t = d.type();
            const ok = t === "beforeunload" || (t === "confirm" && p.__bhaiSubmitWindow && p.__bhaiConfirmLeft-- > 0);
            (ok ? d.accept() : d.dismiss()).catch(() => {}); // already handled by the popup guard: fine
        });
    };
    watchDialogs(page);
    const closed = (e: unknown) =>
        /Target (page, context or browser )?(has been )?closed|Target closed|page has been closed/i.test(
            String((e as Error)?.message ?? e),
        );
    const revive = async () => {
        if (!reopen) return false;
        page = await reopen();
        watchDialogs(page);
        // Never after the submit: the order may exist, and a GET could replay a
        // one-time checkout step. The runtime reads the blank page as off the site.
        if (lastUrl && !submitted) await page.goto(lastUrl, { waitUntil: "domcontentloaded" });
        return true;
    };
    const locate = (a: SiteAction) => locateTarget(page, a.target);
    const refuse = (why: string) => new Error(`unconsented_submit: ${why}`);
    // The commit guard, outside the consented submit, on an element handle: the
    // action is refused when it lands on a declared commit (the same node, inside
    // it, or around it, however the skill reached it; with `form`, anywhere in
    // the form Enter would submit) or on a control judge() calls a commit.
    // biome-ignore lint/suspicious/noExplicitAny: Playwright ElementHandle
    const guardCommit = async (el: any, commits: SiteAction[], form = false) => {
        const why = judge(await el.evaluate(describeControls, form), commits);
        if (why) throw refuse(why);
        for (const c of commits) {
            if (!c.target?.sel) continue; // a text-only commit is matched by its label above
            // Every match counts, hidden ones too: an ambiguous commit is still a commit.
            const hit = await page
                .locator(c.target.sel)
                .evaluateAll(
                    /* javascript-obfuscator:disable */ (els: Element[], [el, form]: [Element, boolean]) => {
                        const s = (form && ((el as HTMLInputElement).form || el.closest("form"))) || el;
                        return els.some((x) => x === s || x.contains(s) || s.contains(x));
                    },
                    /* javascript-obfuscator:enable */ [el, form],
                )
                .catch(() => false); // a bad selector matches nothing
            if (hit) throw refuse(JSON.stringify(c.target));
        }
    };
    // The Chrome bridge proxy has no node handles, so there a commit is known by
    // its selector or its label only (and checkout itself is refused upstream).
    // biome-ignore lint/suspicious/noExplicitAny: ChromeLocatorProxy
    const guardByLabel = async (loc: any, a: SiteAction, commits: SiteAction[]) => {
        if (a.target?.sel && commits.some((c) => c.target?.sel === a.target?.sel))
            throw refuse(JSON.stringify(a.target));
        const text: string = await loc.innerText?.().catch(() => "");
        const why = judge([{ labels: [text ?? "", a.target?.text ?? ""], submitLike: true }], commits);
        if (why) throw refuse(why);
    };
    // Enter or Space presses whatever is focused, and Enter submits its form.
    const guardKey = async (key: string, commits: SiteAction[]) => {
        const form = key !== " " && key !== "Space";
        if (typeof page.evaluateHandle !== "function") {
            const why = judge((await page.evaluate(describeControls, null, form)) ?? [], commits); // Chrome proxy
            if (why) throw refuse(why);
            return;
        }
        const h = await page.evaluateHandle("document.activeElement");
        try {
            const none = await h.evaluate(
                /* javascript-obfuscator:disable */ (e: Element | null) =>
                    !e || e === document.body || e === document.documentElement,
                /* javascript-obfuscator:enable */ undefined,
            );
            if (!none) await guardCommit(h, commits, form);
        } finally {
            await h.dispose().catch(() => {});
        }
    };
    const driver: PageDriver = {
        async snapshot(): Promise<Snapshot> {
            if (page.isClosed?.()) await revive();
            const read = async (): Promise<Snapshot> => {
                try {
                    return await page.evaluate(SNAPSHOT_JS);
                } catch (e) {
                    if (closed(e) && (await revive())) return await page.evaluate(SNAPSHOT_JS);
                    // A click that navigated: wait for the new document, then read it.
                    await page.waitForLoadState?.("domcontentloaded").catch(() => {});
                    return await page.evaluate(SNAPSHOT_JS);
                }
            };
            let snap = await read();
            // Chrome's own error page (network dropped mid-navigation): wait it out
            // and reload — except right after a submit, where a reload could post
            // the order again; the runtime reports that one as a network error.
            for (let i = 0; i < 5 && !lastWasSubmit && snap.url.startsWith("chrome-error://"); i++) {
                await nap(1000 * 2 ** i);
                await page.reload?.({ waitUntil: "domcontentloaded" }).catch(() => {});
                snap = await read();
            }
            if (!snap.url.startsWith("chrome-error://")) lastUrl = snap.url;
            return snap;
        },
        html: () => page.evaluate(CAPTURE_JS) as Promise<string>,
        // Clears an overlay over `a`'s target before the consented submit (the runtime calls it
        // before re-reading the total). A target it can't find is left to that re-read.
        async unblock(a, opts) {
            const loc = await locate(a).catch(() => null);
            return loc ? unblock(loc, opts.commits, opts.domains) : false;
        },
        // A page that can't say (closed, the Chrome bridge) counts as online: the click goes as before.
        online: async () => (await page.evaluate("navigator.onLine").catch(() => true)) !== false,
        async act(
            a: SiteAction,
            opts?: { submit?: boolean; commits?: SiteAction[]; domains?: string[] },
        ): Promise<ActResult> {
            if (page.isClosed?.()) await revive();
            lastWasSubmit = !!opts?.submit;
            submitted ||= lastWasSubmit;
            const p = page;
            if (opts?.submit) {
                p.__bhaiConfirmLeft = 1;
                p.__bhaiSubmitWindow = true;
            }
            const writes = opts?.submit ? watchWrites(p, opts.domains) : null;
            try {
                const run = () => doAct(a, opts?.submit ? null : (opts?.commits ?? []), opts?.domains);
                let outcome: string | undefined;
                if (a.expect) outcome = await race(p, a.expect, run, opts?.domains);
                else await run();
                return { outcome, verdict: await writes?.verdict() };
            } finally {
                writes?.stop();
                if (opts?.submit) {
                    p.__bhaiConfirmLeft = 0;
                    p.__bhaiSubmitWindow = false;
                }
            }
        },
    };
    return driver;

    /**
     * Runs the action, then waits for the first outcome of `spec` to hold. The
     * wait ends at the outcome (no fixed sleep); without one it fails after
     * expectIdleMs with no progress (DOM changes, requests to `domains` in
     * flight) or at the cap, as `no_outcome`, which the skill sees as lastError.
     */
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
    async function race(p: any, spec: ExpectSpec, run: () => Promise<void>, domains?: string[]): Promise<string> {
        // When each request in flight started (the Chrome bridge proxy has no request events: DOM progress only).
        const inflight = new Map<unknown, number>();
        const net = typeof p.on === "function" && typeof p.off === "function";
        const up = (req: { url(): string }) => onSite(req.url(), domains) && inflight.set(req, Date.now());
        const down = (req: unknown) => inflight.delete(req);
        if (net) {
            p.on("request", up);
            p.on("requestfinished", down);
            p.on("requestfailed", down);
        }
        try {
            const pre = await p.evaluate(EXPECT_JS(spec, true, { url: "", seen: [] }));
            const seen = new Set<string>(pre.seen); // gone targets seen, across navigations
            await run();
            const start = Date.now();
            let quiet = start;
            let mut = -1;
            for (;;) {
                // Throws mid-navigation: that is progress.
                const r = await p.evaluate(EXPECT_JS(spec, false, { url: pre.url, seen: [...seen] })).catch(() => null);
                if (r?.won) return r.won as string;
                for (const n of r?.seen ?? []) seen.add(n);
                const now = Date.now();
                const busy = [...inflight.values()].some((t) => now - t < REQUEST_PROGRESS_MS);
                if (!r || r.fresh || r.mut !== mut || busy) quiet = now;
                if (r) mut = r.mut;
                if (now - quiet >= expectIdleMs() || now - start >= expectCapMs()) {
                    throw new Error(`no_outcome: none of ${Object.keys(spec).join(", ")} after ${now - start}ms`);
                }
                await nap(100); // poll
            }
        } finally {
            if (net) {
                p.off("request", up);
                p.off("requestfinished", down);
                p.off("requestfailed", down);
            }
        }
    }

    /**
     * The submit's write requests to the skill's sites and what the site
     * answered to them (judgeCommit). A checkout may send a validation, CSRF
     * or tracking call before the order itself, so after the action it listens
     * on until WRITE_QUIET_MS pass with no new write and every answer is in —
     * or until one answer isn't a "no", after which the verdict can't be
     * not_done any more.
     */
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Page
    function watchWrites(p: any, domains?: string[]) {
        if (typeof p.on !== "function" || typeof p.off !== "function") return null;
        const answers: Array<{ v?: CommitVerdict }> = [];
        let last = Date.now();
        // biome-ignore lint/suspicious/noExplicitAny: Playwright Request / Response
        const onRequest = (req: any) => {
            if (
                /^(GET|HEAD|OPTIONS)$/i.test(req.method()) ||
                !["document", "fetch", "xhr"].includes(req.resourceType())
            )
                return;
            if (!onSite(req.url(), domains)) return; // analytics, a payment SDK: not the site's answer
            last = Date.now();
            const a: { v?: CommitVerdict } = {};
            answers.push(a);
            req.response()
                .then(
                    async (res: any) => {
                        if (!res) return UNCLEAR;
                        const type: string = res.headers()["content-type"] ?? "";
                        const body = /json|text\/plain/i.test(type) || !type ? await res.text().catch(() => "") : "";
                        return judgeCommit(res.status(), type, body);
                    },
                    () => UNCLEAR,
                )
                .then((v: CommitVerdict) => (a.v = v));
        };
        p.on("request", onRequest);
        const stop = () => p.off("request", onRequest);
        return {
            stop,
            async verdict(): Promise<CommitVerdict> {
                const from = Date.now();
                for (;;) {
                    const got = answers.flatMap((a) => (a.v ? [a.v] : []));
                    if (got.some((v) => v.verdict !== "not_done")) break;
                    const now = Date.now();
                    if (got.length === answers.length && now - Math.max(last, from) >= WRITE_QUIET_MS) break;
                    if (now - from >= 10_000) break;
                    await nap(50); // poll
                }
                stop();
                if (!answers.length || answers.some((a) => !a.v)) return UNCLEAR;
                return combine(answers.map((a) => a.v as CommitVerdict));
            },
        };
    }
    // A click outside the consented submit, through the commit guard; `go` is the last Stop check.
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Locator or ChromeLocatorProxy
    async function guardedClick(loc: any, a: SiteAction, commits: SiteAction[], go: () => void) {
        if (typeof loc.elementHandle !== "function") {
            await guardByLabel(loc, a, commits);
            go();
            await loc.click({ timeout });
            return;
        }
        // Wait until it's clickable first (a disabled "Continue" may become
        // "Place order"), then check and click that same node.
        // ponytail: a relabel in the ms between the check and the click
        // still slips by; a click-time in-page listener would close it.
        await loc.click({ timeout, trial: true });
        const h = await loc.elementHandle({ timeout });
        try {
            await guardCommit(h, commits);
            go();
            await h.click({ timeout });
        } finally {
            await h.dispose().catch(() => {});
        }
    }

    /**
     * Outside the consented submit only: an overlay over the target (a rate-us
     * or newsletter popup, a cookie banner, an announcement) is dismissed — at
     * most UNBLOCK_TRIES times per action, each click through the commit guard,
     * a banner rejected and never accepted — and a self-removing shield is
     * waited out (up to `timeout`). An overlay that must not be touched, or one
     * that stays, ends the action with `blocked_by_overlay` before anything
     * reaches the target. True when something was dismissed.
     * ponytail: over the bridge, a popup that opens between this check and the
     * click_at still takes the click (checkout itself is refused there).
     */
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Locator or ChromeLocatorProxy
    async function unblock(loc: any, commits: SiteAction[], domains?: string[]): Promise<boolean> {
        const go = () => {
            if (signal?.aborted) throw new Error("stopped");
        };
        const token = randomBytes(6).toString("hex");
        // A locator that can't mark its element (a bare proxy) is not checked: the click goes as before.
        const stamped =
            typeof loc.withEl === "function" // Chrome bridge proxy: no handles
                ? await page.evaluate(
                      loc.withEl(`if (el) el.setAttribute("data-bhai-target", ${JSON.stringify(token)}); return !!el;`),
                  )
                : typeof loc.evaluate === "function" &&
                  (await loc.evaluate(
                      /* javascript-obfuscator:disable */ (el: Element, t: string) => {
                          el.setAttribute("data-bhai-target", t);
                          return true;
                      },
                      /* javascript-obfuscator:enable */ token,
                      { timeout },
                  ));
        if (!stamped) return false;
        const until = Date.now() + timeout;
        let tries = 0;
        for (;;) {
            go();
            const mark = `${token}.${tries}`;
            // A page that navigated meanwhile: the action itself finds out.
            const r = (await page.evaluate(UNBLOCK_JS(token, mark, commits)).catch(() => null)) as {
                state: "clear" | "keep" | "click" | "escape" | "wait";
                url: string;
                text: string;
            } | null;
            if (!r || r.state === "clear") return tries > 0;
            const what = r.text ? ` "${r.text}"` : "";
            if (r.state === "keep" || !onSite(r.url, domains)) throw new Error(`blocked_by_overlay: kept${what}`);
            if (tries < UNBLOCK_TRIES && (r.state === "click" || r.state === "escape")) {
                tries++;
                if (r.state === "escape") {
                    go();
                    await page.keyboard.press("Escape");
                } else {
                    const sel = `[data-bhai-unblock="${mark}"]`;
                    await guardedClick(page.locator(sel).first(), { op: "click", target: { sel } }, commits, go);
                }
                continue;
            }
            if (Date.now() >= until) throw new Error(`blocked_by_overlay:${what || " something covers the target"}`);
            await nap(100); // poll
        }
    }

    /** `commits` null = this is the consented submit, so no guard (and Stop doesn't hold it back). */
    async function doAct(a: SiteAction, commits: SiteAction[] | null, domains?: string[]): Promise<void> {
        // Up front (not even a trial click) and right before each dispatch, after
        // every wait: Stop keeps it from going out.
        const go = () => {
            if (commits && signal?.aborted) throw new Error("stopped");
        };
        go();
        {
            if (a.op === "click" || a.op === "pick") {
                const loc = a.op === "pick" ? await pickTarget(page, a, shown, timeout) : await locate(a);
                if (commits) await unblock(loc, commits, domains);
                await agentCursor(page, loc, "click"); // Bhai's cursor glides there first (owner can watch)
                if (!commits) await loc.click({ timeout });
                else await guardedClick(loc, a, commits, go);
            } else if (a.op === "type") {
                const loc = await locate(a);
                if (commits) await unblock(loc, commits, domains);
                await agentCursor(page, loc, "type");
                go();
                await loc.fill(a.value ?? "", { timeout });
            } else if (a.op === "typeCode") {
                go();
                const r = await page.evaluate(TYPE_CODE_JS(a.target?.sel ?? "", a.value ?? ""));
                if (r === "single") {
                    const loc = await locate(a);
                    go();
                    await loc.fill(a.value ?? "", { timeout });
                } else if (r !== "ok") throw new Error(`typeCode: ${r}`);
            } else if (a.op === "press") {
                const key = a.value ?? "Enter";
                if (commits && PRESSES.test(key.split("+").pop() ?? ""))
                    await guardKey(key.split("+").pop() as string, commits);
                go();
                await page.keyboard.press(key);
            } else if (a.op === "waitFor") {
                const loc = a.target?.sel
                    ? page.locator(a.target.sel)
                    : page.getByText(a.target?.text ?? "", { exact: false });
                await shown(loc).first().waitFor({ timeout });
            } else if (a.op === "navigate") {
                go();
                await page.goto(a.value, { waitUntil: "domcontentloaded" });
            }
            await page.waitForLoadState?.("domcontentloaded").catch(() => {});
        }
    }
}
