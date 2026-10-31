// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── CAPTCHA Detection & Solving ───────────────
// Detects CAPTCHA type, solves via 2captcha API (CAPTCHA_API_KEY env var),
// and injects the token. Falls back gracefully if no API key is set.
// Supports: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.

import { createRequire } from "node:module";
import { join } from "node:path";
import { transcribeBuffer } from "../../voice/transcribe.js";
import type { ToolDefinition } from "../get-current-time.js";
import { getCurrentMode } from "./browser-backend.js";
import { chromeDriver } from "./captcha-chrome.js";
import { type CaptchaDriver, playwrightDriver, solveWithVision } from "./captcha-vision.js";
import { getActivePage, touchBrowserActivity } from "./core.js";
import { isNativeBrowserAvailable } from "./native-browser.js";

// Try to use Rust-native CAPTCHA classifier for speed
let nativeClassifyCaptcha: ((html: string) => { kind: string; confidence: number }) | null = null;
try {
    const _req = createRequire(import.meta.url);
    const mod = _req(join(process.cwd(), "native", "index.js")) as Record<string, unknown>;
    if (typeof mod.classifyCaptcha === "function") {
        nativeClassifyCaptcha = mod.classifyCaptcha as (html: string) => { kind: string; confidence: number };
    }
} catch {
    /* native not available */
}

export type CaptchaType =
    | "recaptcha-v2"
    | "recaptcha-v3"
    | "hcaptcha"
    | "turnstile"
    // Form-style checks Bhai reads and fills itself (captcha-forms.ts)
    | "image-text"
    | "text-question"
    | "click-image"
    | "rotate"
    // A vendor Bhai can't solve itself (siteKey holds its name): detected so it goes to the owner
    | "other"
    | "none";

// ─── Convex-backed key loader ─────────────────────────────────────────────
// CAPTCHA API keys are stored as Convex environment variables (never bundled
// into the app). Fetched lazily on first use and cached in process.env.
let _captchaKeysFetched = false;
let _captchaKeysFetchInFlight: Promise<void> | null = null;

async function ensureCaptchaKeys(): Promise<void> {
    if (_captchaKeysFetched) return;
    // Skip Convex fetch if any solving key already present locally
    if (
        process.env.NOCAPTCHAAI_API_KEY ||
        process.env.NOPECHA_API_KEY ||
        process.env.CAPTCHA_API_KEY ||
        process.env.TWO_CAPTCHA_API_KEY
    ) {
        _captchaKeysFetched = true;
        return;
    }
    // Deduplicate concurrent calls — return the same in-flight promise to all callers
    if (_captchaKeysFetchInFlight) return _captchaKeysFetchInFlight;
    _captchaKeysFetchInFlight = (async () => {
        // Node.js is single-threaded: the check above and the finally below are
        // atomic w.r.t. the event loop — no true TOCTOU race is possible here.
        try {
            const { getConvexSiteUrl } = await import("../../config/keys.js");
            const { getSessionToken } = await import("../../session.js");
            const { encryptedFetch } = await import("../../crypto-transport.js");
            const convexUrl = getConvexSiteUrl();
            const sessionToken = await getSessionToken().catch(() => null);
            if (!convexUrl || !sessionToken) return;
            // Must go through encryptedFetch: the endpoint refuses cleartext
            // (400) and returns an encrypted response this unwraps.
            const resp = await encryptedFetch(`${convexUrl}/api/config/secrets`, {
                headers: { Authorization: `Bearer ${sessionToken}` },
            });
            if (!resp.ok) {
                console.warn(`  ⚠️ CAPTCHA: secrets fetch failed (${resp.status}) — will retry on next CAPTCHA`);
                return;
            }
            const secrets = (await resp.json()) as Record<string, string>;
            // Only mark fetched on success so a transient failure (no session
            // yet, network blip) doesn't disable key loading for the process.
            _captchaKeysFetched = true;
            if (secrets.NOCAPTCHAAI_API_KEY && !process.env.NOCAPTCHAAI_API_KEY) {
                process.env.NOCAPTCHAAI_API_KEY = secrets.NOCAPTCHAAI_API_KEY;
                console.log("  🔑 CAPTCHA: NOCAPTCHAAI_API_KEY loaded from Convex");
            }
            if (secrets.NOPECHA_API_KEY && !process.env.NOPECHA_API_KEY) {
                process.env.NOPECHA_API_KEY = secrets.NOPECHA_API_KEY;
                console.log("  🔑 CAPTCHA: NOPECHA_API_KEY loaded from Convex");
            }
            if (secrets.CAPTCHA_API_KEY && !process.env.CAPTCHA_API_KEY) {
                process.env.CAPTCHA_API_KEY = secrets.CAPTCHA_API_KEY;
                console.log("  🔑 CAPTCHA: CAPTCHA_API_KEY loaded from Convex");
            }
        } catch {
            /* non-fatal — keys may still be available via process.env */
        } finally {
            _captchaKeysFetchInFlight = null;
        }
    })();
    return _captchaKeysFetchInFlight;
}

export interface CaptchaInfo {
    type: CaptchaType;
    siteKey: string | null;
}

// ─── Detection ────────────────────────────────

