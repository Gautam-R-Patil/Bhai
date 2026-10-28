// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

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
    if (s.password) return "password";
    let pathname = "";
    try {
        pathname = new URL(s.url).pathname;
    } catch {
        /* not a URL */
    }
    const loginPage =
        /\/(log-?in|sign-?in|signin|auth|sso|session)(\/|$)/i.test(pathname) || /\b(sign|log)\s?in\b/i.test(s.title);
    return s.loginField && loginPage ? "sign_in" : null;
}

// In-page signal collection (string form: also runs over the Chrome bridge).
const AUTH_SIGNALS_JS = `(() => {
  const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const inputs = Array.from(document.querySelectorAll("input")).filter(vis);
  const attrs = (el) => [el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" ");
  const otpRe = /\\b(otp|one[- ]?time|verification code|security code|2fa|totp|passcode)\\b/i;
  return {
    password: inputs.some((i) => i.type === "password"),
    otp: inputs.some((i) => i.autocomplete === "one-time-code" || otpRe.test(attrs(i))) ||
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

/** Registrable-ish domain for cookie scoping (mail.google.com → google.com, x.co.uk → x.co.uk). */
// ponytail: no public-suffix list; covers 2-letter ccTLD second levels (co.uk, com.au, co.in). Add a PSL if a site needs it.
export function siteDomain(hostname: string): string {
    if (/^[\d.]+$/.test(hostname) || !hostname.includes(".")) return hostname;
    const parts = hostname.split(".");
    const cc = parts[parts.length - 1].length === 2 && /^(co|com|net|org|gov|edu|ac)$/.test(parts[parts.length - 2]);
    return parts.slice(cc ? -3 : -2).join(".");
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
    if (getCurrentMode() !== "chrome" && isExtensionConnected() && typeof page.context === "function") {
        try {
            const domain = siteDomain(new URL(page.url()).hostname);
            const cookies = (await getExtensionCookies(domain)) as ChromeCookie[];
            if (cookies.length > 0) {
                await page.context().addCookies(toPlaywrightCookies(cookies));
                await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
                await waitForPageReady(page);
                console.log(`  🍪 Auth wall: imported ${cookies.length} Chrome cookies for ${domain}`);
                if (!(await detectAuthWall(page))) return { signed_in_with_chrome_session: domain };
            }
        } catch (err) {
            console.warn(`  ⚠️ Auth wall: cookie import failed: ${(err as Error).message}`);
        }
    }
    return { auth_required: kind, auth_hint: AUTH_HINT };
}
