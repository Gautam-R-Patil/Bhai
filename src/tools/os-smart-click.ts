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
import { dumpAccessibilityTree } from "../screen/ax-dump.js";
import { recallClickSite, recordClickMiss, recordClickSuccess } from "../screen/click-memory.js";
import { applyCalibration, recordCalibrationSample } from "../screen/drift-calibration.js";
import { classifyOutcome } from "../screen/outcome-classifier.js";
import { type CascadeTier, findClickTarget, formatCascadeResult } from "../screen/perception-router.js";
import { getScreenDimensions, isFallbackDims } from "../screen/screen-dimensions.js";
import type { LLMClient } from "../llm.js";
import type { ToolDefinition } from "./get-current-time.js";
import { osComputerAction } from "./os-computer-action.js";
import { takeScreenshot } from "./platform-bridge.js";

// LLM client for the cloud_grounding cascade tier (Lite/Standard + degraded
// Full). Injected at boot via setSmartClickLLM(); null = cloud tier skipped.
let _smartClickLLM: LLMClient | null = null;
export function setSmartClickLLM(client: LLMClient): void {
    _smartClickLLM = client;
}

async function base64ToTempFile(base64: string, ext = "png"): Promise<string> {
    // crypto.randomBytes is unpredictable — defends against tmpdir symlink attacks
    // where an attacker pre-creates a known filename to capture the screenshot.
    const tmp = join(tmpdir(), `atlas_smartclick_${randomBytes(8).toString("hex")}.${ext}`);
    const buf = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    await fs.writeFile(tmp, buf, { mode: 0o600 });
    return tmp;
}

