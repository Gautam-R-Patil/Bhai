// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Popup & Overlay Guard ─────────────────────
// Automatically dismisses cookie banners, newsletter modals, notification
// prompts, and other overlays that block browser agent interactions.
// Call attachPopupGuard() once after getBrowser() to auto-dismiss on every page.

import fs from "node:fs";
import path from "node:path";
import { getDownloadsDir } from "../../config/paths.js";
import type { BrowserContext, Page } from "./types.js";

// ─── Cookie / Consent Banner Dismissal ───────────────────────────────────────

const ACCEPT_BUTTON_TEXT = [
    "Accept all",
    "Accept All",
    "Accept All Cookies",
    "Accept Cookies",
    "Agree",
    "Agree All",
    "I agree",
    "I Agree",
    "Allow all",
    "Allow All",
    "Allow cookies",
    // Generic words ("OK", "Got it", "Continue") count only inside a cookie /
    // consent container — page-wide they could hit a checkout's Continue.
    "OK",
    "Ok",
    "Got it",
    "Got It",
    "Okay",
    "Continue",
    "That's fine",
    "Yes, I accept",
    "Accepter tout",
    "Alle akzeptieren",
    "Alles accepteren",
];

// Least data first (the privacy default): reject or
// decline when the banner offers it, accept only as the last option.
export const REJECT_BUTTON_TEXT = [
    "Reject all",
    "Reject All",
    "Decline all",
    "Decline All",
    "Reject",
    "Decline",
    "Only necessary",
    "Necessary only",
    "Use necessary cookies only",
    "Allow necessary only",
];

const REJECT_BUTTON_SELECTORS = [
    "#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#didomi-notice-disagree-button",
];

const CONSENT_BUTTON_SELECTORS = [
    // OneTrust ("#onetrust-pc-btn-handler" is "Cookie settings": it opens a panel)
    "#onetrust-accept-btn-handler",
    // Cookiebot
    "#CybotCookiebotDialogBodyButtonAccept",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    // Quantcast
    ".qc-cmp2-summary-buttons button:last-child",
    // Google
    "[aria-label='Accept all']",
    "[aria-label='Accept All']",
    // TrustArc
    ".trustarc-agree-btn",
    // Didomi
    "#didomi-notice-agree-button",
    // Generic
    "[id*='accept'][class*='cookie']",
    "[id*='consent'][class*='accept']",
    "[data-testid*='consent-accept']",
    "[data-testid*='cookie-accept']",
    ".cookie-accept",
    ".cookies-accept",
    "#accept-cookies",
    "#cookie-accept",
    ".js-accept-cookies",
    ".accept-cookies",
];

const MODAL_CLOSE_SELECTORS = [
    "[aria-label='Close']",
    "[aria-label='close']",
    "[aria-label='Dismiss']",
    "[aria-label='dismiss']",
    "button[class*='close']",
    "button[class*='dismiss']",
    "button[class*='modal-close']",
    ".modal-close",
    ".popup-close",
    ".overlay-close",
    "[data-dismiss='modal']",
    "[data-close]",
    "[data-testid*='close']",
    "[data-testid*='dismiss']",
];

// A cookie/consent banner, by an ancestor's markup or its short cookie notice.
// Cookie-banner signals only. A dialog, or a card that mentions the privacy
// policy ("By clicking Continue you agree…"), is not one: the guard runs
// unasked and must never advance a checkout or login.
export const CONSENT_MARK = /cookie|consent|gdpr|onetrust|didomi|cookiebot|qc-cmp|truste|cmp-/i;
export const CONSENT_TEXT = /\bcookies?\b|\bconsent\b/i;

/** True when the button sits in a cookie/consent banner (within 6 ancestors). */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Locator
async function inConsentContainer(btn: any): Promise<boolean> {
    return btn
        .evaluate(
            /* javascript-obfuscator:disable */ (el: Element, [mark, text]: [string, string]) => {
                let n: Element | null = el;
                for (let i = 0; i < 6 && n; i++) {
                    n = n.parentElement;
                    if (!n) break;
                    const tag = `${n.id} ${typeof n.className === "string" ? n.className : ""} ${n.getAttribute("aria-label") || ""}`;
                    if (new RegExp(mark, "i").test(tag)) return true;
                    const t = (n as HTMLElement).innerText || "";
                    if (t.length < 600 && new RegExp(text, "i").test(t)) return true;
                }
                return false;
            },
            /* javascript-obfuscator:enable */ [CONSENT_MARK.source, CONSENT_TEXT.source],
        )
        .catch(() => false);
}