export async function detectCaptcha(
    page: ReturnType<typeof getActivePage> extends Promise<infer P> ? P : never,
): Promise<CaptchaInfo> {
    // Fast Rust pre-check: used ONLY as a fast negative. On a positive we still
    // run the JS detector below — the classifier reads raw HTML and can't
    // extract the sitekey that the NopeCHA/2captcha tiers need.
    if (nativeClassifyCaptcha) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const html = (await (page as any).evaluate(
                /* javascript-obfuscator:disable */ () => document.documentElement.innerHTML.substring(0, 50000),
                /* javascript-obfuscator:enable */ undefined,
            )) as string;
            const result = nativeClassifyCaptcha(html);
            // The classifier only knows the big widgets: trust its "none" only when the page
            // doesn't so much as mention a check (Enterprise, text and vendor CAPTCHAs).
            const mentions =
                /captcha|geetest|arkose|funcaptcha|awswaf|turnstile|challenge-form|cf-chl-widget|cf-challenge|just a moment|attention required|checking your browser|verify you are human/i.test(
                    html,
                );
            if (result.kind === "none" && result.confidence === 0 && !mentions) {
                return { type: "none", siteKey: null }; // definitively no CAPTCHA
            }
        } catch {
            /* fall through to JS eval */
        }
    }

    // Full JS evaluate for type + siteKey extraction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (await (page as any).evaluate(
        /* javascript-obfuscator:disable */ (): { type: string; siteKey: string | null } => {
            // Cloudflare Turnstile
            const tsFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
            const tsWidget = document.querySelector('[class*="cf-turnstile"],[data-cf-turnstile]');
            if (tsFrame || tsWidget) {
                const src = tsFrame?.getAttribute("src") ?? "";
                const key =
                    src.match(/[?&]sitekey=([^&]+)/)?.[1] ?? (tsWidget as HTMLElement)?.dataset?.sitekey ?? null;
                return { type: "turnstile", siteKey: key };
            }
            // hCaptcha
            const hcFrame = document.querySelector('iframe[src*="hcaptcha.com"]');
            const hcWidget = document.querySelector(".h-captcha,[data-hcaptcha-widget-id]");
            if (hcFrame || hcWidget) {
                return { type: "hcaptcha", siteKey: (hcWidget as HTMLElement)?.dataset?.sitekey ?? null };
            }
            // reCAPTCHA v2 checkbox first: a page can load v3 everywhere and
            // still show an "I'm not a robot" box (v3's own anchor frame is size=invisible).
            const rcFrames = Array.from(
                document.querySelectorAll('iframe[src*="google.com/recaptcha"],iframe[src*="recaptcha.net"]'),
            );
            const rcWidget = document.querySelector(".g-recaptcha");
            const rcV2 = { type: "recaptcha-v2", siteKey: (rcWidget as HTMLElement)?.dataset?.sitekey ?? null };
            const box = rcFrames.some((f) => {
                const src = f.getAttribute("src") ?? "";
                return src.includes("/anchor") && !src.includes("size=invisible");
            });
            if (box) return rcV2;
            // Before any frame renders, a visible widget div means a box is coming.
            // Once frames exist they decide (all size=invisible = no box), and a
            // <button class="g-recaptcha"> is v3 / invisible v2 bound to a button.
            const widgetBox =
                !!rcWidget && rcWidget.tagName !== "BUTTON" && rcWidget.getAttribute("data-size") !== "invisible";
            if (widgetBox && rcFrames.length === 0) return rcV2;
            // reCAPTCHA v3 (invisible — detected by script tag; render=explicit is a v2 loader)
            const scripts = Array.from(document.scripts).map((s) => s.src);
            const rcV3 = scripts.find((s) => s.includes("recaptcha/api.js?render=") && !s.includes("render=explicit"));
            if (rcV3) {
                return { type: "recaptcha-v3", siteKey: rcV3.match(/render=([^&]+)/)?.[1] ?? null };
            }
            // Invisible v2: only its picture challenge, once it pops up, needs anyone. Until then
            // it's like v3 (and often passes by itself), so it's reported as that.
            const challengeUp = rcFrames.some((f) => {
                const r = f.getBoundingClientRect();
                return (
                    (f.getAttribute("src") ?? "").includes("/bframe") &&
                    r.width > 100 &&
                    r.bottom > 0 &&
                    getComputedStyle(f).visibility !== "hidden"
                );
            });
            if (challengeUp) return rcV2;
            if (rcFrames.length || rcWidget) return { type: "recaptcha-v3", siteKey: rcV2.siteKey };
            // Cloudflare's full-page check. Only its own titles: "please wait" etc. are ordinary loading pages.
            if (
                /^(just a moment|attention required|checking your browser|verify you are human)/i.test(document.title) ||
                document.querySelector("#challenge-form,#challenge-stage,[id^='cf-chl-widget'],.cf-challenge")
            ) {
                return { type: "turnstile", siteKey: null };
            }
            // Vendors Bhai can't solve itself: detected so they reach the owner, never missed.
            const vendors: [string, string][] = [
                ["geetest", "[class*='geetest_'],[class^='geetest'],iframe[src*='geetest']"],
                ["arkose", "iframe[src*='arkoselabs'],iframe[src*='funcaptcha'],[id*='funcaptcha']"],
                ["aws-waf", "awswaf-captcha,iframe[src*='awswaf'],[id*='aws-waf']"],
                ["mtcaptcha", ".mtcaptcha,iframe[src*='mtcaptcha']"],
                ["keycaptcha", "[id*='keycaptcha'],[class*='keycaptcha'],iframe[src*='keycaptcha']"],
                ["lemin", "[id^='lemin-cropped-captcha'],iframe[src*='leminnow']"],
                ["friendly-captcha", ".frc-captcha"],
                ["yandex-smartcaptcha", ".smart-captcha,iframe[src*='smartcaptcha']"],
                ["solvemedia", "[id*='adcopy'],iframe[src*='solvemedia']"],
            ];
            const vendor = vendors.find(([, sel]) => document.querySelector(sel));
            if (vendor) return { type: "other", siteKey: vendor[0] };
            // Form-style checks: an image named captcha, a field for the answer, rotate buttons.
            // No named helper functions in here: the bundler wraps them in a __name() the page lacks.
            const field = Array.from(document.querySelectorAll("input")).find((i) => {
                const r = i.getBoundingClientRect();
                return (
                    /^(text|)$/i.test(i.type || "") &&
                    /captcha|verification code|security code|enter the (characters|code|text)/i.test(
                        `${i.name} ${i.id} ${i.placeholder || ""} ${i.labels?.[0]?.textContent || ""}`,
                    ) &&
                    r.width > 20 &&
                    r.height > 10
                );
            });
            const img = Array.from(document.images).find((i) => {
                const r = i.getBoundingClientRect();
                // In a form and not a logo: sites (and CAPTCHA vendors) show "captcha" logos everywhere.
                return (
                    /captcha/i.test(`${i.src} ${i.id} ${i.className} ${i.alt}`) &&
                    !/logo|icon/i.test(`${i.alt} ${i.className}`) &&
                    !!i.closest("form") &&
                    r.width > 20 &&
                    r.height > 10
                );
            });
            // No token shows a form check is done: its field holds an answer, or the image is the one
            // Bhai answered (captcha-forms marks it; a reload or a new image clears that).
            if (field ? !!field.value : img?.getAttribute("data-bhai-answered") === img?.src) {
                return { type: "none", siteKey: null };
            }
            if (img && document.querySelector("button[class*='rotate' i],[class*='rotate' i] button")) {
                return { type: "rotate", siteKey: null };
            }
            if (img && field) return { type: "image-text", siteKey: null };
            if (field) return { type: "text-question", siteKey: null };
            if (img) return { type: "click-image", siteKey: null };
            return { type: "none", siteKey: null };
        },
        /* javascript-obfuscator:enable */ undefined,
    )) as CaptchaInfo | null;
    // Older extension builds return {error} instead of throwing — never read
    // a malformed result as "CAPTCHA present".
    if (!info || typeof info.type !== "string") {
        throw new Error(`CAPTCHA detection failed: ${JSON.stringify(info).slice(0, 120)}`);
    }
    return info;
}

