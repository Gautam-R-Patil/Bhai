// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * os_smart_click (Phase 4/5) — the agent-facing entry point for the perception cascade.
 *
 * Takes a natural-language instruction + optional screenshot, runs the cascade
 * (AX → OmniParser → UI-TARS), executes the click, and records the outcome to
 * click-memory + drift-calibration for future fast-path recall.
 *
 * The agent should prefer this over the individual os_click / os_inspect / os_ground
 * tools for "click X" tasks — it's the single best path because it picks the right
 * tier automatically based on capability + AX availability.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { type LLMClient, MODELS } from "../llm.js";
import { axPerformAction, dumpAccessibilityTree } from "../screen/ax-dump.js";
import { recallClickSite, recordClickMiss, recordClickSuccess } from "../screen/click-memory.js";
import { applyCalibration, recordCalibrationSample } from "../screen/drift-calibration.js";
import { frontmostMatches, getFrontmostApp, waitForFrontmost } from "../screen/frontmost.js";
import { type ClickOutcome, type classifyOutcome, classifyOutcomeFromImages } from "../screen/outcome-classifier.js";
import {
    type CascadeMiss,
    type CascadeTier,
    type ClickTarget,
    findClickTarget,
    formatCascadeResult,
} from "../screen/perception-router.js";
import {
    captureRegion,
    getScreenDimensions,
    isFallbackDims,
    type Rect,
    type ScreenDimensions,
} from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";
import { executeStructuredAction } from "./os-computer-action.js";
import { takeScreenshot } from "./platform-bridge.js";

// LLM client for the cloud_grounding cascade tier (Lite/Standard + degraded
// Full). Injected at boot via setSmartClickLLM(); null = cloud tier skipped.
let _smartClickLLM: LLMClient | null = null;
export function setSmartClickLLM(client: LLMClient): void {
    _smartClickLLM = client;
}

/** Click memory is relative to the focused window (else the monitor), so it survives the window moving. */
function clickBasis(
    d: ScreenDimensions,
    at?: { x: number; y: number },
): { x: number; y: number; w: number; h: number } {
    const fw = d.focusedWindow;
    const inWindow =
        fw &&
        fw.w > 0 &&
        fw.h > 0 &&
        (!at || (at.x >= fw.x && at.x < fw.x + fw.w && at.y >= fw.y && at.y < fw.y + fw.h));
    // A menu-bar item or a sheet outside the window is remembered against the monitor.
    return inWindow ? { x: fw.x, y: fw.y, w: fw.w, h: fw.h } : { x: d.originX, y: d.originY, w: d.width, h: d.height };
}

function recordClick(
    site: { app: string; windowTitle: string; elementLabel: string },
    x: number,
    y: number,
    d: ScreenDimensions,
): void {
    const b = clickBasis(d, { x, y });
    recordClickSuccess(site, x - b.x, y - b.y, b.w, b.h);
}

