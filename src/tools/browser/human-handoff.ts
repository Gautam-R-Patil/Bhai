// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// browser_wait_for_human: a page shows a human-verification check (reCAPTCHA,
// hCaptcha, Turnstile, a Cloudflare interstitial). Bhai never ticks or solves
// it. It brings the tab to the front, asks the owner on the channel the task
// came from (plus a desktop notification), then polls until the check is gone
// so the task carries on. Uses the detector from captcha.ts only — no solver.

import type { ToolDefinition } from "../get-current-time.js";
import { getCurrentMode } from "./browser-backend.js";
import { type CaptchaInfo, type CaptchaType, detectCaptcha } from "./captcha.js";
import { getActiveExtensionTab, isExtensionConnected, sendBridgeCommand } from "./chrome-bridge.js";
import { ATLAS_HUD_JS, getActivePage, touchBrowserActivity } from "./core.js";

export type HandoffOutcome = "cleared" | "timeout" | "cancelled";

// Where the page is and whether the widget already holds a response token
// (a ticked reCAPTCHA/hCaptcha box stays on the page; its token field fills).
const PAGE_STATE_JS = `(() => ({
  href: location.href,
  solved: [...document.querySelectorAll('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"],input[name="cf-turnstile-response"]')].some((e) => !!e.value),
}))()`;

async function pageState(page: any): Promise<{ href: string; solved: boolean } | null> {
    const s = await page.evaluate(PAGE_STATE_JS).catch(() => null);
    return s && typeof s.href === "string" ? s : null;
}

/** Sleep that wakes early when the turn is stopped. */
function nap(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const t = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
    });
}

/**
 * Poll until the check is gone: the detector finds none, the widget holds a
 * response token, or the page moved to another URL. Detector errors (the page
 * mid-navigation right after the owner clicks) count as "not yet".
 */
export async function waitForHuman(
    page: any,
    opts: {
        timeoutMs: number;
        intervalMs?: number;
        signal?: AbortSignal;
        startUrl?: string;
        detect?: (page: any) => Promise<CaptchaInfo>;
    },
): Promise<HandoffOutcome> {
    const { timeoutMs, intervalMs = 2000, signal, startUrl, detect = detectCaptcha } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal?.aborted) return "cancelled";
        touchBrowserActivity(); // keep the idle-close timer from closing the browser mid-wait
        await nap(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
        if (signal?.aborted) return "cancelled";
        const info = await detect(page).catch(() => null);
        if (info?.type === "none") return "cleared";
        const s = await pageState(page);
        if (s?.solved || (s && startUrl && s.href !== startUrl)) return "cleared";
    }
    return "timeout";
}

const siteOf = (url: string) => {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "the page";
    }
};

function askFor(type: CaptchaType, site: string, mode: string): string {
    const what =
        type === "turnstile"
            ? `Complete the "Verify you are human" check on ${site}`
            : `Tap the "I'm not a robot" box on ${site}`;
    const where = mode === "chrome" ? "it's open in your Chrome" : "it's in Bhai's browser window on your computer";
    return `${what} (${where}) — I'll carry on after.`;
}

/** Tell the owner on the channel this task came from, plus a desktop notification. Best effort. */
async function tellOwner(ask: string): Promise<string | null> {
    let channel: string | null = null;
    try {
        const { getActiveChannel, getChannelSender } = await import("../channel-send.js");
        channel = getActiveChannel();
        const send = channel ? getChannelSender(channel) : undefined;
        if (send) await send(`🙋 ${ask}`);
        else channel = null;
    } catch {
        channel = null;
    }
    import("../platform-bridge.js")
        .then(({ showNotification }) => showNotification("Bhai needs a quick tap", ask))
        .catch(() => {});
    return channel;
}

const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 300; // TOOL_TIMEOUTS.browser_wait_for_human leaves headroom over this