// A ticked widget stays on the page; its response token field fills.
export const CAPTCHA_SOLVED_JS = `[...document.querySelectorAll('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"],input[name="cf-turnstile-response"]')].some((e) => !!e.value)`;

/** True when a widget on the page already holds a response token (the owner ticked it). */
export async function captchaSolved(page: unknown): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await Promise.resolve((page as any).evaluate(CAPTCHA_SOLVED_JS)).catch(() => false)) === true;
}

/**
 * Cheap check for a human check the owner still has to do: its type, or null
 * if none, invisible v3 (nothing to tick), already ticked, or undetectable.
 * Never throws.
 */
export async function quickCaptchaCheck(page: unknown): Promise<CaptchaType | null> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = await detectCaptcha(page as any);
        if (info.type === "none" || info.type === "recaptcha-v3") return null;
        return (await captchaSolved(page)) ? null : info.type;
    } catch {
        return null;
    }
}

// ─── The CAPTCHA pipeline ─────────────────────
// The agent never deals with CAPTCHAs. After any page action, a check on the page
// goes here: Bhai's solvers, then (only if they can't) the owner, while the agent's
// tool call simply waits. The agent gets the page back, or one line saying the owner
// still has to finish it. BHAI_NO_CAPTCHA_AUTO=true skips the solvers: every
// check goes straight to the owner.

type CaptchaOutcome = { present: false } | { present: true; cleared: boolean; detail: Record<string, unknown> };

// A page the pipeline just gave up on (solvers and owner both): later steps on it go
// straight to "the owner has to do it" instead of re-running solvers and another
// ~5 min wait for each step. Cleared, the entry goes; it expires after GAVE_UP_MS.
const gaveUp = new Map<string, number>();
const GAVE_UP_MS = 180_000;
const pageKey = (page: unknown) => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return String((page as any).url?.() ?? "").split("#")[0];
    } catch {
        return "";
    }
};

