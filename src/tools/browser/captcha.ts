// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── CAPTCHA Detection & Solving ───────────────
// Detects CAPTCHA type, solves via 2captcha API (CAPTCHA_API_KEY env var),
// and injects the token. Falls back gracefully if no API key is set.
// Supports: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.

import type { ToolDefinition } from "../get-current-time.js";
import { getActivePage } from "./core.js";
import { isNativeBrowserAvailable } from "./native-browser.js";
import { transcribeBuffer } from "../../voice/transcribe.js";
import { getCurrentMode } from "./browser-backend.js";

// Try to use Rust-native CAPTCHA classifier for speed
let nativeClassifyCaptcha: ((html: string) => { kind: string; confidence: number }) | null = null;
try {
    const { createRequire } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const require = createRequire(import.meta.url);
    const mod = require(path.default.join(process.cwd(), "native", "index.js")) as Record<string, unknown>;
    if (typeof mod.classifyCaptcha === "function") {
        nativeClassifyCaptcha = mod.classifyCaptcha as (html: string) => { kind: string; confidence: number };
    }
} catch { /* native not available */ }

export type CaptchaType = "recaptcha-v2" | "recaptcha-v3" | "hcaptcha" | "turnstile" | "none";

// ─── Convex-backed key loader ─────────────────────────────────────────────
// CAPTCHA API keys are stored as Convex environment variables (never bundled
// into the app). Fetched lazily on first use and cached in process.env.
let _captchaKeysFetched = false;
let _captchaKeysFetchInFlight: Promise<void> | null = null;

async function ensureCaptchaKeys(): Promise<void> {
    if (_captchaKeysFetched) return;
    // Skip Convex fetch if either key already present — no need to make a network round-trip
    if (process.env.NOPECHA_API_KEY || process.env.CAPTCHA_API_KEY) { _captchaKeysFetched = true; return; }
    // Deduplicate concurrent calls — return the same in-flight promise to all callers
    if (_captchaKeysFetchInFlight) return _captchaKeysFetchInFlight;
    _captchaKeysFetchInFlight = (async () => {
        // Node.js is single-threaded: the check above and the finally below are
        // atomic w.r.t. the event loop — no true TOCTOU race is possible here.
        try {
        const { getConvexSiteUrl } = await import("../../config/keys.js");
        const { getSessionToken } = await import("../../session.js");
            const convexUrl = getConvexSiteUrl();
            const sessionToken = await getSessionToken().catch(() => null);
            if (!convexUrl || !sessionToken) return;
            const resp = await fetch(`${convexUrl}/api/config/secrets`, {
                headers: { Authorization: `Bearer ${sessionToken}` },
            });
            if (!resp.ok) return;
            const secrets = await resp.json() as Record<string, string>;
            if (secrets.NOPECHA_API_KEY && !process.env.NOPECHA_API_KEY) {
                process.env.NOPECHA_API_KEY = secrets.NOPECHA_API_KEY;
                console.log("  🔑 CAPTCHA: NOPECHA_API_KEY loaded from Convex");
            }
            if (secrets.CAPTCHA_API_KEY && !process.env.CAPTCHA_API_KEY) {
                process.env.CAPTCHA_API_KEY = secrets.CAPTCHA_API_KEY;
                console.log("  🔑 CAPTCHA: CAPTCHA_API_KEY loaded from Convex");
            }
        } catch { /* non-fatal — keys may still be available via process.env */ }
        finally { _captchaKeysFetched = true; _captchaKeysFetchInFlight = null; }
    })();
    return _captchaKeysFetchInFlight;
}

export interface CaptchaInfo {
    type: CaptchaType;
    siteKey: string | null;
}

// ─── Detection ────────────────────────────────

