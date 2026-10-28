// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// PageDriver over a Playwright Page (or the Chrome bridge's ChromePageProxy,
// which mirrors the same subset). The snapshot is a string expression, not a
// function, so the packaged app's obfuscator can't rewrite it.

import type { SiteAction } from "./host.js";
import type { PageDriver, Snapshot } from "./runtime.js";

// In the page: an input that takes a one-time code. The autocomplete hint, a
// row of one-character boxes, or a name / id / label / placeholder that says
// so ("otp", "loginOtp", "OTP", "one-time password", "verification code",
// "passcode"; not "footprint").
export const IS_CODE_FIELD_JS = `((el) => el.tagName === "INPUT" && (el.autocomplete === "one-time-code" || el.maxLength === 1 ||
  ((s) => /(?:^|[^a-zA-Z])otp|[a-z]Otp|OTP/.test(s) || /one.?time|verification.?code|pass.?code/i.test(s))(
    [el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" "))))`;

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

// A control that spends money. Outside the consented submit, pressing one is
// refused even when the manifest forgot to list it.
export const MONEY_WORDS = /\b(place (your )?order|pay( now)?|proceed to pay|book now|make payment)\b/i;
const norm = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

type Control = { labels: string[]; submitLike: boolean };
// In the page: the controls an action on `el` (default: the focused element)
// would press — its own control, or with `form` (Enter) every control of the
// form it would submit. Nothing is focused (body) → none. A link that goes
// somewhere is navigation, not a submit; labels, radios and checkboxes are not
// controls here ("Pay on delivery" is a choice, not a payment).
const describeControls = /* javascript-obfuscator:disable */ (el: Element | null, form: boolean): Control[] => {
    const e = el || document.activeElement;
    if (!e || e === document.body || e === document.documentElement) return [];
    const CONTROL = "button,a,[role=button],input[type=submit],input[type=button],input[type=image]";
    const scope = form ? (e as HTMLInputElement).form || e.closest("form") : null;
    const own = e.closest(CONTROL);
    const list = scope ? [...scope.querySelectorAll(CONTROL)] : own ? [own] : [];
    return list.map((c) => {
        const h = c.getAttribute("href");
        return {
            labels: [(c as HTMLElement).innerText, (c as HTMLInputElement).value, c.getAttribute("aria-label")].filter((x): x is string => !!x),
            submitLike: c.tagName !== "A" || !h || h === "#" || /^javascript:/i.test(h),
        };
    });
} /* javascript-obfuscator:enable */;

// Why these controls are a commit, or "": a control labelled exactly as a
// declared commit is that commit (a header and footer copy of "Confirm
// booking"), and a submit-like control with a money word is one too.
const judge = (controls: Control[], commits: SiteAction[]): string => {
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
 * driver opens the last URL there and carries on.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
export function pageDriver(initial: any, timeout = 5000, reopen?: () => Promise<any>): PageDriver {
    let page = initial;
    let lastUrl = "";
    let lastWasSubmit = false;
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
    const closed = (e: unknown) => /Target (page, context or browser )?(has been )?closed|Target closed|page has been closed/i.test(String((e as Error)?.message ?? e));
    const revive = async () => {
        if (!reopen) return false;
        page = await reopen();
        watchDialogs(page);
        if (lastUrl) await page.goto(lastUrl, { waitUntil: "domcontentloaded" });
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
        if (a.target?.sel && commits.some((c) => c.target?.sel === a.target?.sel)) throw refuse(JSON.stringify(a.target));
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
                /* javascript-obfuscator:disable */ (e: Element | null) => !e || e === document.body || e === document.documentElement,
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
                await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
                await page.reload?.({ waitUntil: "domcontentloaded" }).catch(() => {});
                snap = await read();
            }
            if (!snap.url.startsWith("chrome-error://")) lastUrl = snap.url;
            return snap;
        },
        async act(a: SiteAction, opts?: { submit?: boolean; commits?: SiteAction[] }): Promise<void> {
            if (page.isClosed?.()) await revive();
            lastWasSubmit = !!opts?.submit;
            const p = page;
            if (opts?.submit) {
                p.__bhaiConfirmLeft = 1;
                p.__bhaiSubmitWindow = true;
            }
            try {
                await doAct(a, opts?.submit ? null : (opts?.commits ?? []));
            } finally {
                if (opts?.submit) {
                    p.__bhaiConfirmLeft = 0;
                    p.__bhaiSubmitWindow = false;
                }
            }
        },
    };
    return driver;
    /** `commits` null = this is the consented submit, so no guard. */
    async function doAct(a: SiteAction, commits: SiteAction[] | null): Promise<void> {
        {
            if (a.op === "click") {
                const loc = await locate(a);
                if (!commits) await loc.click({ timeout });
                else if (typeof loc.elementHandle !== "function") {
                    await guardByLabel(loc, a, commits);
                    await loc.click({ timeout });
                } else {
                    // Wait until it's clickable first (a disabled "Continue" may become
                    // "Place order"), then check and click that same node.
                    // ponytail: a relabel in the ms between the check and the click
                    // still slips by; a click-time in-page listener would close it.
                    await loc.click({ timeout, trial: true });
                    const h = await loc.elementHandle({ timeout });
                    try {
                        await guardCommit(h, commits);
                        await h.click({ timeout });
                    } finally {
                        await h.dispose().catch(() => {});
                    }
                }
            }
            else if (a.op === "type") await (await locate(a)).fill(a.value ?? "", { timeout });
            else if (a.op === "typeCode") {
                const r = await page.evaluate(TYPE_CODE_JS(a.target?.sel ?? "", a.value ?? ""));
                if (r === "single") await (await locate(a)).fill(a.value ?? "", { timeout });
                else if (r !== "ok") throw new Error(`typeCode: ${r}`);
            }
            else if (a.op === "press") {
                const key = a.value ?? "Enter";
                if (commits && PRESSES.test(key.split("+").pop() ?? "")) await guardKey(key.split("+").pop() as string, commits);
                await page.keyboard.press(key);
            }
            else if (a.op === "waitFor") {
                const loc = a.target?.sel ? page.locator(a.target.sel) : page.getByText(a.target?.text ?? "", { exact: false });
                await shown(loc).first().waitFor({ timeout });
            }
            else if (a.op === "navigate") await page.goto(a.value, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState?.("domcontentloaded").catch(() => {});
        }
    }
}