export async function clearCaptchaIfAny(page: unknown, signal?: AbortSignal): Promise<CaptchaOutcome> {
    const type = await quickCaptchaCheck(page);
    const key = pageKey(page);
    if (!type) {
        gaveUp.delete(key);
        return { present: false };
    }
    const since = gaveUp.get(key);
    if (since && Date.now() - since < GAVE_UP_MS)
        return { present: true, cleared: false, detail: { status: "still_waiting" } };
    console.log(`  🧩 CAPTCHA pipeline: ${type} on the page, taking over`);
    const raw =
        process.env.BHAI_NO_CAPTCHA_AUTO === "true"
            ? await (await import("./human-handoff.js")).browserWaitForHuman.handler({ _signal: signal })
            : await browserHandleCaptcha.handler({ _signal: signal });
    const detail = JSON.parse(raw) as Record<string, unknown>;
    const cleared = detail.success === true;
    console.log(`  🧩 CAPTCHA pipeline: ${cleared ? `cleared (${detail.method ?? detail.status})` : "not cleared"}`);
    if (cleared) gaveUp.delete(key);
    else if (detail.status !== "cancelled" && key) gaveUp.set(key, Date.now());
    return { present: true, cleared, detail };
}

/** A browser tool's result after the pipeline had its turn: nothing about CAPTCHAs in it. */
export async function captchaAfterAction(result: string, signal?: AbortSignal): Promise<string> {
    const outcome = await getActivePage()
        .then((page) => clearCaptchaIfAny(page, signal))
        .catch(() => ({ present: false }) as const);
    if (!outcome.present) return result;
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(result);
    } catch {
        obj = { result };
    }
    if (outcome.cleared) {
        // A challenge page (Cloudflare's 403/503) is gone once cleared: not a failed load.
        if (typeof obj.error === "string" && /HTTP (403|429|503)/.test(obj.error)) {
            delete obj.error;
            obj.success = true;
        }
        obj.page_note =
            "The page changed after this step (Bhai finished an automatic step on it). Scan it again before relying on the element list above.";
    } else {
        obj.error ??= "This page is waiting on the owner.";
        obj.owner_needed =
            outcome.detail.status === "cancelled"
                ? "Stopped by the owner."
                : "This page has a step only the owner can finish (they were asked and it's still open). Don't try that step yourself: stop and send the stuck report (what's blocked, and that the owner has to finish it in the browser), ending with [[STUCK]] on its own line.";
    }
    return JSON.stringify(obj);
}

// ─── Solver (2captcha) ────────────────────────

async function solve2captcha(type: CaptchaType, siteKey: string, pageUrl: string): Promise<string | null> {
    const apiKey = process.env.CAPTCHA_API_KEY || process.env.TWO_CAPTCHA_API_KEY;
    if (!apiKey) {
        console.warn("  ⚠️ CAPTCHA detected but CAPTCHA_API_KEY not set. Set env var to enable auto-solving.");
        return null;
    }

    let endpoint = "";
    let params: Record<string, string> = { key: apiKey, json: "1" };

    if (type === "recaptcha-v2") {
        endpoint = "https://2captcha.com/in.php";
        params = { ...params, method: "userrecaptcha", googlekey: siteKey, pageurl: pageUrl };
    } else if (type === "recaptcha-v3") {
        endpoint = "https://2captcha.com/in.php";
        params = {
            ...params,
            method: "userrecaptcha",
            googlekey: siteKey,
            pageurl: pageUrl,
            version: "v3",
            action: "submit",
            min_score: "0.7",
        };
    } else if (type === "hcaptcha") {
        endpoint = "https://2captcha.com/in.php";
        params = { ...params, method: "hcaptcha", sitekey: siteKey, pageurl: pageUrl };
    } else if (type === "turnstile") {
        endpoint = "https://2captcha.com/in.php";
        params = { ...params, method: "turnstile", sitekey: siteKey, pageurl: pageUrl };
    } else {
        return null;
    }

    try {
        // Submit task
        const submitUrl = endpoint + "?" + new URLSearchParams(params).toString();
        const submitRes = await fetch(submitUrl);
        const submitData = (await submitRes.json()) as { status: number; request: string };
        if (submitData.status !== 1) {
            console.warn("  ⚠️ 2captcha submit failed:", submitData.request);
            return null;
        }
        const taskId = submitData.request;

        // Poll for result (max 120s)
        for (let i = 0; i < 24; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const pollRes = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
            const pollData = (await pollRes.json()) as { status: number; request: string };
            if (pollData.status === 1) return pollData.request;
            if (pollData.request !== "CAPCHA_NOT_READY") {
                console.warn("  ⚠️ 2captcha poll error:", pollData.request);
                return null;
            }
        }
        console.warn("  ⚠️ 2captcha: timeout waiting for solution");
        return null;
    } catch (err) {
        console.warn("  ⚠️ 2captcha error:", (err as Error).message);
        return null;
    }
}