export async function dismissCookieBanner(page: Page): Promise<boolean> {
    // Reject first, then accept; known vendor buttons before text search.
    for (const sel of [...REJECT_BUTTON_SELECTORS, ...CONSENT_BUTTON_SELECTORS]) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const loc = (page as any).locator(sel).first();
            if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
                await loc.click();
                return true;
            }
        } catch {
            /* not found */
        }
    }

    // Text search, only inside a consent container or dialog.
    for (const text of [...REJECT_BUTTON_TEXT, ...ACCEPT_BUTTON_TEXT]) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const btns = (page as any).getByRole("button", { name: text, exact: true });
            const n = await btns.count().catch(() => 0);
            for (let i = 0; i < n; i++) {
                const btn = btns.nth(i);
                if (await inConsentContainer(btn)) {
                    await btn.click({ timeout: 1500 });
                    return true;
                }
            }
        } catch {
            /* not found */
        }
    }
    return false;
}

// A control that spends money; and an input that takes a one-time code (the
// autocomplete hint, a row of one-character boxes, or a name / id / label /
// placeholder that says so: "otp", "loginOtp", "one-time password",
// "verification code", "passcode"; not "footprint"). Site Skills' page driver
// uses both too.
// "Confirm order" and the like count only as the label's start ("Review & confirm order" is a step before it).
export const MONEY_WORDS =
    /\b(place (your )?order|buy now|pay( now)?|proceed to pay(ment)?|book now|make payment)\b|^\s*(confirm|complete|submit) (your )?(order|purchase|booking|payment)\b/i;
export const IS_CODE_FIELD_JS = `((el) => el.tagName === "INPUT" && (el.autocomplete === "one-time-code" || el.maxLength === 1 ||
  ((s) => /(?:^|[^a-zA-Z])otp|[a-z]Otp|OTP/.test(s) || /one.?time|verification.?code|pass.?code/i.test(s))(
    [el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" "))))`;

// In the page: an overlay no automated dismissal may touch (no close click, no
// Escape, no hiding) — a payment sheet, a site's own "Pay ₹249?" confirm, a
// sign-in: it holds a frame, a password / card / one-time-code input, a
// money-word control, or a price.
export const KEEP_OVERLAY_JS = `((o) => {
  const isCode = ${IS_CODE_FIELD_JS}, money = new RegExp(${JSON.stringify(MONEY_WORDS.source)}, "i");
  if (o.matches("iframe,frame,object,embed") || o.querySelector("iframe,frame,object,embed")) return true;
  for (const i of o.querySelectorAll("input"))
    if (i.type === "password" || /^cc-/i.test(i.getAttribute("autocomplete") || "") || isCode(i)) return true;
  if (/[₹$€£]\\s?\\d|\\bRs\\.?\\s?\\d|\\bINR\\b/i.test(o.innerText || "")) return true;
  return [...o.querySelectorAll("button,a,[role=button],input[type=submit],input[type=button]")]
    .some((c) => money.test([c.innerText, c.value, c.getAttribute("aria-label")].join(" ")));
})`;

// What may be an overlay: a dialog, or an element named like a modal (open
// only when shown, and fixed / absolute unless it is a dialog).
export const OVERLAY_SEL =
    "[class*='modal'],[class*='popup'],[class*='overlay']:not([class*='video']),[class*='newsletter'],[class*='subscribe-modal'],[class*='exit-intent'],[class*='backdrop'],[class*='dimmer'],[role=dialog],[role=alertdialog],[aria-modal=true]";

// In the page: the overlays on top now, each stamped data-bhai-overlay unless
// it is a keeper. Returns how many of each.
const FIND_OVERLAYS_JS = `(() => {
  const keep = ${KEEP_OVERLAY_JS};
  const sel = ${JSON.stringify(OVERLAY_SEL)};
  let open = 0, kept = 0;
  for (const el of document.querySelectorAll("[data-bhai-overlay]")) el.removeAttribute("data-bhai-overlay");
  for (const el of document.querySelectorAll(sel)) {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0" || !r.width || !r.height) continue;
    if (s.position !== "fixed" && s.position !== "absolute" && !el.matches("[role=dialog],[role=alertdialog],[aria-modal=true]")) continue;
    if (keep(el) || el.closest("[data-bhai-keep]")) { el.setAttribute("data-bhai-keep", ""); kept++; continue; }
    el.setAttribute("data-bhai-overlay", "");
    open++;
  }
  for (const el of document.querySelectorAll("[data-bhai-keep]")) el.removeAttribute("data-bhai-keep");
  return { open, kept };
})()`;

