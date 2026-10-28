// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
import { getActiveExtensionTab, sendBridgeCommand } from "./chrome-bridge.js";
import { ATLAS_HUD_JS, getActivePage, touchBrowserActivity } from "./core.js";
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

export type CaptchaType = "recaptcha-v2" | "recaptcha-v3" | "hcaptcha" | "turnstile" | "none";

// ─── Convex-backed key loader ─────────────────────────────────────────────
// CAPTCHA API keys are stored as Convex environment variables (never bundled
// into the app). Fetched lazily on first use and cached in process.env.
let _captchaKeysFetched = false;
let _captchaKeysFetchInFlight: Promise<void> | null = null;

async function ensureCaptchaKeys(): Promise<void> {
    if (_captchaKeysFetched) return;
    // Skip Convex fetch if any solving key already present locally
    if (process.env.NOPECHA_API_KEY || process.env.CAPTCHA_API_KEY || process.env.TWO_CAPTCHA_API_KEY) {
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
            if (result.kind === "none" && result.confidence === 0) {
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
            // Any other reCAPTCHA widget (invisible v2, a challenge frame)
            if (rcFrames.length || rcWidget) return rcV2;
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

export const CAPTCHA_HINT =
    "A human-verification check (CAPTCHA) is on this page. Don't tick or solve it yourself: call browser_wait_for_human so the owner can do it, then continue the task.";

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

// ─── Turnstile: try passive wait first ────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForTurnstilePassive(page: any, timeoutMs = 25000): Promise<boolean> {
    try {
        // With good stealth, Cloudflare Turnstile often auto-passes without any interaction
        await page.waitForFunction(
            /* javascript-obfuscator:disable */ () => {
                const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                if (!frame) return true; // no Turnstile present
                const s = window.getComputedStyle(frame as Element);
                // Frame becomes hidden when challenge passes
                return s.display === "none" || s.visibility === "hidden" || s.opacity === "0";
            },
            /* javascript-obfuscator:enable */ undefined, // Playwright signature is (fn, arg, options)
            { timeout: timeoutMs, polling: 1000 },
        );
        return true;
    } catch {
        return false;
    }
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
): Promise<{ handled: boolean; type: CaptchaType; method: string }> {
    // Ensure CAPTCHA keys are loaded from Convex (if not already in process.env)
    await ensureCaptchaKeys();

    const info = await detectCaptcha(page);
    if (info.type === "none") return { handled: true, type: "none", method: "none" };

    console.log(`  🤖 CAPTCHA detected: ${info.type} (sitekey: ${info.siteKey?.substring(0, 20) ?? "unknown"})`);

    // ── Tier 1: Turnstile passive stealth (often auto-passes with good stealth) ──
    if (info.type === "turnstile") {
        const passed = await waitForTurnstilePassive(page, 20000);
        if (passed) return { handled: true, type: "turnstile", method: "passive_stealth" };
    }

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

    // ── Tier 3: NopeCHA (free 100/day — set NOPECHA_API_KEY) ─────────────────
    if (info.siteKey && process.env.NOPECHA_API_KEY) {
        const token = await solveViaNopeCHA(info.type, info.siteKey, page.url());
        if (token) {
            await injectToken(page, info.type, token);
            return { handled: true, type: info.type, method: "nopecha" };
        }
    }

    // ── Tier 4: 2captcha (paid fallback — set CAPTCHA_API_KEY or TWO_CAPTCHA_API_KEY) ──
    if (info.siteKey && (process.env.CAPTCHA_API_KEY || process.env.TWO_CAPTCHA_API_KEY)) {
        const token = await solve2captcha(info.type, info.siteKey, page.url());
        if (token) {
            await injectToken(page, info.type, token);
            return { handled: true, type: info.type, method: "2captcha" };
        }
    }

    // ── Tier 5: human handoff — surface the page and wait for the user ──
    if (await handOffToHuman(page)) return { handled: true, type: info.type, method: "human" };

    return { handled: false, type: info.type, method: "unsolved" };
}

// ─── Human Handoff ────────────────────────────

/**
 * Poll the detector until the CAPTCHA is gone or timeoutMs elapses. Detection
 * errors (page mid-navigation right after the user solves) count as "not yet".
 */
export async function waitForCaptchaCleared(
    page: unknown,
    timeoutMs: number,
    intervalMs = 2000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detect: (page: any) => Promise<CaptchaInfo> = detectCaptcha,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        touchBrowserActivity(); // keep the idle-close timer from killing the browser mid-wait
        await new Promise((r) => setTimeout(r, intervalMs));
        const info = await detect(page).catch(() => null);
        if (info?.type === "none") return true;
    }
    return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handOffToHuman(page: any): Promise<boolean> {
    const raw = process.env.ATLAS_CAPTCHA_HANDOFF_MS;
    const timeoutMs = raw ? Number(raw) : 300_000;
    if (!(timeoutMs > 0)) return false; // ATLAS_CAPTCHA_HANDOFF_MS=0 disables the handoff

    console.log(`  🙋 CAPTCHA: handing off to user (waiting up to ${Math.round(timeoutMs / 1000)}s)`);
    try {
        if (getCurrentMode() === "chrome") {
            const tab = await getActiveExtensionTab();
            if (tab?.id) await sendBridgeCommand("switch_tab", { tabId: tab.id, focus: true });
        } else {
            await page.bringToFront?.();
        }
    } catch {
        /* best effort */
    }
    const banner = (label: string, done: boolean) =>
        page.evaluate(`(${ATLAS_HUD_JS})(${JSON.stringify({ label, done, maxWidth: 460 })})`).catch(() => {});
    await banner("⏸ Bhai paused — please solve the CAPTCHA, I'll continue automatically", false);
    import("../platform-bridge.js")
        .then(({ showNotification }) =>
            showNotification(
                "Bhai needs your help",
                "Please solve the CAPTCHA in the browser — I'll continue automatically.",
            ),
        )
        .catch(() => {});

    const cleared = await waitForCaptchaCleared(page, timeoutMs);
    await banner("", true);
    console.log(`  🙋 CAPTCHA handoff: ${cleared ? "cleared by user ✓" : "timed out"}`);
    return cleared;
}

// ─── Tool Definition ──────────────────────────

export const browserHandleCaptcha: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_handle_captcha",
            description:
                "Detect and solve CAPTCHA challenges on the current page. Waterfall: 1) Cloudflare Turnstile — passive wait; 2) reCAPTCHA v2 — audio challenge; 3) NopeCHA API (NOPECHA_API_KEY); 4) 2captcha API (CAPTCHA_API_KEY); 5) if all fail, hands off to the user — brings the page to the front, notifies them, and waits (up to ~5 min) until they solve it, then returns success with method 'human'. If it returns requires_user:true, do NOT retry — tell the user the page needs a manual CAPTCHA solve. Call this when a page is blocked by a CAPTCHA before proceeding.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    async handler() {
        try {
            const page = await getActivePage();
            const result = await handleCaptchaIfPresent(page);
            if (result.type === "none") {
                return JSON.stringify({ success: true, captcha_present: false });
            }
            if (result.handled) {
                return JSON.stringify({
                    success: true,
                    captcha_present: true,
                    captcha_type: result.type,
                    method: result.method,
                    message: `CAPTCHA solved via ${result.method}. You may now proceed.`,
                });
            }
            // `error` makes the agent loop count this as a failure; requires_user
            // tells it retrying won't help.
            return JSON.stringify({
                success: false,
                error: `CAPTCHA (${result.type}) not solved: automatic solvers failed and the user did not solve it in time.`,
                requires_user: true,
                captcha_present: true,
                captcha_type: result.type,
                method: result.method,
                message:
                    "Stop retrying this page. Ask the user to solve the CAPTCHA in the browser, then continue. (Auto-solving needs NOPECHA_API_KEY or CAPTCHA_API_KEY.)",
            });
        } catch (err) {
            return JSON.stringify({ error: `CAPTCHA handler failed: ${(err as Error).message}` });
        }
    },
};
