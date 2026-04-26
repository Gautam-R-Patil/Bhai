// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Popup & Overlay Guard ─────────────────────
// Automatically dismisses cookie banners, newsletter modals, notification
// prompts, and other overlays that block browser agent interactions.
// Call attachPopupGuard() once after getBrowser() to auto-dismiss on every page.

import type { Page, BrowserContext } from "./types.js";

// ─── Cookie / Consent Banner Dismissal ───────────────────────────────────────

const ACCEPT_BUTTON_TEXT = [
    "Accept all", "Accept All", "Accept All Cookies", "Accept Cookies",
    "Agree", "Agree All", "I agree", "I Agree",
    "Allow all", "Allow All", "Allow cookies",
    "OK", "Ok", "Got it", "Got It", "Okay",
    "Continue", "Proceed", "That's fine",
    "Yes, I accept", "Accepter tout",
    "Alle akzeptieren", "Alles accepteren",
];

const CONSENT_BUTTON_SELECTORS = [
    // OneTrust
    "#onetrust-accept-btn-handler",
    "#onetrust-pc-btn-handler",
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
    ".cookie-accept", ".cookies-accept",
    "#accept-cookies", "#cookie-accept",
    ".js-accept-cookies", ".accept-cookies",
];

const MODAL_CLOSE_SELECTORS = [
    "[aria-label='Close']", "[aria-label='close']",
    "[aria-label='Dismiss']", "[aria-label='dismiss']",
    "button[class*='close']", "button[class*='dismiss']",
    "button[class*='modal-close']", ".modal-close",
    ".popup-close", ".overlay-close",
    "[data-dismiss='modal']", "[data-close]",
    "[data-testid*='close']", "[data-testid*='dismiss']",
];

export async function dismissCookieBanner(page: Page): Promise<boolean> {
    // Try known selector patterns first (faster than text search)
    for (const sel of CONSENT_BUTTON_SELECTORS) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const loc = (page as any).locator(sel).first();
            if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
                await loc.click();
                return true;
            }
        } catch { /* not found */ }
    }

    // Text-based search for accept buttons
    for (const text of ACCEPT_BUTTON_TEXT) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const btn = (page as any).getByRole("button", { name: text, exact: true });
            if (await btn.count().catch(() => 0) > 0) {
                await btn.first().click({ timeout: 1500 });
                return true;
            }
        } catch { /* not found */ }
    }
    return false;
}

export async function dismissOverlayModals(page: Page): Promise<void> {
    // Escape key dismisses most modal implementations
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).keyboard.press("Escape");
        await new Promise(r => setTimeout(r, 250));
    } catch { /* ignore */ }

    // Try close buttons
    for (const sel of MODAL_CLOSE_SELECTORS) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const btn = (page as any).locator(sel).first();
            if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
                await btn.click();
                return;
            }
        } catch { /* not found */ }
    }

    // DOM-based: hide known overlay patterns directly
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (page as any).evaluate(() => {
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
            document.querySelectorAll("[class*='backdrop'],[class*='dimmer'],[class*='overlay-bg']")
                .forEach(el => { (el as HTMLElement).style.display = "none"; });
        });
    } catch { /* non-fatal */ }
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
    (page as any).on("dialog", async (dialog: { type: () => string; dismiss: () => Promise<void>; accept: () => Promise<void> }) => {
        const type = dialog.type();
        if (type === "beforeunload") return; // let navigation proceed
        await dialog.dismiss().catch(() => {});
    });
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
