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
                return { type: result.kind as CaptchaType, siteKey: null }; // siteKey resolved by full JS eval below only if needed
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

// ─── Main CAPTCHA Handler ─────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleCaptchaIfPresent(page: any): Promise<{ handled: boolean; type: CaptchaType; method: string }> {
    const info = await detectCaptcha(page);
    if (info.type === "none") return { handled: true, type: "none", method: "none" };

    console.log(`  🤖 CAPTCHA detected: ${info.type} (sitekey: ${info.siteKey?.substring(0, 20) ?? "unknown"})`);

    // Turnstile: try passive first (stealth setup often auto-passes it)
    if (info.type === "turnstile") {
        const passed = await waitForTurnstilePassive(page, 20000);
        if (passed) return { handled: true, type: "turnstile", method: "passive_stealth" };
    }

    // Solve via 2captcha if we have a siteKey and API key
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
            description: "Detect and solve CAPTCHA challenges on the current page. Supports Cloudflare Turnstile (tries passive stealth first), reCAPTCHA v2/v3, and hCaptcha (requires CAPTCHA_API_KEY env var for automated solving). Call this when a page is blocked by a CAPTCHA before proceeding.",
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
                    : { message: "CAPTCHA detected but could not be solved automatically. Set CAPTCHA_API_KEY env var to enable 2captcha solving, or solve manually." }
                ),
            });
        } catch (err) {
            return JSON.stringify({ error: `CAPTCHA handler failed: ${(err as Error).message}` });
        }
    },
};