export const browserWaitForHuman: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "browser_wait_for_human",
            description:
                "Hand a human-verification check (\"I'm not a robot\" box, reCAPTCHA, hCaptcha, Cloudflare/Turnstile \"verify you are human\") to the owner and WAIT for them to do it. Bhai never ticks or solves these itself. This brings the tab to the front, messages the owner on this channel with a one-line ask, then polls (about every 2s, up to ~5 min) until the check is gone. On status 'cleared', carry on with the original task from where you stopped. On 'timeout', tell the owner the page is still waiting on them and stop.",
            parameters: {
                type: "object",
                properties: {
                    timeout_s: {
                        type: "number",
                        description: "How long to wait for the owner, in seconds (default 300, max 300).",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        try {
            const page = await getActivePage();
            const info = await detectCaptcha(page).catch(() => null);
            if (!info || info.type === "none") {
                return JSON.stringify({
                    success: true,
                    status: "cleared",
                    captcha_present: false,
                    message: "No human check on this page. Continue the task.",
                });
            }
            if (info.type === "recaptcha-v3") {
                // Invisible: nothing for the owner to tick.
                return JSON.stringify({
                    success: true,
                    status: "cleared",
                    captcha_type: info.type,
                    message: "Invisible reCAPTCHA v3: there is no box to tick. Continue the task.",
                });
            }

            // The live URL (the Chrome proxy's url() is cached); unknown → no "moved on" check.
            const startUrl = (await pageState(page))?.href;
            const site = siteOf(startUrl ?? page.url());
            const mode = getCurrentMode();
            try {
                if (mode === "chrome") {
                    // The bridge drives the active tab; raise it and its window.
                    const tab = await getActiveExtensionTab();
                    if (tab?.id) await sendBridgeCommand("switch_tab", { tabId: tab.id, focus: true });
                } else {
                    await page.bringToFront?.();
                }
            } catch {
                /* best effort */
            }

            const ask = askFor(info.type, site, mode);
            const banner = (label: string, done: boolean) =>
                Promise.resolve(
                    page.evaluate(`(${ATLAS_HUD_JS})(${JSON.stringify({ label, done, maxWidth: 460 })})`),
                ).catch(() => {});
            await banner("⏸ Bhai is waiting for you to complete this check", false);
            const channel = await tellOwner(ask);

            const raw = Number(
                input.timeout_s ?? (Number(process.env.ATLAS_CAPTCHA_HANDOFF_MS) / 1000 || DEFAULT_TIMEOUT_S),
            );
            const timeoutMs = Math.min(raw > 0 ? raw : DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
            console.log(
                `  🙋 Human check (${info.type}) on ${site}: waiting up to ${Math.round(timeoutMs / 1000)}s for the owner`,
            );
            const status = await waitForHuman(page, {
                timeoutMs,
                startUrl,
                signal: input._signal as AbortSignal | undefined,
            });
            await banner("", true);
            console.log(`  🙋 Human check: ${status}`);

            const base = { captcha_type: info.type, site, asked_on: channel ?? "desktop notification", ask };
            if (status === "cleared") {
                return JSON.stringify({
                    success: true,
                    status,
                    ...base,
                    message: "The owner completed the check. Continue the original task from where you stopped.",
                });
            }
            if (status === "cancelled") {
                return JSON.stringify({
                    error: "Stopped by the user while waiting for the human check.",
                    status,
                    ...base,
                });
            }
            // Bhai's own browser window may be out of the owner's reach (they're on their phone).
            const reopenHint =
                mode !== "chrome" && isExtensionConnected()
                    ? ` If they can't get to Bhai's browser window, offer to reopen ${startUrl ?? "this page"} in their own Chrome (browser_set_mode mode='chrome', then browser_navigate) and call browser_wait_for_human again.`
                    : "";
            return JSON.stringify({
                error: `The owner didn't complete the human check on ${site} within ${Math.round(timeoutMs / 1000)}s.`,
                status,
                requires_user: true,
                ...base,
                message: `Tell the owner the page is still waiting on them and stop here; don't retry this tool in a loop.${reopenHint}`,
            });
        } catch (err) {
            return JSON.stringify({ error: `Human-check handoff failed: ${(err as Error).message}` });
        }
    },
};
