// © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// ── Login / OTP wall detection ───────────────
// A page asking for a password, a one-time code, or a sign-in is a wall the
// agent must not get through on its own. In Playwright mode we first try the
// user's own Chrome session (that site's cookies only, via the Bhai Bridge
// extension); if the wall stays, tool results carry `auth_required` so the
// model asks the user to sign in.

import { getCurrentMode } from "./browser-backend.js";
import { getExtensionCookies, isExtensionConnected } from "./chrome-bridge.js";
import { waitForPageReady } from "./core.js";

export type AuthWallKind = "password" | "otp" | "sign_in";

export interface AuthSignals {
    password: boolean;
    otp: boolean;
    loginField: boolean;
    url: string;
    title: string;
}

export const AUTH_HINT =
    "This page needs the user to sign in / enter a code. Don't type credentials or codes yourself: ask the user to sign in in the browser window, wait for them to say done, then browser_scan and continue.";

/** Which wall the page signals, if any. */
export function classifyAuthWall(s: AuthSignals): AuthWallKind | null {
    if (s.otp) return "otp";
    let pathname = "";
    try {
        pathname = new URL(s.url).pathname;
    } catch {
        /* not a URL */
    }
    // A password box alone isn't a wall (a forum's header login): the page must look like one.
    const loginPage =
        /\/(log-?in|sign-?in|signin|auth|sso|session|password)(\/|$)/i.test(pathname) ||
        /\b(sign|log)[\s-]?in\b|\bpassword\b/i.test(s.title);
    if (s.password && loginPage) return "password";
    return s.loginField && loginPage ? "sign_in" : null;
}

// In-page signal collection (string form: also runs over the Chrome bridge).
const AUTH_SIGNALS_JS = `(() => {
  const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const inputs = Array.from(document.querySelectorAll("input")).filter(vis);
  const attrs = (el) => [el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" ");
  // A card's CVV ("Security code", "Card verification code") is not an OTP. No word
  // boundaries: cvv2, cardCvv, card_cvc, cardCode, "billing cc-csc" are all CVV fields.
  // A bare "card" is not: "OTP sent to your card ending 4242" is a real OTP box.
  const cvvRe = /cvv|cvc|csc|card[\\s_-]?(verification|security|code)/i;
  const cvv = (i) => /\\bcc-/i.test(i.autocomplete || "") || cvvRe.test(attrs(i));
  // A card-number field marks a payment form, where a bare "security code" is the CVV.
  // Only OTHER inputs count: an OTP box labelled "...card number ending 1234" is no card field.
  const cardNum = (j) => /\\bcc-number\\b/i.test(j.autocomplete || "") || /card[\\s_-]?num|ccnum/i.test(attrs(j));
  const payForm = (i) => inputs.some((j) => j !== i && cardNum(j));
  // Explicit OTP words always count; the ambiguous ones only outside a payment form.
  const otpRe = /\\b(otp|one[- ]?time|2fa|totp|passcode)\\b/i;
  const ambiguousRe = /\\b(verification code|security code)\\b/i;
  return {
    password: inputs.some((i) => i.type === "password"),
    otp: inputs.some((i) => i.autocomplete === "one-time-code" ||
           (!cvv(i) && (otpRe.test(attrs(i)) || (!payForm(i) && ambiguousRe.test(attrs(i)))))) ||
         inputs.filter((i) => i.maxLength === 1).length >= 4,
    loginField: inputs.some((i) => i.type === "email" || /username/i.test(i.autocomplete || "") ||
         /^(email|username|login|user|identifier|loginfmt)$/i.test(i.name || i.id || "")),
    url: location.href,
    title: document.title,
  };
})()`;

export async function detectAuthWall(page: any): Promise<AuthWallKind | null> {
    try {
        const s = (await page.evaluate(AUTH_SIGNALS_JS)) as AuthSignals | null;
        return s && typeof s.url === "string" ? classifyAuthWall(s) : null;
    } catch {
        return null;
    }
}

/**
 * Whether the page's document is a form-submission result (reloading would
 * re-POST it: a second OTP SMS, another failed login). Unknown counts as yes.
 */
async function fromFormSubmit(page: any): Promise<boolean> {
    try {
        const cdp = await page.context().newCDPSession(page);
        try {
            const h = await cdp.send("Page.getNavigationHistory");
            return h.entries[h.currentIndex]?.transitionType === "form_submit";
        } finally {
            await cdp.detach().catch(() => {});
        }
    } catch {
        return true;
    }
}

interface ChromeCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expirationDate?: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
}

/** chrome.cookies.Cookie[] → Playwright addCookies() input. */
export function toPlaywrightCookies(cookies: ChromeCookie[]) {
    return cookies.map((c) => {
        let sameSite: "Strict" | "Lax" | "None" =
            c.sameSite === "strict" ? "Strict" : c.sameSite === "no_restriction" ? "None" : "Lax";
        if (sameSite === "None" && !c.secure) sameSite = "Lax"; // Chromium rejects insecure SameSite=None
        return {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || "/",
            expires: c.expirationDate ?? -1,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite,
        };
    });
}

/**
 * Post-navigation check: on a login/OTP wall, try the user's Chrome session for
 * this site (Playwright mode + extension connected), reload, and re-check.
 * Returns tool-result fields: {} when there's no wall (or the import got past it).
 */
export async function checkAuthWall(page: any): Promise<Record<string, unknown>> {
    const kind = await detectAuthWall(page);
    if (!kind) return {};
    if (
        getCurrentMode() !== "chrome" &&
        isExtensionConnected() &&
        typeof page.context === "function" &&
        !(await fromFormSubmit(page))
    ) {
        try {
            // The cookies Chrome would send to this URL: Chrome's own public-suffix
            // rules scope them, so a *.vercel.app page never gets its neighbours'.
            const host = new URL(page.url()).hostname;
            const cookies = (await getExtensionCookies(page.url())) as ChromeCookie[];
            if (cookies.length > 0) {
                await page.context().addCookies(toPlaywrightCookies(cookies));
                await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
                await waitForPageReady(page);
                console.log(`  🍪 Auth wall: imported ${cookies.length} Chrome cookies for ${host}`);
                if (!(await detectAuthWall(page))) return { signed_in_with_chrome_session: host };
            }
        } catch (err) {
            console.warn(`  ⚠️ Auth wall: cookie import failed: ${(err as Error).message}`);
        }
    }
    return { auth_required: kind, auth_hint: AUTH_HINT };
}
