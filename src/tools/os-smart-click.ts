// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
import { withCursorHidden } from "../screen/agent-cursor.js";
import { dumpAccessibilityTree } from "../screen/ax-dump.js";
import { recallClickSite, recordClickMiss, recordClickSuccess } from "../screen/click-memory.js";
import { applyCalibration, recordCalibrationSample } from "../screen/drift-calibration.js";
import { type classifyOutcome, classifyOutcomeFromImages } from "../screen/outcome-classifier.js";
import { type CascadeTier, findClickTarget, formatCascadeResult } from "../screen/perception-router.js";
import { getScreenDimensions, isFallbackDims, type ScreenDimensions } from "../screen/screen-dimensions.js";
import { type LLMClient, MODELS } from "../llm.js";
import type { ToolDefinition } from "./get-current-time.js";
import { osComputerAction } from "./os-computer-action.js";
import { takeScreenshot } from "./platform-bridge.js";

// LLM client for the cloud_grounding cascade tier (Lite/Standard + degraded
// Full). Injected at boot via setSmartClickLLM(); null = cloud tier skipped.
let _smartClickLLM: LLMClient | null = null;
export function setSmartClickLLM(client: LLMClient): void {
    _smartClickLLM = client;
}

/** Click memory is relative to the focused window (else the monitor), so it survives the window moving. */
function clickBasis(d: ScreenDimensions, at?: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
    const fw = d.focusedWindow;
    const inWindow = fw && fw.w > 0 && fw.h > 0 && (!at || (at.x >= fw.x && at.x < fw.x + fw.w && at.y >= fw.y && at.y < fw.y + fw.h));
    // A menu-bar item or a sheet outside the window is remembered against the monitor.
    return inWindow ? { x: fw.x, y: fw.y, w: fw.w, h: fw.h } : { x: d.originX, y: d.originY, w: d.width, h: d.height };
}