// ─── Token Injection ──────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function injectToken(page: any, type: CaptchaType, token: string): Promise<void> {
    await page.evaluate(
        /* javascript-obfuscator:disable */ ({ t, tok }: { t: string; tok: string }) => {
            if (t === "recaptcha-v2" || t === "recaptcha-v3") {
                const el = document.querySelector("#g-recaptcha-response") as HTMLTextAreaElement;
                if (el) {
                    el.value = tok;
                    el.style.display = "block";
                }
                // Trigger callback
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const cfg = (window as any).___grecaptcha_cfg;
                if (cfg?.clients) {
                    for (const c of Object.values(cfg.clients) as Record<string, (t: string) => void>[]) {
                        try {
                            c?.callback?.(tok);
                        } catch {
                            /* */
                        }
                    }
                }
            } else if (t === "hcaptcha") {
                const el = document.querySelector("[name='h-captcha-response']") as HTMLTextAreaElement;
                if (el) el.value = tok;
                const el2 = document.querySelector("[name='g-recaptcha-response']") as HTMLTextAreaElement;
                if (el2) el2.value = tok;
                // Trigger hCaptcha callback
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).hcaptcha?.execute?.();
            } else if (t === "turnstile") {
                const el = document.querySelector("[name='cf-turnstile-response']") as HTMLInputElement;
                if (el) el.value = tok;
            }
        },
        /* javascript-obfuscator:enable */ { t: type, tok: token },
    );
}

// ─── Turnstile: passive wait, then one real click ──
// The pass signal is the token Turnstile writes into input[name="cf-turnstile-response"]
// (light DOM). Its iframe is often inside a closed shadow root, and it stays visible
// ("Success!") after an interactive pass, so neither "no iframe" nor "iframe hidden"
// means passed. The widget box (or iframe) gives where to click.
const TURNSTILE_JS = `(() => {
  const tok = [...document.querySelectorAll('input[name="cf-turnstile-response"]')].some((e) => !!e.value);
  // The first one with a box: [id*=turnstile] also matches Cloudflare's <script id="cf-turnstile-script…">.
  const w = [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],.cf-turnstile,[data-cf-turnstile],#cf-turnstile,div[id*="turnstile" i],#challenge-stage')].find((e) => e.getBoundingClientRect().width > 30);
  const field = document.querySelector('input[name="cf-turnstile-response"]');
  const r = w && w.getBoundingClientRect();
  // An empty response field means the widget is still there even if its box can't be found.
  return { tok, present: !!w || !!field, box: r && r.width > 30 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
})()`;
type TurnstileState = { tok: boolean; present: boolean; box: { x: number; y: number; w: number; h: number } | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function turnstilePassed(page: any, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const s = (await page.evaluate(TURNSTILE_JS).catch(() => null)) as TurnstileState | null;
        if (s?.tok || (s && !s.present)) return true; // a token, or the widget went away with the page moving on
        touchBrowserActivity();
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/**
 * Real (trusted) input for the page: Playwright's own in the built-in browser, CDP
 * through the extension in the owner's Chrome (the bridge's click_at is synthetic,
 * which widgets ignore and which can't reach into their frames).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captchaDriver(page: any): CaptchaDriver | null {
    return getCurrentMode() === "chrome" ? chromeDriver(page) : playwrightDriver(page);
}

/** "passive" when Turnstile let the browser through, "click" after ticking its box, else null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function solveTurnstile(page: any): Promise<"passive" | "click" | null> {
    if (await turnstilePassed(page, 6000)) return "passive";
    const d = captchaDriver(page);
    if (!d) return null;
    const s = (await page.evaluate(TURNSTILE_JS).catch(() => null)) as TurnstileState | null;
    if (!s?.box) return null;
    // The box sits ~30px in from the widget's left edge, centred in its 65px-high strip.
    const x = s.box.x + 30;
    const y = s.box.y + Math.min(s.box.h, 65) / 2;
    await d.move(x, y, 8);
    await d.click(x, y);
    return (await turnstilePassed(page, 15000)) ? "click" : null;
}

// ─── Audio CAPTCHA Bypass (free, no API key) ──────────────────────────────
// Works on reCAPTCHA v2. Clicks the audio challenge, downloads the MP3,
// transcribes via existing transcribeBuffer() (Whisper or free Gemini),
// types the answer, and submits. Returns null on any failure so the caller
// can fall through to the next solver.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function solveAudioCaptcha(page: any): Promise<string | null> {
    try {
        console.log("  🎧 Audio CAPTCHA bypass: attempting...");

        // Audio bypass only works in Playwright mode — ChromePageProxy.frames() returns
        // only [this] (the main page), so the reCAPTCHA bframe will never be found.
        if (getCurrentMode() === "chrome") {
            console.log("  🎧 Audio CAPTCHA: not supported in Chrome extension mode (no frame access)");
            return null;
        }

        // Find the reCAPTCHA bframe (the interactive challenge iframe)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const frames: any[] = typeof page.frames === "function" ? page.frames() : [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rcFrame = frames.find(
            (f: any) =>
                typeof f.url === "function" &&
                (f.url().includes("google.com/recaptcha") || f.url().includes("recaptcha.net/recaptcha")),
        );
        if (!rcFrame) {
            console.log("  🎧 Audio CAPTCHA: reCAPTCHA frame not found");
            return null;
        }

        // Switch to audio challenge if currently on image challenge
        const audioBtn = rcFrame.locator("#recaptcha-audio-button");
        const audioBtnVisible = await audioBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (audioBtnVisible) {
            await audioBtn.click();
            await new Promise((r) => setTimeout(r, 1200));
        }

        // Wait for audio source element to appear
        const audioSource = rcFrame.locator("#audio-source");
        const audioVisible = await audioSource.isVisible({ timeout: 4000 }).catch(() => false);
        if (!audioVisible) {
            // May already be showing audio challenge — check for the response input
            const inputVisible = await rcFrame
                .locator("#audio-response")
                .isVisible({ timeout: 1500 })
                .catch(() => false);
            if (!inputVisible) {
                console.log("  🎧 Audio CAPTCHA: audio source not found (blocked or rate limited)");
                return null;
            }
        }

        // Extract the audio MP3 URL from the iframe
        const audioUrl: string | null = await rcFrame.evaluate(
            /* javascript-obfuscator:disable */ (): string | null => {
                const src = (document.querySelector("#audio-source") as HTMLSourceElement)?.src;
                return src || null;
            },
            /* javascript-obfuscator:enable */ undefined,
        );
        if (!audioUrl) {
            console.log("  🎧 Audio CAPTCHA: could not extract audio URL");
            return null;
        }
        console.log(`  🎧 Audio CAPTCHA: downloading audio...`);

        // Download the MP3 buffer from within the browser context (avoids CORS)
        const audioBytes: number[] | null = await page.evaluate(
            /* javascript-obfuscator:disable */ async (url: string): Promise<number[] | null> => {
                try {
                    const resp = await fetch(url);
                    if (!resp.ok) return null;
                    const ab = await resp.arrayBuffer();
                    return Array.from(new Uint8Array(ab));
                } catch {
                    return null;
                }
            },
            /* javascript-obfuscator:enable */ audioUrl,
        );

        if (!audioBytes || audioBytes.length === 0) {
            console.log("  🎧 Audio CAPTCHA: audio download failed");
            return null;
        }

        const audioBuffer = Buffer.from(audioBytes);
        console.log(`  🎧 Audio CAPTCHA: transcribing ${audioBuffer.length} bytes...`);

        // Transcribe — uses Whisper (if OPENAI_API_KEY/GROQ_API_KEY) or free Gemini (existing Convex proxy)
        const rawTranscript = await transcribeBuffer(audioBuffer, "captcha_audio.mp3").catch(() => "");
        if (!rawTranscript) {
            console.log("  🎧 Audio CAPTCHA: transcription returned empty");
            return null;
        }

        // Clean: reCAPTCHA audio uses spoken digits/words separated by spaces
        const answer = rawTranscript
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, "")
            .trim();
        if (!answer) {
            console.log("  🎧 Audio CAPTCHA: cleaned transcript empty");
            return null;
        }
        console.log(`  🎧 Audio CAPTCHA: answer = "${answer}"`);

        // Type answer into the audio response input
        const responseInput = rcFrame.locator("#audio-response");
        const inputReady = await responseInput.isVisible({ timeout: 2000 }).catch(() => false);
        if (!inputReady) {
            console.log("  🎧 Audio CAPTCHA: response input not visible");
            return null;
        }
        await responseInput.fill(answer);
        await new Promise((r) => setTimeout(r, 300));

        // Submit
        await rcFrame.locator("#recaptcha-verify-button").click();
        await new Promise((r) => setTimeout(r, 1500));

        // Check success: reCAPTCHA sets #g-recaptcha-response token on success
        const token: string | null = await page.evaluate(
            /* javascript-obfuscator:disable */ (): string | null => {
                const el = document.querySelector("#g-recaptcha-response") as HTMLTextAreaElement | null;
                return el?.value || null;
            },
            /* javascript-obfuscator:enable */ undefined,
        );

        if (token) {
            console.log("  🎧 Audio CAPTCHA: SOLVED via audio bypass ✓");
            return token;
        }

        console.log("  🎧 Audio CAPTCHA: verify did not produce token (wrong answer or blocked)");
        return null;
    } catch (err) {
        console.log(`  🎧 Audio CAPTCHA: error — ${(err as Error).message}`);
        return null;
    }
}