export async function detectCaptcha(page: ReturnType<typeof getActivePage> extends Promise<infer P> ? P : never): Promise<CaptchaInfo> {
    // Fast Rust pre-check: scan raw HTML for CAPTCHA signals before running JS
    if (nativeClassifyCaptcha) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const html = await (page as any).evaluate(() => document.documentElement.innerHTML.substring(0, 50000)) as string;
            const result = nativeClassifyCaptcha(html);
            if (result.kind !== "none" && result.confidence > 0.7) {
                console.log(`  🦀 Rust CAPTCHA classifier: ${result.kind} (confidence ${result.confidence.toFixed(2)})`);
                // siteKey is null here by design — the Rust classifier only reads raw HTML
                // and cannot safely extract dynamic sitekeys (they may be injected by JS).
                // Tiers requiring siteKey (NopeCHA, 2captcha) will skip; audio bypass and
                // Turnstile passive stealth work without it and are the preferred free paths.
                return { type: result.kind as CaptchaType, siteKey: null };
            }
            if (result.kind === "none" && result.confidence === 0) {
                return { type: "none", siteKey: null }; // definitively no CAPTCHA
            }
        } catch { /* fall through to JS eval */ }
    }

    // Full JS evaluate for siteKey extraction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (page as any).evaluate((): { type: string; siteKey: string | null } => {
        // Cloudflare Turnstile
        const tsFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        const tsWidget = document.querySelector('[class*="cf-turnstile"],[data-cf-turnstile]');
        if (tsFrame || tsWidget) {
            const src = tsFrame?.getAttribute("src") ?? "";
            const key = src.match(/[?&]sitekey=([^&]+)/)?.[1]
                ?? (tsWidget as HTMLElement)?.dataset?.sitekey ?? null;
            return { type: "turnstile", siteKey: key };
        }
        // hCaptcha
        const hcFrame = document.querySelector('iframe[src*="hcaptcha.com"]');
        const hcWidget = document.querySelector(".h-captcha,[data-hcaptcha-widget-id]");
        if (hcFrame || hcWidget) {
            return { type: "hcaptcha", siteKey: (hcWidget as HTMLElement)?.dataset?.sitekey ?? null };
        }
        // reCAPTCHA v3 (invisible — detected by script tag)
        const scripts = Array.from(document.scripts).map(s => s.src);
        const rcV3 = scripts.find(s => s.includes("recaptcha/api.js?render="));
        if (rcV3) {
            return { type: "recaptcha-v3", siteKey: rcV3.match(/render=([^&]+)/)?.[1] ?? null };
        }
        // reCAPTCHA v2
        const rcFrame = document.querySelector('iframe[src*="google.com/recaptcha"],iframe[src*="recaptcha.net"]');
        const rcWidget = document.querySelector(".g-recaptcha");
        if (rcFrame || rcWidget) {
            return { type: "recaptcha-v2", siteKey: (rcWidget as HTMLElement)?.dataset?.sitekey ?? null };
        }
        return { type: "none", siteKey: null };
    });
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
        params = { ...params, method: "userrecaptcha", googlekey: siteKey, pageurl: pageUrl, version: "v3", action: "submit", min_score: "0.7" };
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
        const submitData = await submitRes.json() as { status: number; request: string };
        if (submitData.status !== 1) { console.warn("  ⚠️ 2captcha submit failed:", submitData.request); return null; }
        const taskId = submitData.request;

        // Poll for result (max 120s)
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
            const pollData = await pollRes.json() as { status: number; request: string };
            if (pollData.status === 1) return pollData.request;
            if (pollData.request !== "CAPCHA_NOT_READY") { console.warn("  ⚠️ 2captcha poll error:", pollData.request); return null; }
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
    await page.evaluate(({ t, tok }: { t: string; tok: string }) => {
        if (t === "recaptcha-v2" || t === "recaptcha-v3") {
            const el = document.querySelector("#g-recaptcha-response") as HTMLTextAreaElement;
            if (el) { el.value = tok; el.style.display = "block"; }
            // Trigger callback
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cfg = (window as any).___grecaptcha_cfg;
            if (cfg?.clients) {
                for (const c of Object.values(cfg.clients) as Record<string, (t: string) => void>[]) {
                    try { c?.callback?.(tok); } catch { /* */ }
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
    }, { t: type, tok: token });
}

// ─── Turnstile: try passive wait first ────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForTurnstilePassive(page: any, timeoutMs = 25000): Promise<boolean> {
    try {
        // With good stealth, Cloudflare Turnstile often auto-passes without any interaction
        await page.waitForFunction(
            () => {
                const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                if (!frame) return true; // no Turnstile present
                const s = window.getComputedStyle(frame as Element);
                // Frame becomes hidden when challenge passes
                return s.display === "none" || s.visibility === "hidden" || s.opacity === "0";
            },
            { timeout: timeoutMs, polling: 1000 }
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
        const rcFrame = frames.find((f: any) =>
            typeof f.url === "function" && (
                f.url().includes("google.com/recaptcha") ||
                f.url().includes("recaptcha.net/recaptcha")
            )
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
            await new Promise(r => setTimeout(r, 1200));
        }

        // Wait for audio source element to appear
        const audioSource = rcFrame.locator("#audio-source");
        const audioVisible = await audioSource.isVisible({ timeout: 4000 }).catch(() => false);
        if (!audioVisible) {
            // May already be showing audio challenge — check for the response input
            const inputVisible = await rcFrame.locator("#audio-response").isVisible({ timeout: 1500 }).catch(() => false);
            if (!inputVisible) {
                console.log("  🎧 Audio CAPTCHA: audio source not found (blocked or rate limited)");
                return null;
            }
        }

        // Extract the audio MP3 URL from the iframe
        const audioUrl: string | null = await rcFrame.evaluate((): string | null => {
            const src = (document.querySelector("#audio-source") as HTMLSourceElement)?.src;
            return src || null;
        });
        if (!audioUrl) {
            console.log("  🎧 Audio CAPTCHA: could not extract audio URL");
            return null;
        }
        console.log(`  🎧 Audio CAPTCHA: downloading audio...`);

        // Download the MP3 buffer from within the browser context (avoids CORS)
        const audioBytes: number[] | null = await page.evaluate(async (url: string): Promise<number[] | null> => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) return null;
                const ab = await resp.arrayBuffer();
                return Array.from(new Uint8Array(ab));
            } catch { return null; }
        }, audioUrl);

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
        const answer = rawTranscript.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
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
        await new Promise(r => setTimeout(r, 300));

        // Submit
        await rcFrame.locator("#recaptcha-verify-button").click();
        await new Promise(r => setTimeout(r, 1500));

        // Check success: reCAPTCHA sets #g-recaptcha-response token on success
        const token: string | null = await page.evaluate((): string | null => {
            const el = document.querySelector("#g-recaptcha-response") as HTMLTextAreaElement | null;
            return el?.value || null;
        });

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
    "hcaptcha": "hcaptcha",
    "turnstile": "turnstile",
};

