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

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        try {
            if (input.screenshot_base64) {
                tempPath = await base64ToTempFile(input.screenshot_base64 as string);
                screenshotPath = tempPath;
            } else {
                // Auto-capture when the agent didn't supply one. Without this the
                // cascade's vision tiers (OmniParser / UI-TARS / cloud_grounding)
                // were silently skipped — agents routinely call os_smart_click
                // without a screenshot, so AX-only would miss and the best
                // grounding tiers never ran. This is the main cause of low click
                // accuracy. Best-effort: on capture failure, fall back to AX-only.
                try {
                    const shot = await takeScreenshot();
                    tempPath = join(tmpdir(), `atlas_smartclick_${randomBytes(6).toString("hex")}.png`);
                    await fs.writeFile(tempPath, shot, { mode: 0o600 });
                    screenshotPath = tempPath;
                } catch (capErr) {
                    console.warn(`[smart-click] auto-screenshot failed (AX-only cascade): ${(capErr as Error).message}`);
                }
            }

            const skipTiers: CascadeTier[] = [];
            if (surface === "canvas") skipTiers.push("ax_exact", "ax_fuzzy");

            // Pass screenDims so OmniParser / UI-TARS image-pixel coords are scaled
            // to screen-absolute coords inside the cascade. Reuse the AX dump if we
            // already grabbed one for app/window detection.
            const target = await findClickTarget(instruction, {
                screenshotPath,
                skipTiers,
                screenDims: dims,
                axDumpHint,
                llm: _smartClickLLM ?? undefined,
            });
            if (!target) {
                return JSON.stringify({
                    success: false,
                    error: "cascade_miss",
                    instruction,
                    formatted: formatCascadeResult(null),
                    tip: "All grounding tiers (AX → OmniParser → UI-TARS/cloud-grounding) failed to locate the element. Call os_inspect to see the AX elements that ARE visible, or os_screenshot to reason about the layout directly before retrying.",
                });
            }

            // Step 2 — drift calibration (predicted vs actual click coord).
            const { x: calX, y: calY } = applyCalibration(dims.monitorId, target.x, target.y);

            // Step 3 — execute the click via the structured action surface.
            const clickResult = await dispatchClick(action, calX, calY);
            if (!clickResult.success) {
                return JSON.stringify({
                    success: false,
                    error: clickResult.error || "click_dispatch_failed",
                    target,
                    formatted: formatCascadeResult(target),
                });
            }

            // Step 4 — record success to click memory (only when dims are real;
            // recording against fallback 1440x900 dims would normalize against
            // fake numbers and poison every future recall).
            // NOTE: calibration sample is NOT recorded here — recordCalibrationSample
            // requires the *actual* landing point, which we only learn from outcome
            // classification (reportClickOutcome). Recording (predicted, calibrated)
            // is circular and locks the transform into its current state.
            if (!dimsAreFallback) {
                try {
                    recordClickSuccess(site, calX - dims.originX, calY - dims.originY, dims.width, dims.height);
                } catch {
                    /* memory persistence failed — non-fatal */
                }
            }

            return JSON.stringify({
                success: true,
                source: target.source,
                confidence: target.confidence,
                instruction,
                clicked: { x: calX, y: calY },
                target,
                formatted: formatCascadeResult(target),
                tip: `Cascade succeeded via ${target.source} (${target.totalMs}ms total). Recorded to click memory for next-time fast path.`,
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