// ─── NoCaptchaAI (token solver — set NOCAPTCHAAI_API_KEY) ────────────────
// Its token API only covers Turnstile; hCaptcha/reCAPTCHA are image-grid tasks there.
// ponytail: Turnstile only, add ReCaptchaV2Image/PopularCaptchaImage grid solving if those sites matter.

const NOCAPTCHA_TYPE_MAP: Partial<Record<CaptchaType, string>> = {
    turnstile: "AntiTurnstileTaskProxyLess",
};

export async function solveViaNoCaptchaAI(type: CaptchaType, siteKey: string, pageUrl: string): Promise<string | null> {
    const apiKey = process.env.NOCAPTCHAAI_API_KEY;
    if (!apiKey) return null;

    const taskType = NOCAPTCHA_TYPE_MAP[type];
    if (!taskType) return null;

    try {
        const taskBody = { type: taskType, websiteURL: pageUrl, websiteKey: siteKey };
        const submitRes = await fetch("https://api.nocaptchaai.com/createTask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, task: taskBody }),
        });
        if (!submitRes.ok) {
            console.warn(`  ⚠️ NoCaptchaAI submit HTTP ${submitRes.status}`);
            return null;
        }
        const submitData = (await submitRes.json()) as {
            errorId?: number;
            taskId?: string;
            error?: string;
            errorDescription?: string;
        };
        if (submitData.errorId) {
            console.warn(
                `  ⚠️ NoCaptchaAI submit error: ${submitData.errorDescription ?? submitData.error ?? submitData.errorId}`,
            );
            return null;
        }
        const taskId = submitData.taskId;
        if (!taskId) return null;

        // Poll for result (max 120s, 3s intervals)
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const pollRes = await fetch("https://api.nocaptchaai.com/getTaskResult", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clientKey: apiKey, taskId }),
            });
            if (!pollRes.ok) continue;
            const pollData = (await pollRes.json()) as {
                status?: string;
                solution?: { token?: string };
                errorId?: number;
            };
            if (pollData.status === "ready") {
                const token = pollData.solution?.token;
                if (token) {
                    console.log(`  🟢 NoCaptchaAI: solved ${type} (${(i + 1) * 3}s)`);
                    return token;
                }
            }
            if (pollData.status === "failed" || (pollData.errorId && pollData.errorId > 0)) {
                console.warn(`  ⚠️ NoCaptchaAI: task failed`);
                return null;
            }
        }
        console.warn("  ⚠️ NoCaptchaAI: timeout waiting for solution");
        return null;
    } catch (err) {
        console.warn(`  ⚠️ NoCaptchaAI error: ${(err as Error).message}`);
        return null;
    }
}