async function solveViaNopeCHA(
    type: CaptchaType,
    siteKey: string,
    pageUrl: string,
): Promise<string | null> {
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
        const submitData = await submitRes.json() as { id?: string; error?: number; data?: string };
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
            await new Promise(r => setTimeout(r, 3000));
            const pollRes = await fetch(`https://api.nopecha.com/?key=${apiKey}&id=${taskId}`);
            if (!pollRes.ok) { console.warn(`  ⚠️ NopeCHA poll HTTP error: ${pollRes.status}`); return null; }
            const pollData = await pollRes.json() as { error?: number; data?: string };
            if (pollData.error === 10) continue; // not ready yet
            // error === 0 is success; only abort on non-zero, non-10 codes
            if (pollData.error !== undefined && pollData.error !== 0 && pollData.error !== 10) {
                console.warn(`  ⚠️ NopeCHA poll error: ${pollData.error}`); return null;
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
export async function handleCaptchaIfPresent(page: any): Promise<{ handled: boolean; type: CaptchaType; method: string }> {
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

    // ── Tier 4: 2captcha (paid fallback — set CAPTCHA_API_KEY) ───────────────
    if (info.siteKey && process.env.CAPTCHA_API_KEY) {
        const token = await solve2captcha(info.type, info.siteKey, page.url());
        if (token) {
            await injectToken(page, info.type, token);
            return { handled: true, type: info.type, method: "2captcha" };
        }
    }

    return { handled: false, type: info.type, method: "unsolved" };
}

// ─── Tool Definition ──────────────────────────

export const browserHandleCaptcha: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_handle_captcha",
            description: "Detect and solve CAPTCHA challenges on the current page. Solving waterfall (all automatic): 1) Cloudflare Turnstile — passive stealth bypass; 2) reCAPTCHA v2 — free audio challenge bypass (no API key needed); 3) All types — NopeCHA free API (set NOPECHA_API_KEY in Convex, 100 free solves/day); 4) All types — 2captcha paid fallback (set CAPTCHA_API_KEY in Convex). Call this when a page is blocked by a CAPTCHA before proceeding.",
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
            return JSON.stringify({
                success: result.handled,
                captcha_present: true,
                captcha_type: result.type,
                method: result.method,
                ...(result.handled
                    ? { message: `CAPTCHA solved via ${result.method}. You may now proceed.` }
                    : { message: "CAPTCHA detected but could not be solved automatically. reCAPTCHA v2 audio bypass was attempted (free, no key needed). To enable full solving: set NOPECHA_API_KEY (free 100/day, nopecha.com) or CAPTCHA_API_KEY (2captcha, paid). Solve manually if needed." }
                ),
            });
        } catch (err) {
            return JSON.stringify({ error: `CAPTCHA handler failed: ${(err as Error).message}` });
        }
    },
};
