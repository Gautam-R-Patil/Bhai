// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Popup & Overlay Guard ─────────────────────
// Automatically dismisses cookie banners, newsletter modals, notification
// prompts, and other overlays that block browser agent interactions.
// Call attachPopupGuard() once after getBrowser() to auto-dismiss on every page.

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
const REJECT_BUTTON_TEXT = [
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

/** True when the button sits in a cookie/consent banner (by its markup or a short cookie notice). */
// biome-ignore lint/suspicious/noExplicitAny: Playwright Locator
async function inConsentContainer(btn: any): Promise<boolean> {
    return btn
        .evaluate(
            /* javascript-obfuscator:disable */ (el: Element) => {
                let n: Element | null = el;
                for (let i = 0; i < 6 && n; i++) {
                    n = n.parentElement;
                    if (!n) break;
                    // Cookie-banner signals only. A dialog, or a card that mentions the
                    // privacy policy ("By clicking Continue you agree…"), is not one:
                    // the guard runs unasked and must never advance a checkout or login.
                    const tag = `${n.id} ${typeof n.className === "string" ? n.className : ""} ${n.getAttribute("aria-label") || ""}`;
                    if (/cookie|consent|gdpr|onetrust|didomi|cookiebot|qc-cmp|truste|cmp-/i.test(tag)) return true;
                    const t = (n as HTMLElement).innerText || "";
                    if (t.length < 600 && /\bcookies?\b|\bconsent\b/i.test(t)) return true;
                }
                return false;
            },
            /* javascript-obfuscator:enable */ undefined,
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

export async function dismissOverlayModals(page: Page): Promise<void> {
    // Escape key dismisses most modal implementations
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 250));
    } catch {
        /* ignore */
    }

    // Try close buttons
    for (const sel of MODAL_CLOSE_SELECTORS) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const btn = (page as any).locator(sel).first();
            if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
                await btn.click();
                return;
            }
        } catch {
            /* not found */
        }
    }

    // DOM-based: hide known overlay patterns directly
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).evaluate(
            /* javascript-obfuscator:disable */ () => {
                const patterns = [
                    "[class*='modal']:not([style*='display: none'])",
                    "[class*='popup']:not([style*='display: none'])",
                    "[class*='overlay']:not([class*='video']):not([style*='display: none'])",
                    "[class*='newsletter']",
                    "[class*='subscribe-modal']",
                    "[class*='exit-intent']",
                    "[role='dialog'][aria-modal='true']",
                ];
                for (const sel of patterns) {
                    for (const el of document.querySelectorAll(sel)) {
                        const s = window.getComputedStyle(el);
                        if (s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0") {
                            const rect = el.getBoundingClientRect();
                            // Only hide near-fullscreen overlays (width > 65% AND height > 15%)
                            // to avoid accidentally hiding legitimate sidebars or narrow drawers
                            if (rect.width > window.innerWidth * 0.65 && rect.height > window.innerHeight * 0.15) {
                                (el as HTMLElement).style.display = "none";
                            }
                        }
                    }
                }
                // Remove backdrop divs that block clicks
                document
                    .querySelectorAll("[class*='backdrop'],[class*='dimmer'],[class*='overlay-bg']")
                    .forEach((el) => {
                        (el as HTMLElement).style.display = "none";
                    });
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
        async (dialog: { type: () => string; dismiss: () => Promise<void>; accept: () => Promise<void> }) => {
            const type = dialog.type();
            // "Leave site?" must be ACCEPTED: ignoring it leaves the navigation
            // waiting until it times out (the agent already chose to move on).
            if (type === "beforeunload") return dialog.accept().catch(() => {});
            // A Site Skill's consented submit handles its own "Place order?" confirm
            // (page-driver.ts); everything else — alerts, prompts, other confirms — is dismissed.
            // biome-ignore lint/suspicious/noExplicitAny: page flag
            if ((page as any).__bhaiSubmitWindow) return;
            await dialog.dismiss().catch(() => {});
        },
    );
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