// ─── NopeCHA (free tier: 100 solves/day, no signup) ──────────────────────
// Handles reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.
// Set NOPECHA_API_KEY env var (get from nopecha.com — free plan available).

const NOPECHA_TYPE_MAP: Partial<Record<CaptchaType, string>> = {
    "recaptcha-v2": "recaptchav2",
    "recaptcha-v3": "recaptchav3",
    hcaptcha: "hcaptcha",
    turnstile: "turnstile",
};

async function solveViaNopeCHA(type: CaptchaType, siteKey: string, pageUrl: string): Promise<string | null> {
    const apiKey = process.env.NOPECHA_API_KEY;
    if (!apiKey) return null;

    const nopechaType = NOPECHA_TYPE_MAP[type];
    if (!nopechaType) return null;

    try {
        // Submit task
        const submitRes = await fetch("https://api.nopecha.com/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: nopechaType, sitekey: siteKey, url: pageUrl, key: apiKey }),
        });
        if (!submitRes.ok) {
            console.warn(`  ⚠️ NopeCHA submit HTTP error: ${submitRes.status}`);
            return null;
        }
        const submitData = (await submitRes.json()) as { id?: string; error?: number; data?: string };
        // error === 0 means success in some NopeCHA response variants — only abort on non-zero
        if (submitData.error !== undefined && submitData.error !== 0) {
            console.warn(`  ⚠️ NopeCHA submit error: ${submitData.error}`);
            return null;
        }
        // NopeCHA may return the token immediately or via poll
        if (submitData.data && typeof submitData.data === "string") return submitData.data;

        const taskId = submitData.id;
        if (!taskId) return null;

        // Poll for result (max 60s, 3s intervals)
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const pollRes = await fetch(`https://api.nopecha.com/?key=${apiKey}&id=${taskId}`);
            if (!pollRes.ok) {
                console.warn(`  ⚠️ NopeCHA poll HTTP error: ${pollRes.status}`);
                return null;
            }
            const pollData = (await pollRes.json()) as { error?: number; data?: string };
            if (pollData.error === 10) continue; // not ready yet
            // error === 0 is success; only abort on non-zero, non-10 codes
            if (pollData.error !== undefined && pollData.error !== 0 && pollData.error !== 10) {
                console.warn(`  ⚠️ NopeCHA poll error: ${pollData.error}`);
                return null;
            }
            if (pollData.data && typeof pollData.data === "string") {
                console.log(`  🟢 NopeCHA: solved ${type} (${i * 3 + 3}s)`);
                return pollData.data;
            }
        }
        console.warn("  ⚠️ NopeCHA: timeout waiting for solution");
        return null;
    } catch (err) {
        console.warn(`  ⚠️ NopeCHA error: ${(err as Error).message}`);
        return null;
    }
}