async function base64ToTempFile(base64: string, ext = "png"): Promise<string> {
    // crypto.randomBytes is unpredictable — defends against tmpdir symlink attacks
    // where an attacker pre-creates a known filename to capture the screenshot.
    const tmp = join(tmpdir(), `atlas_smartclick_${randomBytes(8).toString("hex")}.${ext}`);
    const buf = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    await fs.writeFile(tmp, buf, { mode: 0o600 });
    return tmp;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Raise an app to the foreground before grounding, so the AX dump and the
 * screenshot see the intended window and not whatever stole focus.
 *   "already" — it was frontmost; "raised" — it is now (callers re-read the
 *   focused-window rect); "failed" — it never came to the front (macOS only:
 *   a click now would land in another app).
 *   macOS: `open -a` (safe — `tell…activate` can resolve the wrong binary), then
 *   poll until it is frontmost (fast on a warm app, patient on a cold launch).
 *   Windows: PowerShell AppActivate by process/window title. Linux: wmctrl if available.
 */
async function activateApp(appName: string): Promise<"already" | "raised" | "failed"> {
    if (!appName || appName === "unknown") return "already";
    try {
        if (process.platform === "darwin") {
            const front = await getFrontmostApp();
            if (front && frontmostMatches(appName, front)) return "already";
            // System agents are never frontmost: nothing to raise.
            // ponytail: fixed list; third-party menu-bar-only apps still wait out the 5s.
            if (/^(dock|control ?center|systemuiserver|notification ?center)$/i.test(appName.trim())) return "already";
            try {
                await execFileAsync("open", ["-a", appName], { timeout: 4000 });
            } catch {
                // A loose name `open -a` can't resolve ("Chrome"): best-effort, click in what's in front.
                return "already";
            }
            return (await waitForFrontmost(appName, 5000)) ? "raised" : "failed";
        }
        if (process.platform === "win32") {
            // VBScript-free: use the WScript.Shell AppActivate via PowerShell.
            await execFileAsync(
                "powershell",
                [
                    "-NoProfile",
                    "-Command",
                    `$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate('${appName.replace(/'/g, "''")}')`,
                ],
                { timeout: 5000 },
            );
        } else {
            await execFileAsync("wmctrl", ["-a", appName], { timeout: 4000 }).catch(() => {});
        }
        await sleep(350); // no frontmost probe here: let the window raise
        return "raised";
    } catch {
        return process.platform === "darwin" ? "failed" : "already"; /* best-effort off macOS */
    }
}

/** Window-scoped capture (kill-switch ATLAS_NO_WINDOW_SCOPED_CAPTURE forces full-screen). */
async function captureWindowRegion(fw: Rect): Promise<Buffer | null> {
    if (process.env.ATLAS_NO_WINDOW_SCOPED_CAPTURE === "true") return null;
    return captureRegion(fw);
}

const VISION_TIERS = new Set<CascadeTier>(["omniparser", "ui_tars", "cloud_grounding"]);

function missTip(m?: CascadeMiss): string {
    switch (m?.reason) {
        case "ax_permission_missing":
            return "Accessibility permission is missing, so no on-screen element could be read (this is not a bad label). Ask the user to grant Bhai Accessibility in System Settings → Privacy & Security → Accessibility.";
        case "ambiguous":
            return "Several elements match equally (see `ambiguous`). Re-issue with the one you mean: quote its exact label, mention nearby text, or add top/bottom/left/right.";
        case "ax_partial":
            return "The app stopped answering mid-read, so its accessibility tree was incomplete and was not matched (`nearest` is empty for that reason). Retry in a moment, or call os_screenshot to reason about the layout.";
        case "disabled":
            return "The matching element is disabled — do whatever enables it first, then retry.";
        default:
            return "No grounding tier located the element. `nearest` lists the closest accessibility labels and `tier_errors` why the vision tiers failed. Call os_inspect to see the elements that ARE visible, or os_screenshot to reason about the layout before retrying.";
    }
}

export const osSmartClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_smart_click",
            description:
                "DEFAULT click-by-description tool — ALWAYS try this FIRST for any 'click <description>' task on the host OS. It cascades automatically: persistent click-memory → Accessibility tree (fast, no screenshot needed) → OmniParser vision → UI-TARS local grounding. One tool call replaces os_scan+os_click_element / os_ocr_click flows. Pass `instruction` in plain English (e.g. 'the Save button in the toolbar', 'Wi-Fi in System Settings'). You do NOT need to pass a screenshot — the tool activates the target app and captures a FRESH frame itself; do NOT pass an old `screenshot_base64` (stale pixels cause misclicks). Records every successful click for future fast-path recall (sub-10ms on repeat). Use os_ocr_click / os_scan only as fallback when this returns cascade_miss.",
            parameters: {
                type: "object",
                properties: {
                    instruction: {
                        type: "string",
                        description:
                            'Natural-language description of what to click (e.g. "the Save button in the top-right toolbar").',
                    },
                    screenshot_base64: {
                        type: "string",
                        description:
                            "Optional last-resort base64 screenshot. Normally OMIT this — the tool auto-captures a fresh window-scoped frame at click time. Only pass one if you cannot let the tool capture (rare); a stale frame will cause misclicks.",
                    },
                    surface_hint: {
                        type: "string",
                        enum: ["native", "canvas", "web"],
                        description:
                            'Optional hint: "native" (default, prefer AX), "canvas" (Figma/Photoshop — skip AX), "web" (try AX first, fall through to vision).',
                    },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click"],
                        description: "Click action (default: click).",
                    },
                    app: {
                        type: "string",
                        description:
                            "Optional app name for click-memory keying. Auto-detected from frontmost if not supplied.",
                    },
                    window_title: {
                        type: "string",
                        description:
                            "Optional window-title context for click-memory keying. Helps disambiguate same-app same-label in different windows.",
                    },
                },
                required: ["instruction"],
            },
        },
    },

    async handler(input) {
        // Past this, never click: the tool layer gives up at 45s (index.ts) and a
        // late click would land after the agent has moved on (double "Send").
        const deadline = Date.now() + 40_000;
        const instruction = input.instruction as string;
        const action = (input.action as "click" | "double_click" | "right_click") || "click";
        const surface = input.surface_hint as "native" | "canvas" | "web" | undefined;
        let appName = (input.app as string) || "";
        let windowTitle = (input.window_title as string) || "";
        if (!instruction) return JSON.stringify({ success: false, error: "instruction required" });

        let dims = await getScreenDimensions({ focusedWindow: true });
        let dimsAreFallback = isFallbackDims(dims);

        // Auto-detect app when caller didn't specify — keying click memory by
        // `unknown` collapses every site into a single bucket and defeats the cache.
        // AxDump doesn't currently expose a window title, so window_title falls
        // back to the app name (still per-app, which is better than per-process).
        // Full-depth (20, same as the router's own) so the cascade reuses this
        // dump as its AX hint instead of dumping a second time.
        let axDumpHint: Awaited<ReturnType<typeof dumpAccessibilityTree>> | undefined;
        let appIsFrontmost = false;
        if (!appName) {
            try {
                const dump = await dumpAccessibilityTree({ depth: 20 });
                if (dump && !dump.error) {
                    axDumpHint = dump;
                    appName = dump.app || "";
                    appIsFrontmost = !!appName;
                }
            } catch {
                /* AX unavailable — fall back to placeholders */
            }
        }
        if (!windowTitle) windowTitle = appName;
        if (!appName) appName = "unknown";
        if (!windowTitle) windowTitle = "default";

        // The AX dump, the screenshot and any remembered spot all belong to the
        // target app's window: bring it to the front first (a no-op when it is).
        if (!appIsFrontmost) {
            const raised = await activateApp(appName);
            if (raised === "failed") {
                return JSON.stringify({
                    success: false,
                    error: `could not bring "${appName}" to the front (nothing was clicked). Check the app name, or open it with app_manager first.`,
                });
            }
            if (raised === "raised") {
                dims = await getScreenDimensions({ focusedWindow: true, force: true });
                dimsAreFallback = isFallbackDims(dims);
            }
        }

        const site = { app: appName, windowTitle, elementLabel: instruction };
        const verifyOn = process.env.ATLAS_NO_SMARTCLICK_VERIFY !== "true";
        const selfCorrectOn = process.env.ATLAS_NO_SMARTCLICK_SELFCORRECT !== "true";

        // A frame of the region the click is judged in: the focused window when
        // its rect is known and holds `at`, else the monitor (a menu-bar click).
        // Returns the rect it shows.
        const snap = async (at?: { x: number; y: number }): Promise<{ buf: Buffer; rect: Rect } | null> => {
            const r = dimsAreFallback ? dims.focusedWindow : clickBasis(dims, at);
            if (r && r.w > 0 && r.h > 0) {
                const buf = await captureWindowRegion(r);
                if (buf) return { buf, rect: r };
            }
            try {
                return { buf: await takeScreenshot(), rect: { x: 0, y: 0, w: dims.width, h: dims.height } };
            } catch {
                return null;
            }
        };

        // Click at (x, y) and classify what changed. The pointer moves there first
        // and the "before" frame is taken after any hover highlight has drawn, so
        // a highlight alone can't pass for the click working.
        const clickAndVerify = async (
            x: number,
            y: number,
        ): Promise<{ dispatchErr?: string; verdict?: ClickOutcome }> => {
            if (!verifyOn) {
                const r = await dispatchClick(action, x, y, dims);
                return r.success ? {} : { dispatchErr: r.error || "click_dispatch_failed" };
            }
            await dispatchClick("mouse_move", x, y, dims);
            await sleep(80);
            const before = await snap({ x, y });
            const r = await dispatchClick(action, x, y, dims);
            if (!r.success) return { dispatchErr: r.error || "click_dispatch_failed" };
            await sleep(300); // let the UI settle
            const after = await snap({ x, y });
            const rect = before?.rect ?? after?.rect ?? { x: 0, y: 0, w: dims.width, h: dims.height };
            const verdict = await reportClickOutcome(
                site,
                { x, y },
                before?.buf ?? null,
                after?.buf ?? null,
                rect.w,
                rect.h,
                {
                    origin: { x: rect.x, y: rect.y },
                },
            );
            return { verdict: verdict.outcome };
        };

        // Step 0 — click-memory recall (Phase 5 tier 0 — bypasses the cascade entirely on hit).
        try {
            // Threshold mirrors DEFAULT_THRESHOLDS.memory in perception-router so the
            // tier-0 stub and the smart-click fast-path treat memory hits identically.
            const recall = recallClickSite(site);
            // Rows are relative to the window, or to the monitor for points outside
            // it (menu bar): use whichever size the row was saved with. A resized
            // window matches neither, so it re-grounds instead.
            const win = clickBasis(dims);
            const mon = { x: dims.originX, y: dims.originY, w: dims.width, h: dims.height };
            const box = [win, mon].find((b) => recall?.lastScreenWidth === b.w && recall?.lastScreenHeight === b.h);
            if (recall && recall.confidence >= 0.9 && box) {
                let x = Math.round(recall.xNorm * box.w + box.x);
                let y = Math.round(recall.yNorm * box.h + box.y);
                // Apply drift calibration if learned for this monitor.
                ({ x, y } = applyCalibration(dims.monitorId, x, y));
                // A remembered spot is replayed blind, so it's checked like a
                // vision click: a miss (recorded by reportClickOutcome) erodes the
                // row until it is dropped, instead of replaying for 90 days.
                const r = await clickAndVerify(x, y);
                if (r.dispatchErr)
                    return JSON.stringify({ success: false, source: "memory", error: r.dispatchErr, instruction });
                if (r.verdict === "wrong_target") {
                    return JSON.stringify({
                        success: false,
                        error: "click_unverified",
                        source: "memory",
                        instruction,
                        clicked: { x, y },
                        verified: r.verdict,
                        tip: "A remembered click position changed something away from the target, so it was dropped from click memory. Take an os_screenshot to see what happened before retrying.",
                    });
                }
                // no_op: nothing happened, so it's safe to re-ground and click fresh below.
                if (r.verdict !== "no_op") {
                    if (r.verdict === "success" && !dimsAreFallback) {
                        try {
                            recordClick(site, x, y, dims);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    return JSON.stringify({
                        success: true,
                        source: "memory",
                        confidence: recall.confidence,
                        instruction,
                        clicked: { x, y },
                        verified: r.verdict ?? "not_checked",
                        success_count: recall.successCount,
                        elapsed_ms: 0,
                        tip: `Click memory hit (${recall.successCount} prior successes). To force a fresh probe, pass a different instruction or use os_inspect directly.`,
                    });
                }
            }
        } catch (e) {
            // Memory subsystem failed (DB unavailable) — non-fatal; fall through to cascade.
            console.warn(`[smart-click] memory recall failed: ${(e as Error).message}`);
        }

        // Step 1 — run the perception cascade.
        let tempPath: string | null = null;
        // Dims the cascade scales vision-tier coords against: the window when we
        // region-capture, else the monitor.
        let cascadeDims = dims;
        try {
            // The screenshot is only needed by the vision tiers, so it's taken
            // lazily — an AX hit never pays for it. It is always a FRESH frame:
            // agents routinely pass a STALE screenshot_base64 (pixels from before
            // the UI changed) → wrong_target / cascade_miss (observed live). The
            // caller's base64 is used ONLY as a last resort when fresh capture
            // fails, or when ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT=true restores
            // the old "trust caller pixels" behavior.
            const preferCaller = process.env.ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT === "true";
            const captureShot = async (): Promise<{ path: string; dims: ScreenDimensions } | null> => {
                if (tempPath) return { path: tempPath, dims: cascadeDims };
                if (preferCaller && input.screenshot_base64) {
                    tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                    return { path: tempPath, dims };
                }
                // Prefer a WINDOW-SCOPED capture: a full-screen image lets a stray
                // background window pollute grounding. The cascade gets WINDOW
                // dims (origin = window x/y, size = window w/h) so model coords map
                // back to absolute screen coords with the shared scaling math.
                const fw = dims.focusedWindow;
                let buf: Buffer | null = null;
                if (fw && fw.w > 0 && fw.h > 0) {
                    buf = await captureWindowRegion(fw);
                    if (buf) cascadeDims = { ...dims, originX: fw.x, originY: fw.y, width: fw.w, height: fw.h };
                }
                if (!buf) {
                    try {
                        buf = await takeScreenshot();
                    } catch (capErr) {
                        console.warn(`[smart-click] auto-screenshot failed: ${(capErr as Error).message}`);
                    }
                }
                if (buf) {
                    tempPath = join(tmpdir(), `atlas_smartclick_${randomBytes(6).toString("hex")}.png`);
                    await fs.writeFile(tempPath, buf, { mode: 0o600 });
                    return { path: tempPath, dims: cascadeDims };
                }
                // Last resort: fresh capture failed AND the caller gave us a frame.
                if (input.screenshot_base64) {
                    tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                    return { path: tempPath, dims };
                }
                return null;
            };

            const skipTiers: CascadeTier[] = [];
            if (surface === "canvas") skipTiers.push("ax_exact", "ax_fuzzy");

            // Ground → click → (vision only) verify. Returns a structured result.
            // `extraSkip` lets the self-correction force descent past a failed tier.
            const attempt = async (
                extraSkip: CascadeTier[],
                groundingModel?: string,
            ): Promise<{
                ok: boolean;
                target: ClickTarget | null;
                calX: number;
                calY: number;
                verdict?: string;
                dispatchErr?: string;
                miss?: CascadeMiss;
            }> => {
                let miss: CascadeMiss | undefined;
                const target = await findClickTarget(instruction, {
                    screenshot: captureShot,
                    skipTiers: [...skipTiers, ...extraSkip],
                    screenDims: dims,
                    axDumpHint,
                    dockFirst: /^dock$/i.test(appName.trim()),
                    llm: _smartClickLLM ?? undefined,
                    groundingModel,
                    groundingTimeoutMs: Math.max(3000, deadline - Date.now() - 5000),
                    onMiss: (m) => {
                        miss = m;
                    },
                });
                if (!target) return { ok: false, target: null, calX: 0, calY: 0, miss };
                if (Date.now() > deadline) {
                    return {
                        ok: false,
                        target,
                        calX: 0,
                        calY: 0,
                        dispatchErr: "timed_out_before_click (nothing was clicked)",
                    };
                }

                // AX hit: press the element itself when it supports AXPress (no
                // pixels, works under overlaps); an off-screen one is scrolled
                // into view first — never clicked at a clamped monitor edge.
                if (target.ax) {
                    if (action === "click") {
                        const pressed = await axPerformAction(target.ax.pid, target.ax, "press");
                        if (pressed.ok) {
                            if (!dimsAreFallback && !target.ax.offscreen) {
                                try {
                                    recordClick(site, target.x, target.y, dims);
                                } catch {
                                    /* non-fatal */
                                }
                            }
                            return { ok: true, target, calX: target.x, calY: target.y, verdict: "ax_press" };
                        }
                        // The press may have run (a menu/modal handler blocks AXPress
                        // past its timeout): a pixel click now would run it twice.
                        if (pressed.unconfirmed) {
                            return {
                                ok: false,
                                target,
                                calX: target.x,
                                calY: target.y,
                                dispatchErr: `ax_press_unconfirmed: AXPress on "${target.matchedLabel}" did not report back (${pressed.error}); it may have worked. Take an os_screenshot before retrying; nothing else was clicked.`,
                            };
                        }
                    }
                    if (target.ax.offscreen) {
                        const shown = await axPerformAction(target.ax.pid, target.ax, "reveal");
                        if (!shown.ok || !shown.frame) {
                            return {
                                ok: false,
                                target,
                                calX: target.x,
                                calY: target.y,
                                dispatchErr: `element_offscreen: "${target.matchedLabel}" is scrolled out of view and could not be revealed (${shown.error}). Scroll it into view first; nothing was clicked.`,
                            };
                        }
                        target.x = shown.frame.x + Math.floor(shown.frame.w / 2);
                        target.y = shown.frame.y + Math.floor(shown.frame.h / 2);
                    }
                }

                const { x: calX, y: calY } = applyCalibration(dims.monitorId, target.x, target.y);

                // Vision tiers can return wrong coordinates (the model mis-grounds);
                // AX geometry is trusted. Only vision-tier clicks are verified.
                if (!VISION_TIERS.has(target.source) || !verifyOn) {
                    const r = await dispatchClick(action, calX, calY, dims);
                    if (!r.success)
                        return { ok: false, target, calX, calY, dispatchErr: r.error || "click_dispatch_failed" };
                    if (!dimsAreFallback) {
                        try {
                            recordClick(site, calX, calY, dims);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    return { ok: true, target, calX, calY };
                }

                const r = await clickAndVerify(calX, calY);
                if (r.dispatchErr) return { ok: false, target, calX, calY, dispatchErr: r.dispatchErr };
                if (r.verdict === "success" || r.verdict === "modal_pop") {
                    if (!dimsAreFallback) {
                        try {
                            recordClick(site, calX, calY, dims);
                        } catch {
                            /* non-fatal */
                        }
                    }
                    return { ok: true, target, calX, calY, verdict: r.verdict };
                }
                if (r.verdict === "unknown") {
                    // Ambiguous — don't poison memory either way; soft-pass.
                    return { ok: true, target, calX, calY, verdict: "unknown" };
                }
                // no_op / wrong_target — reportClickOutcome already recorded a miss.
                return { ok: false, target, calX, calY, verdict: r.verdict };
            };

            let res = await attempt([]);

            // Self-correction: a vision click that verified as a miss → re-ground
            // forcing descent past the failed tier (+ all above it), click once more.
            if (
                !res.ok &&
                res.target &&
                selfCorrectOn &&
                VISION_TIERS.has(res.target.source) &&
                verifyOn &&
                !res.dispatchErr
            ) {
                const order: CascadeTier[] = [
                    "memory",
                    "ax_exact",
                    "ax_fuzzy",
                    "omniparser",
                    "ui_tars",
                    "cloud_grounding",
                ];
                const failedIdx = order.indexOf(res.target.source);
                // A Haiku grounding miss gets one Sonnet re-ground; any other
                // vision miss descends past the failed tier.
                // Only after a true no-op: a "wrong_target" click did something, and
                // clicking again could repeat it (a second Send, a second keypress).
                const regroundWithSonnet = res.target.source === "cloud_grounding" && res.verdict === "no_op";
                const forceSkip = order.slice(0, regroundWithSonnet ? failedIdx : failedIdx + 1);
                const first = { x: res.calX, y: res.calY };
                // Re-ground on the screen as it is now, not the pre-click frame.
                if (tempPath) {
                    const fresh = await snap();
                    if (fresh) await fs.writeFile(tempPath, fresh.buf, { mode: 0o600 }).catch(() => {});
                }
                const retry =
                    deadline - Date.now() > 8000 && (regroundWithSonnet || res.target.source !== "cloud_grounding")
                        ? await attempt(forceSkip, regroundWithSonnet ? MODELS.SONNET : undefined)
                        : { ok: false, target: null, calX: 0, calY: 0 };
                // Only accept a retry that grounded somewhere clearly different (≥20px).
                if (retry.target && Math.hypot(retry.calX - first.x, retry.calY - first.y) >= 20) res = retry;
            }

            if (res.dispatchErr) {
                return JSON.stringify({
                    success: false,
                    error: res.dispatchErr,
                    target: res.target,
                    formatted: formatCascadeResult(res.target),
                });
            }
            if (!res.ok && !res.target) {
                const m = res.miss;
                return JSON.stringify({
                    success: false,
                    error: "cascade_miss",
                    reason: m?.reason ?? "not_found",
                    instruction,
                    formatted: formatCascadeResult(null, m),
                    app: m?.app,
                    ax_element_count: m?.axElementCount,
                    ax_error: m?.axError,
                    nearest: m?.nearest,
                    ambiguous: m?.ambiguous,
                    tier_errors: m?.tierErrors,
                    tip: missTip(m),
                });
            }
            if (!res.ok) {
                return JSON.stringify({
                    success: false,
                    error: "click_unverified",
                    instruction,
                    clicked: { x: res.calX, y: res.calY },
                    target: res.target,
                    verified: res.verdict,
                    formatted: formatCascadeResult(res.target),
                    tip: `Grounded via ${res.target?.source} and clicked, but post-click verification saw no expected change (${res.verdict}). The element may not have been where grounding predicted. Try os_inspect or os_screenshot to re-locate.`,
                });
            }
            return JSON.stringify({
                success: true,
                source: res.target?.source,
                confidence: res.target?.confidence,
                instruction,
                clicked: { x: res.calX, y: res.calY },
                target: res.target,
                verified:
                    res.verdict ?? (res.target && VISION_TIERS.has(res.target.source) ? undefined : "trusted_tier"),
                formatted: formatCascadeResult(res.target),
                tip: `Cascade succeeded via ${res.target?.source} (${res.target?.totalMs}ms). ${res.verdict ? `Verified: ${res.verdict}. ` : ""}Recorded to click memory.`,
            });
        } finally {
            if (tempPath) {
                try {
                    await fs.unlink(tempPath);
                } catch {
                    /* best-effort */
                }
            }
        }
    },
};

/** Dispatch through os_computer_action's executor with the dims we already have (no second probe). */
async function dispatchClick(
    action: "click" | "double_click" | "right_click" | "mouse_move",
    x: number,
    y: number,
    dims: ScreenDimensions,
): Promise<{ success: boolean; error?: string }> {
    try {
        await executeStructuredAction({ action, coord: [x, y], coordSystem: "screen" }, dims);
        return { success: true };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}

/**
 * After-action telemetry helper. Caller passes before/after screenshots + target;
 * we update click-memory based on the classified outcome and optionally feed a
 * (predicted, actual) drift sample when the caller can locate the post-click element.
 *
 * `actual` should be the screen-pixel center of the element that visibly responded
 * to the click (typically a post-verify AX dump or OmniParser re-run after the
 * action). When omitted, no calibration sample is recorded — recording (predicted,
 * predicted) is circular and locks the transform.
 *
 * `target` is in absolute screen coords; `before`/`after` are encoded captures
 * of the imageWidth × imageHeight (logical px) region whose top-left is
 * `opts.origin` (default 0,0) — the target is made region-relative before diffing.
 */
export async function reportClickOutcome(
    site: { app: string; windowTitle: string; elementLabel: string },
    target: { x: number; y: number },
    before: Buffer | null,
    after: Buffer | null,
    imageWidth: number,
    imageHeight: number,
    opts?: { monitorId?: string; actual?: { x: number; y: number }; origin?: { x: number; y: number } },
): Promise<ReturnType<typeof classifyOutcome>> {
    const ox = opts?.origin?.x ?? 0;
    const oy = opts?.origin?.y ?? 0;
    const outcome = await classifyOutcomeFromImages(
        before,
        after,
        target.x - ox,
        target.y - oy,
        imageWidth,
        imageHeight,
    );
    try {
        if (outcome.outcome === "no_op" || outcome.outcome === "wrong_target") {
            recordClickMiss(site);
        } else if (outcome.outcome === "success" && opts?.monitorId && opts.actual) {
            // Only record a calibration sample when we have a measured landing point.
            recordCalibrationSample(opts.monitorId, target, opts.actual);
        }
    } catch {
        /* memory persistence failed — non-fatal */
    }
    return outcome;
}
