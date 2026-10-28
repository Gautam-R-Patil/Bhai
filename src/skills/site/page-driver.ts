// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// PageDriver over a Playwright Page (or the Chrome bridge's ChromePageProxy,
// which mirrors the same subset). The snapshot is a string expression, not a
// function, so the packaged app's obfuscator can't rewrite it.

import type { SiteAction } from "./host.js";
import type { PageDriver, Snapshot } from "./runtime.js";

const SNAPSHOT_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const els = [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[data-id]")]
    .filter(visible).slice(0, 200).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.getAttribute("name") || undefined,
      type: el.getAttribute("type") || undefined,
      checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
      text: (el.type === "password" ? "" : (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")).trim().slice(0, 120),
      dataId: el.getAttribute("data-id") || undefined,
      context: ((el.closest("li,tr,article,[data-item]") || {}).innerText || "").trim().slice(0, 200) || undefined,
    }));
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 4000), elements: els };
})()`;

// A one-time code into the field the skill names: one box per character when
// it's the first of a row of maxlength=1 boxes (rules from Pomerado's autofill,
// MIT), else the whole code into that one field. A count mismatch types nothing.
// Values go in through the native setter + input/change events, then are read back.
const TYPE_CODE_JS = (sel: string, code: string) => `(() => {
  const sel = ${JSON.stringify(sel)}, code = ${JSON.stringify(code)};
  const start = sel ? document.querySelector(sel) : document.querySelector('input[autocomplete="one-time-code"]');
  if (!start) return "not_found";
  const editable = (c) => c.tagName === "INPUT" && ["", "text", "tel", "number", "password"].includes((c.getAttribute("type") || "").toLowerCase())
    && !c.disabled && !c.readOnly && c.getBoundingClientRect().width > 0;
  if (!editable(start)) return "not_editable";
  if (start.maxLength !== 1) return "single";
  const boxes = [...(start.form || start.getRootNode()).querySelectorAll("input")].filter((c) => editable(c) && c.maxLength === 1);
  if (boxes[0] !== start) return "not_first_box";
  if (boxes.length !== code.length) return "count_mismatch:" + boxes.length + "_boxes";
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  boxes.forEach((b, i) => { b.focus(); set.call(b, code[i]); b.dispatchEvent(new Event("input", { bubbles: true })); b.dispatchEvent(new Event("change", { bubbles: true })); });
  return boxes.map((b) => b.value).join("") === code ? "ok" : "readback_failed";
})()`;

/**
 * `reopen` (optional) gives a fresh page when the user closed the tab: the
 * driver opens the last URL there and carries on.
 */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Page or ChromePageProxy
export function pageDriver(initial: any, timeout = 5000, reopen?: () => Promise<any>): PageDriver {
    let page = initial;
    let lastUrl = "";
    let lastWasSubmit = false;
    const closed = (e: unknown) => /Target (page, context or browser )?(has been )?closed|Target closed|page has been closed/i.test(String((e as Error)?.message ?? e));
    const revive = async () => {
        if (!reopen) return false;
        page = await reopen();
        if (lastUrl) await page.goto(lastUrl, { waitUntil: "domcontentloaded" });
        return true;
    };
    // Exactly one element, or no click: the selector first, then the visible
    // text when the selector no longer matches (a site renamed its ids). Two
    // matches means we don't know which one the skill meant (Pomerado's rule).
    const locate = async (a: SiteAction) => {
        const bySel = a.target?.sel ? page.locator(a.target.sel) : null;
        const byText = a.target?.text ? page.getByText(a.target.text, { exact: false }) : null;
        for (const loc of [bySel, byText]) {
            if (!loc) continue;
            if (typeof loc.count !== "function") return loc.first(); // Chrome bridge proxy: no count()
            const n = await loc.count();
            if (n > 1) throw new Error(`ambiguous_target: ${n} elements match ${JSON.stringify(a.target)}`);
            if (n === 1) return loc;
        }
        throw new Error(`not_found: ${JSON.stringify(a.target)}`);
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
        async act(a: SiteAction, opts?: { submit?: boolean }): Promise<void> {
            if (page.isClosed?.()) await revive();
            lastWasSubmit = !!opts?.submit;
            // During the consented submit only: accept ONE native confirm ("Place
            // order for ₹249?"), top frame only. Any other dialog is dismissed.
            let onDialog: ((d: { type(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => void) | undefined;
            if (opts?.submit) {
                let used = false;
                page.__bhaiSubmitWindow = true;
                onDialog = (d) => {
                    const ok = d.type() === "confirm" && !used;
                    used = true;
                    (ok ? d.accept() : d.dismiss()).catch(() => {});
                };
                page.on("dialog", onDialog);
            }
            try {
                await doAct(a);
            } finally {
                if (onDialog) {
                    page.off("dialog", onDialog);
                    page.__bhaiSubmitWindow = false;
                }
            }
        },
    };
    return driver;
    async function doAct(a: SiteAction): Promise<void> {
        {
            if (a.op === "click") await (await locate(a)).click({ timeout });
            else if (a.op === "type") await (await locate(a)).fill(a.value ?? "", { timeout });
            else if (a.op === "typeCode") {
                const r = await page.evaluate(TYPE_CODE_JS(a.target?.sel ?? "", a.value ?? ""));
                if (r === "single") await (await locate(a)).fill(a.value ?? "", { timeout });
                else if (r !== "ok") throw new Error(`typeCode: ${r}`);
            }
            else if (a.op === "press") await page.keyboard.press(a.value ?? "Enter");
            else if (a.op === "waitFor") {
                const loc = a.target?.sel ? page.locator(a.target.sel) : page.getByText(a.target?.text ?? "", { exact: false });
                await loc.first().waitFor({ timeout });
            }
            else if (a.op === "navigate") await page.goto(a.value, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState?.("domcontentloaded").catch(() => {});
        }
    }
}