export async function dismissOverlayModals(page: Page): Promise<void> {
    // Only overlays that are open and not keepers: a page's own × (a cart's
    // "Remove item") is never clicked, and a payment sheet is never closed or hidden.
    // biome-ignore lint/suspicious/noExplicitAny: Playwright Page
    const p = page as any;
    const found = (await p.evaluate(FIND_OVERLAYS_JS).catch(() => null)) as { open: number; kept: number } | null;
    if (!found?.open) return;

    // Escape dismisses most modal implementations; never while a keeper is open (it would close that too).
    if (!found.kept) {
        try {
            await p.keyboard.press("Escape");
            const { waitForPageReady } = await import("./core.js"); // core imports this module
            await waitForPageReady(page, 1000);
        } catch {
            /* ignore */
        }
    }

    // Try close buttons, inside an open overlay only
    for (const sel of MODAL_CLOSE_SELECTORS) {
        try {
            const btn = p.locator(`[data-bhai-overlay] ${sel}`).first();
            if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
                await btn.click();
                return;
            }
        } catch {
            /* not found */
        }
    }

    // DOM-based: hide overlays that actually block the page. A class name alone
    // proves nothing (Tailwind's `backdrop-blur-*` sits on sticky headers), so a
    // candidate must be fixed/absolute, cover most of the viewport, and sit on top.
    try {
        await p.evaluate(
            /* javascript-obfuscator:disable */ () => {
                for (const el of document.querySelectorAll("[data-bhai-overlay]")) {
                    const s = window.getComputedStyle(el);
                    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") continue;
                    if (s.position !== "fixed" && s.position !== "absolute") continue;
                    if (!(Number.parseInt(s.zIndex, 10) >= 10)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8) {
                        (el as HTMLElement).style.display = "none";
                    }
                }
            },
            /* javascript-obfuscator:enable */ undefined,
        );
    } catch {
        /* non-fatal */
    }
}

// ─── Attach to browser context ────────────────────────────────────────────────

function attachGuardToPage(page: Page): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).on("domcontentloaded", () => {
        // Run after a short settle — banners animate in
        setTimeout(async () => {
            await dismissCookieBanner(page).catch(() => {});
            await dismissOverlayModals(page).catch(() => {});
        }, 800);
    });

    // Handle native JS dialogs (alert/confirm/prompt/beforeunload)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).on(
        "dialog",
        async (dialog: {
            type: () => string;
            message: () => string;
            defaultValue: () => string;
            dismiss: () => Promise<void>;
            accept: (text?: string) => Promise<void>;
        }) => {
            const type = dialog.type();
            // "Leave site?" must be ACCEPTED: ignoring it leaves the navigation
            // waiting until it times out (the agent already chose to move on).
            if (type === "beforeunload") return dialog.accept().catch(() => {});
            // A Site Skill's consented submit handles its own "Place order?" confirm (page-driver.ts).
            // biome-ignore lint/suspicious/noExplicitAny: page flag
            if ((page as any).__bhaiSubmitWindow) return;
            // Alerts are informational: accept. confirm/prompt are the page asking
            // a question: dismiss (the safe answer) unless the agent armed an accept
            // for this action — either way the tool result reports it.
            const accept = type === "alert" || _acceptNextDialog;
            _acceptNextDialog = false;
            const message = dialog.message().slice(0, 300);
            if (accept) await dialog.accept(type === "prompt" ? dialog.defaultValue() : undefined).catch(() => {});
            else await dialog.dismiss().catch(() => {});
            _events.dialogs.push({
                type,
                message,
                action: accept ? "accepted" : "dismissed",
                ...(accept || type === "alert"
                    ? {}
                    : { hint: "If you meant to confirm, repeat the action with accept_dialog:true." }),
            });
        },
    );

    // Downloads: Playwright keeps them in a temp dir it deletes on close. Save to
    // the workspace Downloads folder and report the path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).on(
        "download",
        async (d: { suggestedFilename: () => string; saveAs: (p: string) => Promise<void> }) => {
            const entry: { file: string; status: string; path?: string; error?: string } = {
                file: path.basename(d.suggestedFilename() || "download"),
                status: "saving",
            };
            _events.downloads.push(entry);
            try {
                const dir = getDownloadsDir();
                let target = path.join(dir, entry.file);
                if (fs.existsSync(target)) {
                    const ext = path.extname(entry.file);
                    target = path.join(dir, `${path.basename(entry.file, ext)}-${Date.now()}${ext}`);
                }
                entry.path = target;
                await d.saveAs(target);
                entry.status = "saved";
            } catch (err) {
                entry.status = "failed";
                entry.error = (err as Error).message.split("\n")[0];
            }
        },
    );
}

// ─── Dialog / download reporting ─────────────────────────────────────────────

let _acceptNextDialog = false;
const _events: {
    dialogs: Array<Record<string, string>>;
    downloads: Array<{ file: string; status: string; path?: string; error?: string }>;
} = { dialogs: [], downloads: [] };

/** Accept the next confirm()/prompt() instead of dismissing it (one-shot). */
export function armDialogAccept(on = true): void {
    _acceptNextDialog = on;
}

/** Dialogs and downloads since the last call, as tool-result fields ({} when none). */
export function takePageEvents(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (_events.dialogs.length) out.dialogs = _events.dialogs.splice(0);
    if (_events.downloads.length) out.downloads = _events.downloads.splice(0);
    return out;
}

export function attachPopupGuard(context: BrowserContext): void {
    // Attach to pages opened AFTER the guard is installed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (context as any).on("page", (page: Page) => attachGuardToPage(page));

    // Also attach to pages that already exist (the initial blank page at context creation)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const page of (context as any).pages() as Page[]) {
        attachGuardToPage(page);
    }
}