// ─── Main CAPTCHA Handler ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleCaptchaIfPresent(
    page: any,
    opts: { signal?: AbortSignal } = {},
): Promise<{ handled: boolean; type: CaptchaType; method: string }> {
    // Ensure CAPTCHA keys are loaded from Convex (if not already in process.env)
    await ensureCaptchaKeys();

    const info = await detectCaptcha(page);
    if (info.type === "none") return { handled: true, type: "none", method: "none" };
    if (await captchaSolved(page)) return { handled: true, type: info.type, method: "already_solved" };

    console.log(`  🤖 CAPTCHA detected: ${info.type} (sitekey: ${info.siteKey?.substring(0, 20) ?? "unknown"})`);

    // ── Tier 1: Turnstile: a passive pass (common with good stealth), else one real click ──
    if (info.type === "turnstile") {
        const how = await solveTurnstile(page);
        if (how)
            return {
                handled: true,
                type: "turnstile",
                method: how === "passive" ? "passive_stealth" : "turnstile_click",
            };
    }

    // ── Form-style checks: read the image / question with the vision models and fill it in ──
    if (
        info.type === "image-text" ||
        info.type === "text-question" ||
        info.type === "click-image" ||
        info.type === "rotate"
    ) {
        const driver = captchaDriver(page);
        const { solveFormCaptcha } = await import("./captcha-forms.js");
        const solved =
            !!driver &&
            (await solveFormCaptcha(page, info.type, driver).catch((e: unknown) => {
                console.warn(`  🧩 CAPTCHA (${info.type}) solver failed: ${(e as Error)?.message ?? e}`);
                return false;
            }));
        if (solved) {
            return { handled: true, type: info.type, method: "vision_form" };
        }
        return { handled: false, type: info.type, method: "unsolved" };
    }
    // A vendor Bhai can't solve: straight to the owner.
    if (info.type === "other") return { handled: false, type: info.type, method: "unsolved" };

    // ── Tier 2: reCAPTCHA v2 audio bypass (free, no API key needed) ──────────
    if (info.type === "recaptcha-v2") {
        const token = await solveAudioCaptcha(page);
        if (token) {
            // Do NOT call injectToken here — the audio path has reCAPTCHA verify its own
            // answer and populate #g-recaptcha-response + fire the callback itself.
            // Calling injectToken again would double-fire the callback, risking double-submit.
            return { handled: true, type: "recaptcha-v2", method: "audio_bypass" };
        }
    }

    // ── Tier 3: picture grid via vision models (built-in browser or the owner's Chrome) ──
    if (info.type === "hcaptcha" || info.type === "recaptcha-v2") {
        const driver = captchaDriver(page) ?? undefined;
        if (driver && (await solveWithVision(page, captchaSolved, { signal: opts.signal, driver }))) {
            return { handled: true, type: info.type, method: "vision" };
        }
    }

    // ── Tier 4: NoCaptchaAI (set NOCAPTCHAAI_API_KEY) ─────────────────────────
    if (info.siteKey && process.env.NOCAPTCHAAI_API_KEY) {
        const token = await solveViaNoCaptchaAI(info.type, info.siteKey, page.url());
        if (token) {
            await injectToken(page, info.type, token);
            return { handled: true, type: info.type, method: "nocaptchaai" };
        }
    }

    // ── Tier 5: NopeCHA (free 100/day — set NOPECHA_API_KEY) ─────────────────
    if (info.siteKey && process.env.NOPECHA_API_KEY) {
        const token = await solveViaNopeCHA(info.type, info.siteKey, page.url());
        if (token) {
            await injectToken(page, info.type, token);
            return { handled: true, type: info.type, method: "nopecha" };
        }
    }

    // ── Tier 6: 2captcha (paid fallback — set CAPTCHA_API_KEY or TWO_CAPTCHA_API_KEY) ──
    if (info.siteKey && (process.env.CAPTCHA_API_KEY || process.env.TWO_CAPTCHA_API_KEY)) {
        const token = await solve2captcha(info.type, info.siteKey, page.url());
        if (token) {
            await injectToken(page, info.type, token);
            return { handled: true, type: info.type, method: "2captcha" };
        }
    }

    // Unsolved: the tool handler hands it to the owner (human-handoff.ts).
    return { handled: false, type: info.type, method: "unsolved" };
}

// ─── Tool Definition ──────────────────────────

const TOOL_BUDGET_S = 570; // solvers plus the owner's wait: under ~10 min in all

export const browserHandleCaptcha: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_handle_captcha",
            description:
                "Hand a CAPTCHA / human-verification check on the current page (\"I'm not a robot\", hCaptcha, reCAPTCHA, Cloudflare Turnstile) to Bhai's separate CAPTCHA pipeline, which the owner set up for this. You don't solve or click the check yourself: call this, the pipeline completes it with its own models (Turnstile wait and click, reCAPTCHA audio, picture grids and drag puzzles read by vision, solver APIs) and gives control back to you. On success, continue the original task from the step you were on. Only if the pipeline can't does it hand the check to the owner: it brings the tab up, messages them on this channel and waits (up to ~5 min). If it returns requires_user:true, do NOT call it again in a loop: tell the owner the page is still waiting on them.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    async handler(input) {
        const start = Date.now();
        try {
            const page = await getActivePage();
            const signal = input._signal as AbortSignal | undefined;
            const result = await handleCaptchaIfPresent(page, { signal });
            if (result.type === "none") {
                return JSON.stringify({ success: true, captcha_present: false });
            }
            if (result.handled) {
                return JSON.stringify({
                    success: true,
                    captcha_present: true,
                    captcha_type: result.type,
                    method: result.method,
                    message: `CAPTCHA solved via ${result.method}. Continue the task.`,
                });
            }
            // Lazy: human-handoff.ts imports this module.
            const { browserWaitForHuman } = await import("./human-handoff.js");
            // The owner's wait: BHAI_CAPTCHA_HANDOFF_MS when set, never past the pipeline's budget.
            const left = Math.floor(TOOL_BUDGET_S - (Date.now() - start) / 1000);
            const configured = Number(process.env.BHAI_CAPTCHA_HANDOFF_MS) / 1000;
            const timeout_s = configured > 0 ? Math.min(left, configured) : left;
            const out = JSON.parse(await browserWaitForHuman.handler({ timeout_s, _signal: signal }));
            return JSON.stringify({
                ...out,
                captcha_present: true,
                captcha_type: result.type,
                method: "human",
                auto_solve: "failed",
            });
        } catch (err) {
            return JSON.stringify({ error: `CAPTCHA handler failed: ${(err as Error).message}` });
        }
    },
};