export const osSmartClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_smart_click",
            description:
                "DEFAULT click-by-description tool — ALWAYS try this FIRST for any 'click <description>' task on the host OS. It cascades automatically: persistent click-memory → Accessibility tree (fast, no screenshot needed) → OmniParser vision → UI-TARS local grounding. One tool call replaces os_scan+os_click_element / os_ocr_click flows. Pass `instruction` in plain English (e.g. 'the Save button in the toolbar', 'Wi-Fi in System Settings'). Pass `screenshot_base64` from os_screenshot only if you want vision-grounding fallback. Records every successful click for future fast-path recall (sub-10ms on repeat). Use os_ocr_click / os_scan only as fallback when this returns cascade_miss.",
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
                            "Optional base64-encoded screenshot (from os_screenshot.screenshot_base64). Required for OmniParser/UI-TARS tiers; AX tiers work without it.",
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
        const instruction = input.instruction as string;
        const action = (input.action as "click" | "double_click" | "right_click") || "click";
        const surface = input.surface_hint as "native" | "canvas" | "web" | undefined;
        let appName = (input.app as string) || "";
        let windowTitle = (input.window_title as string) || "";
        if (!instruction) return JSON.stringify({ success: false, error: "instruction required" });

        const dims = await getScreenDimensions({ focusedWindow: true });
        const dimsAreFallback = isFallbackDims(dims);

        // Auto-detect app when caller didn't specify — keying click memory by
        // `unknown` collapses every site into a single bucket and defeats the cache.
        // AxDump doesn't currently expose a window title, so window_title falls
        // back to the app name (still per-app, which is better than per-process).
        let axDumpHint: Awaited<ReturnType<typeof dumpAccessibilityTree>> | undefined;
        if (!appName || !windowTitle) {
            try {
                axDumpHint = await dumpAccessibilityTree({ depth: 6 });
                if (axDumpHint && !axDumpHint.error) {
                    if (!appName) appName = axDumpHint.app || "";
                    if (!windowTitle) windowTitle = axDumpHint.app || "";
                }
            } catch {
                /* AX unavailable — fall back to placeholders */
            }
        }
        if (!appName) appName = "unknown";
        if (!windowTitle) windowTitle = "default";

        // Step 0 — click-memory recall (Phase 5 tier 0 — bypasses the cascade entirely on hit).
        const site = { app: appName, windowTitle, elementLabel: instruction };
        try {
            // Threshold mirrors DEFAULT_THRESHOLDS.memory in perception-router so the
            // tier-0 stub and the smart-click fast-path treat memory hits identically.
            const recall = recallClickSite(site);
            if (recall && recall.confidence >= 0.9) {
                let x = Math.round(recall.xNorm * dims.width + dims.originX);
                let y = Math.round(recall.yNorm * dims.height + dims.originY);
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
            if (input.screenshot_base64) {
                tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                screenshotPath = tempPath;
            } else {
                // Raise the target app to the front BEFORE capturing. Without
                // this, the auto-screenshot grabs whatever stole focus (e.g. a
                // terminal), so grounding runs against the wrong window and
                // returns a false cascade_miss for an element that IS on the
                // target's window. macOS `open -a` is the safe activate path
                // (per macos.ts guidance — `tell … activate` can resolve wrong).
                if (appName && appName !== "unknown" && process.platform === "darwin") {
                    try {
                        await execFileAsync("open", ["-a", appName], { timeout: 4000 });
                        await new Promise((r) => setTimeout(r, 350)); // let the window raise
                    } catch { /* best-effort — proceed with whatever is frontmost */ }
                }
                // Auto-capture when the agent didn't supply one. Without this the
                // cascade's vision tiers (OmniParser / UI-TARS / cloud_grounding)
                // were silently skipped — agents routinely call os_smart_click
                // without a screenshot, so AX-only would miss and the best
                // grounding tiers never ran. This is the main cause of low click
                // accuracy. Best-effort: on capture failure, fall back to AX-only.
                //
                // Prefer a WINDOW-SCOPED capture (macOS `screencapture -R`) when
                // the focused-window bounds are known: a full-screen image lets a
                // stray background window pollute grounding, and the model can
                // mis-ground onto the wrong app. Scoping to the target window's
                // rect also gives the VLM a tighter, higher-signal image. When we
                // scope, we hand the cascade WINDOW-relative dims (origin = window
                // x/y, size = window w/h) so scaleImageToScreen maps the model's
                // window-local coords back to absolute screen coords correctly —
                // no change to the shared scaling math required.
                const fw = dims.focusedWindow;
                if (
                    process.platform === "darwin" &&
                    fw && fw.w > 0 && fw.h > 0 &&
                    process.env.ATLAS_NO_WINDOW_SCOPED_CAPTURE !== "true"
                ) {
                    try {
                        tempPath = join(tmpdir(), `atlas_smartclick_${randomBytes(6).toString("hex")}.png`);
                        await execFileAsync(
                            "screencapture",
                            ["-x", `-R${fw.x},${fw.y},${fw.w},${fw.h}`, tempPath],
                            { timeout: 8000 },
                        );
                        screenshotPath = tempPath;
                        // Window-scoped dims: image spans the window rect, so the
                        // cascade scales image-px → (window origin + window size).
                        cascadeDims = {
                            ...dims,
                            originX: fw.x,
                            originY: fw.y,
                            width: fw.w,
                            height: fw.h,
                        };
                    } catch {
                        screenshotPath = undefined; // fall through to full-screen below
                    }
                }
                if (!screenshotPath) {
                    try {
                        const shot = await takeScreenshot();
                        tempPath = join(tmpdir(), `atlas_smartclick_${randomBytes(6).toString("hex")}.png`);
                        await fs.writeFile(tempPath, shot, { mode: 0o600 });
                        screenshotPath = tempPath;
                    } catch (capErr) {
                        console.warn(`[smart-click] auto-screenshot failed (AX-only cascade): ${(capErr as Error).message}`);
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
                    if (process.platform === "darwin" && fw && fw.w > 0 && process.env.ATLAS_NO_WINDOW_SCOPED_CAPTURE !== "true") {
                        const p = join(tmpdir(), `atlas_verify_${randomBytes(6).toString("hex")}.png`);
                        await execFileAsync("screencapture", ["-x", `-R${fw.x},${fw.y},${fw.w},${fw.h}`, p], { timeout: 8000 });
                        const buf = await fs.readFile(p);
                        await fs.unlink(p).catch(() => {});
                        return buf;
                    }
                    return await takeScreenshot();
                } catch {
                    return null;
                }
            };

            // Ground → click → (vision only) verify. Returns a structured result.
            // `extraSkip` lets the self-correction force descent past a failed tier.
            const attempt = async (extraSkip: CascadeTier[]): Promise<{
                ok: boolean; target: NonNullable<Awaited<ReturnType<typeof findClickTarget>>> | null;
                calX: number; calY: number; verdict?: string; dispatchErr?: string;
            }> => {
                const target = await findClickTarget(instruction, {
                    screenshotPath,
                    skipTiers: [...skipTiers, ...extraSkip],
                    screenDims: cascadeDims,
                    axDumpHint,
                    llm: _smartClickLLM ?? undefined,
                });
                if (!target) return { ok: false, target: null, calX: 0, calY: 0 };

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
                        try { recordClickSuccess(site, calX - dims.originX, calY - dims.originY, dims.width, dims.height); } catch { /* non-fatal */ }
                    }
                    return { ok: true, target, calX, calY };
                }

                // Vision tier → verify the click actually did something.
                await new Promise((r) => setTimeout(r, 300)); // let the UI settle
                const after = await captureForVerify();
                const verdict = await reportClickOutcome(
                    site, { x: calX, y: calY }, before, after,
                    cascadeDims.width || dims.width, cascadeDims.height || dims.height,
                );
                if (verdict.outcome === "success" || verdict.outcome === "modal_pop") {
                    if (!dimsAreFallback) {
                        try { recordClickSuccess(site, calX - dims.originX, calY - dims.originY, dims.width, dims.height); } catch { /* non-fatal */ }
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
                const forceSkip = order.slice(0, failedIdx + 1); // skip the failed tier and everything above it
                const prevXY = `${res.calX},${res.calY}`;
                const retry = await attempt(forceSkip);
                // Only accept the retry if it grounded to a DIFFERENT point.
                if (retry.target && `${retry.calX},${retry.calY}` !== prevXY) res = retry;
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
 */
export async function reportClickOutcome(
    site: { app: string; windowTitle: string; elementLabel: string },
    target: { x: number; y: number },
    before: Buffer | null,
    after: Buffer | null,
    imageWidth: number,
    imageHeight: number,
    opts?: { monitorId?: string; actual?: { x: number; y: number } },
): Promise<ReturnType<typeof classifyOutcome>> {
    const outcome = classifyOutcome(before, after, target.x, target.y, imageWidth, imageHeight);
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