function recordClick(site: { app: string; windowTitle: string; elementLabel: string }, x: number, y: number, d: ScreenDimensions): void {
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

/**
 * Raise an app to the foreground before grounding, so the auto-screenshot
 * captures the intended window and not whatever stole focus. Cross-platform,
 * best-effort (silent on failure — caller proceeds with current frontmost).
 * Returns true only when it actually tried to raise a window (callers re-read
 * the focused-window rect then). No-op when the app is already frontmost.
 *   macOS: `open -a` (safe — `tell…activate` can resolve the wrong binary).
 *   Windows: PowerShell AppActivate by process/window title.
 *   Linux: wmctrl if available (no-op otherwise).
 */
async function activateApp(appName: string): Promise<boolean> {
    if (!appName || appName === "unknown") return false;
    try {
        if (process.platform === "darwin") {
            // Already frontmost → skip `open -a` + the 350ms settle sleep.
            const { stdout } = await execFileAsync("osascript", ["-e",
                'tell application "System Events" to get name of first process whose frontmost is true',
            ], { timeout: 2000 }).catch(() => ({ stdout: "" }));
            if (stdout.trim().toLowerCase() === appName.toLowerCase()) return false;
            await execFileAsync("open", ["-a", appName], { timeout: 4000 });
        } else if (process.platform === "win32") {
            // VBScript-free: use the WScript.Shell AppActivate via PowerShell.
            await execFileAsync("powershell", ["-NoProfile", "-Command",
                `$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate('${appName.replace(/'/g, "''")}')`,
            ], { timeout: 5000 });
        } else {
            await execFileAsync("wmctrl", ["-a", appName], { timeout: 4000 }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 350)); // let the window raise
        return true;
    } catch {
        return false; /* best-effort */
    }
}

/**
 * Capture just the focused-window rect to a temp PNG, cross-platform. Returns
 * the path on success or null (caller falls back to full-screen). Window-scoped
 * capture keeps a stray background window from polluting vision grounding.
 *   macOS: `screencapture -R x,y,w,h`.
 *   Windows: PowerShell System.Drawing CopyFromScreen of the rect.
 *   Linux: not implemented here → null (full-screen fallback).
 */
async function captureWindowRegion(fw: { x: number; y: number; w: number; h: number }): Promise<string | null> {
    if (process.env.ATLAS_NO_WINDOW_SCOPED_CAPTURE === "true") return null;
    const out = join(tmpdir(), `atlas_smartclick_${randomBytes(6).toString("hex")}.png`);
    try {
        if (process.platform === "darwin") {
            await withCursorHidden(() =>
                execFileAsync("screencapture", ["-x", `-R${fw.x},${fw.y},${fw.w},${fw.h}`, out], { timeout: 8000 }),
            );
            return out;
        }
        if (process.platform === "win32") {
            const ps =
                `Add-Type -AssemblyName System.Drawing,System.Windows.Forms;` +
                `$b = New-Object System.Drawing.Bitmap(${fw.w}, ${fw.h});` +
                `$g = [System.Drawing.Graphics]::FromImage($b);` +
                `$g.CopyFromScreen(${fw.x}, ${fw.y}, 0, 0, $b.Size);` +
                `$b.Save('${out.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png);` +
                `$g.Dispose(); $b.Dispose()`;
            await withCursorHidden(() => execFileAsync("powershell", ["-NoProfile", "-Command", ps], { timeout: 8000 }));
            return out;
        }
        return null; // Linux region capture: fall back to full-screen
    } catch {
        return null;
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

        // Step 0 — click-memory recall (Phase 5 tier 0 — bypasses the cascade entirely on hit).
        const site = { app: appName, windowTitle, elementLabel: instruction };
        try {
            // Threshold mirrors DEFAULT_THRESHOLDS.memory in perception-router so the
            // tier-0 stub and the smart-click fast-path treat memory hits identically.
            const recall = recallClickSite(site);
            if (recall && recall.confidence >= 0.9) {
                // The remembered spot belongs to this app's window: bring it to the
                // front first or the click lands in whatever app is on top.
                if (!appIsFrontmost && appName !== "unknown" && (await activateApp(appName))) {
                    dims = await getScreenDimensions({ focusedWindow: true, force: true });
                    dimsAreFallback = isFallbackDims(dims);
                    appIsFrontmost = true;
                }
            }
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
                const clickResult = await dispatchClick(action, x, y);
                return JSON.stringify({
                    success: clickResult.success,
                    source: "memory",
                    confidence: recall.confidence,
                    instruction,
                    clicked: { x, y },
                    success_count: recall.successCount,
                    elapsed_ms: 0,
                    tip: `Click memory hit (${recall.successCount} prior successes). To force a fresh probe, pass a different instruction or use os_inspect directly.`,
                });
            }
        } catch (e) {
            // Memory subsystem failed (DB unavailable) — non-fatal; fall through to cascade.
            console.warn(`[smart-click] memory recall failed: ${(e as Error).message}`);
        }

        // Step 1 — run the perception cascade.
        let screenshotPath: string | undefined;
        let tempPath: string | null = null;
        // Dims the cascade scales vision-tier coords against. Defaults to the
        // full monitor; replaced with window-scoped dims if we region-capture.
        let cascadeDims = dims;
        try {
            // ALWAYS re-capture a FRESH frame at click time by default. Agents
            // routinely pass a STALE screenshot_base64 (pixels from an earlier
            // os_screenshot, before the UI changed) → the cascade grounds on an
            // old frame → wrong_target / cascade_miss (observed live). A fresh
            // window-scoped capture is fast (~50-150ms) and correct. The caller's
            // base64 is used ONLY as a last resort when fresh capture fails, or
            // when ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT=true restores the old
            // "trust caller pixels" behavior.
            const preferCaller = process.env.ATLAS_SMARTCLICK_USE_CALLER_SCREENSHOT === "true";
            if (preferCaller && input.screenshot_base64) {
                tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                screenshotPath = tempPath;
            } else {
                // Raise the target app to the front BEFORE capturing, so the
                // auto-screenshot sees the intended window and not whatever stole
                // focus (which caused false cascade_miss for elements that WERE
                // on the target's window). Cross-platform, best-effort.
                // Skipped when the app was auto-detected as frontmost. After a
                // real activation, re-read dims so the focused-window rect (and
                // monitor) belong to the raised app, not the previous one.
                if (!appIsFrontmost && (await activateApp(appName))) {
                    dims = await getScreenDimensions({ focusedWindow: true, force: true });
                    dimsAreFallback = isFallbackDims(dims);
                    cascadeDims = dims;
                }
                // Prefer a WINDOW-SCOPED capture when focused-window bounds are
                // known (macOS + Windows): a full-screen image lets a stray
                // background window pollute grounding. We hand the cascade
                // WINDOW-relative dims (origin = window x/y, size = window w/h) so
                // scaleImageToScreen maps the model's window-local coords back to
                // absolute screen coords — no change to the shared scaling math.
                const fw = dims.focusedWindow;
                if (fw && fw.w > 0 && fw.h > 0) {
                    const region = await captureWindowRegion(fw);
                    if (region) {
                        tempPath = region;
                        screenshotPath = region;
                        cascadeDims = { ...dims, originX: fw.x, originY: fw.y, width: fw.w, height: fw.h };
                    }
                }
                if (!screenshotPath) {
                    try {
                        const shot = await takeScreenshot();
                        tempPath = join(tmpdir(), `atlas_smartclick_${randomBytes(6).toString("hex")}.png`);
                        await fs.writeFile(tempPath, shot, { mode: 0o600 });
                        screenshotPath = tempPath;
                    } catch (capErr) {
                        console.warn(`[smart-click] auto-screenshot failed: ${(capErr as Error).message}`);
                    }
                }
                // Last-resort fallback: fresh capture failed AND the caller gave us
                // a frame — better than AX-only (the vision tiers need an image).
                if (!screenshotPath && input.screenshot_base64) {
                    try {
                        tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                        screenshotPath = tempPath;
                    } catch {
                        /* AX-only cascade */
                    }
                }
            }

            const skipTiers: CascadeTier[] = [];
            if (surface === "canvas") skipTiers.push("ax_exact", "ax_fuzzy");

            // Vision tiers can return wrong coordinates (the model mis-grounds);
            // AX/memory tiers come from OS element geometry and are trusted. Only
            // vision-tier clicks get post-click verification + self-correction.
            const VISION_TIERS = new Set<CascadeTier>(["omniparser", "ui_tars", "cloud_grounding"]);
            const verifyOn = process.env.ATLAS_NO_SMARTCLICK_VERIFY !== "true";
            const selfCorrectOn = process.env.ATLAS_NO_SMARTCLICK_SELFCORRECT !== "true";

            // Captures a screenshot the same way grounding did (window-scoped when
            // we region-captured, else full-screen), for before/after diffing.
            const captureForVerify = async (): Promise<Buffer | null> => {
                try {
                    const fw = cascadeDims.focusedWindow;
                    if (fw && fw.w > 0) {
                        const p = await captureWindowRegion(fw);
                        if (p) {
                            const buf = await fs.readFile(p);
                            await fs.unlink(p).catch(() => {});
                            return buf;
                        }
                    }
                    return await takeScreenshot();
                } catch {
                    return null;
                }
            };

            // Ground → click → (vision only) verify. Returns a structured result.
            // `extraSkip` lets the self-correction force descent past a failed tier.
            const attempt = async (extraSkip: CascadeTier[], groundingModel?: string): Promise<{
                ok: boolean; target: NonNullable<Awaited<ReturnType<typeof findClickTarget>>> | null;
                calX: number; calY: number; verdict?: string; dispatchErr?: string;
            }> => {
                const target = await findClickTarget(instruction, {
                    screenshotPath,
                    skipTiers: [...skipTiers, ...extraSkip],
                    screenDims: cascadeDims,
                    axDumpHint,
                    llm: _smartClickLLM ?? undefined,
                    groundingModel,
                    groundingTimeoutMs: Math.max(3000, deadline - Date.now() - 5000),
                });
                if (!target) return { ok: false, target: null, calX: 0, calY: 0 };
                if (Date.now() > deadline) {
                    return { ok: false, target, calX: 0, calY: 0, dispatchErr: "timed_out_before_click (nothing was clicked)" };
                }

                const { x: calX, y: calY } = applyCalibration(dims.monitorId, target.x, target.y);
                const isVision = VISION_TIERS.has(target.source);

                const before = verifyOn && isVision ? await captureForVerify() : null;
                const clickResult = await dispatchClick(action, calX, calY);
                if (!clickResult.success) {
                    return { ok: false, target, calX, calY, dispatchErr: clickResult.error || "click_dispatch_failed" };
                }

                // Trusted (AX/memory) tier OR verification disabled → record + done.
                if (!isVision || !verifyOn) {
                    if (!dimsAreFallback) {
                        try { recordClick(site, calX, calY, dims); } catch { /* non-fatal */ }
                    }
                    return { ok: true, target, calX, calY };
                }

                // Vision tier → verify the click actually did something.
                await new Promise((r) => setTimeout(r, 300)); // let the UI settle
                const after = await captureForVerify();
                const verdict = await reportClickOutcome(
                    site, { x: calX, y: calY }, before, after,
                    cascadeDims.width || dims.width, cascadeDims.height || dims.height,
                    { origin: { x: cascadeDims.originX, y: cascadeDims.originY } },
                );
                if (verdict.outcome === "success" || verdict.outcome === "modal_pop") {
                    if (!dimsAreFallback) {
                        try { recordClick(site, calX, calY, dims); } catch { /* non-fatal */ }
                    }
                    return { ok: true, target, calX, calY, verdict: verdict.outcome };
                }
                if (verdict.outcome === "unknown") {
                    // Ambiguous — don't poison memory either way; soft-pass.
                    return { ok: true, target, calX, calY, verdict: "unknown" };
                }
                // no_op / wrong_target — reportClickOutcome already recorded a miss.
                return { ok: false, target, calX, calY, verdict: verdict.outcome };
            };

            let res = await attempt([]);

            // Self-correction: a vision click that verified as a miss → re-ground
            // forcing descent past the failed tier (+ all above it), click once more.
            if (!res.ok && res.target && selfCorrectOn && VISION_TIERS.has(res.target.source) && verifyOn && !res.dispatchErr) {
                const order: CascadeTier[] = ["memory", "ax_exact", "ax_fuzzy", "omniparser", "ui_tars", "cloud_grounding"];
                const failedIdx = order.indexOf(res.target.source);
                // A Haiku grounding miss gets one Sonnet re-ground; any other
                // vision miss descends past the failed tier.
                // Only after a true no-op: a "wrong_target" click did something, and
                // clicking again could repeat it (a second Send, a second keypress).
                const regroundWithSonnet = res.target.source === "cloud_grounding" && res.verdict === "no_op";
                const forceSkip = order.slice(0, regroundWithSonnet ? failedIdx : failedIdx + 1);
                const first = { x: res.calX, y: res.calY };
                // Re-ground on the screen as it is now, not the pre-click frame.
                if (tempPath && screenshotPath === tempPath) {
                    const fresh = await captureForVerify();
                    if (fresh) await fs.writeFile(tempPath, fresh, { mode: 0o600 }).catch(() => {});
                }
                const retry =
                    deadline - Date.now() > 8000 && (regroundWithSonnet || res.target.source !== "cloud_grounding")
                        ? await attempt(forceSkip, regroundWithSonnet ? MODELS.SONNET : undefined)
                        : { ok: false, target: null, calX: 0, calY: 0 };
                // Only accept a retry that grounded somewhere clearly different (≥20px).
                if (retry.target && Math.hypot(retry.calX - first.x, retry.calY - first.y) >= 20) res = retry;
            }

            if (res.dispatchErr) {
                return JSON.stringify({ success: false, error: res.dispatchErr, target: res.target, formatted: formatCascadeResult(res.target) });
            }
            if (!res.ok && !res.target) {
                return JSON.stringify({
                    success: false, error: "cascade_miss", instruction, formatted: formatCascadeResult(null),
                    tip: "All grounding tiers (AX → OmniParser → UI-TARS/cloud-grounding) failed to locate the element. Call os_inspect to see the AX elements that ARE visible, or os_screenshot to reason about the layout directly before retrying.",
                });
            }
            if (!res.ok) {
                return JSON.stringify({
                    success: false, error: "click_unverified", instruction,
                    clicked: { x: res.calX, y: res.calY }, target: res.target, verified: res.verdict,
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
                verified: res.verdict ?? (res.target && VISION_TIERS.has(res.target.source) ? undefined : "trusted_tier"),
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

async function dispatchClick(
    action: "click" | "double_click" | "right_click",
    x: number,
    y: number,
): Promise<{ success: boolean; error?: string }> {
    let result: string;
    try {
        result = await osComputerAction.handler({
            action,
            coord: [x, y],
            coordSystem: "screen",
        });
    } catch (e) {
        return { success: false, error: `action_dispatch_threw:${(e as Error).message}` };
    }
    try {
        const parsed = JSON.parse(result) as { success?: boolean; error?: string };
        return { success: parsed.success ?? false, error: parsed.error };
    } catch {
        return { success: false, error: "invalid_action_response" };
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
    const outcome = await classifyOutcomeFromImages(before, after, target.x - ox, target.y - oy, imageWidth, imageHeight);
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
